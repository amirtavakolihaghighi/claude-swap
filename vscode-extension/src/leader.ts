/**
 * Elects one VS Code window to run the background auto-switch timer.
 *
 * Every open window loads its own copy of this extension, so without a leader N
 * windows spawn N `cswap auto --once` processes on the same schedule. claude-swap
 * serialises them correctly for the common case — its under-lock cooldown re-check
 * makes the loser back off, and FileLock was measured to exclude across processes on
 * Windows (5 processes, strictly serialised, 2026-09-24) — but `at-limit` and
 * `failover` deliberately bypass that cooldown, because an account already at its
 * limit must move regardless of how recently anything moved. Two windows ranking
 * candidates differently could then each switch once: not a ping-pong (the no-return
 * filter blocks the return leg) but a wasted hop and an extra prompt-cache rebuild.
 *
 * Electing a leader removes the class instead of re-implementing the cooldown here,
 * which would duplicate policy that must live in one place.
 *
 * The lease is a file in global storage, shared by every window on the machine —
 * unlike `globalState`, whose cross-window writes are not immediately visible and
 * offer no atomicity.
 *
 * **The mutex is the file's EXISTENCE via `openSync(..., 'wx')`, and staleness comes
 * from its mtime — never from its contents.** See `leaseVerdict` for the measured
 * failure that forced this: reading staleness from the JSON body elected 3 leaders
 * out of 8 racing processes, because the body is briefly empty between creation and
 * the write, and "empty" was being read as "abandoned".
 *
 * Every failure path answers "am I leader?" rather than throwing. Storage that cannot
 * be written falls back to running the timer: one window ticking is the pre-existing
 * behaviour, whereas zero windows ticking would silently disable a feature the user
 * switched on.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Lease, LeaseState, leaseVerdict } from './analysis';
import { log } from './log';

const LEASE_FILE = 'autoswitch-leader.json';

export class LeaderLease {
  private readonly file: string | undefined;
  private held = false;

  constructor(context: vscode.ExtensionContext) {
    try {
      const dir = context.globalStorageUri.fsPath;
      fs.mkdirSync(dir, { recursive: true });
      this.file = path.join(dir, LEASE_FILE);
    } catch (err) {
      log(
        `leader: no usable storage (${err instanceof Error ? err.message : String(err)}); ` +
          'this window will run the timer'
      );
      this.file = undefined;
    }
  }

  /** Existence and age from the filesystem; holder pid from contents, best-effort. */
  private inspect(now: number): LeaseState {
    if (!this.file) {
      return { exists: false };
    }
    let ageMs: number | undefined;
    try {
      ageMs = now - fs.statSync(this.file).mtimeMs;
    } catch {
      return { exists: false };
    }
    let holderPid: number | undefined;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Lease;
      if (typeof parsed?.pid === 'number') {
        holderPid = parsed.pid;
      }
    } catch {
      // Empty or corrupt. Deliberately NOT treated as abandoned — age decides.
    }
    return { exists: true, ageMs, holderPid };
  }

  private stamp(now: number): void {
    if (!this.file) {
      return;
    }
    const lease: Lease = { pid: process.pid, ts: now };
    fs.writeFileSync(this.file, JSON.stringify(lease), 'utf8');
  }

  /** Create the lease atomically. Returns false if another process got there first. */
  private create(now: number): boolean {
    if (!this.file) {
      return false;
    }
    let fd: number;
    try {
      fd = fs.openSync(this.file, 'wx'); // atomic create-or-fail
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        return false;
      }
      throw err;
    }
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: now } as Lease), {
        encoding: 'utf8',
      });
    } finally {
      fs.closeSync(fd);
    }
    return true;
  }

  /** Become, or remain, the window that runs the timer. Called before each tick. */
  acquire(now = Date.now()): boolean {
    if (!this.file) {
      return true; // no storage: run rather than never run
    }

    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const verdict = leaseVerdict(this.inspect(now), process.pid);

        if (verdict === 'stand-down') {
          if (this.held) {
            log('leader: stood down; another window now runs the auto-switch timer');
            this.held = false;
          }
          return false;
        }

        if (verdict === 'refresh') {
          try {
            this.stamp(now);
          } catch {
            // Keeping the timer matters more than the timestamp; a failed refresh
            // only risks another window taking over later.
          }
          this.held = true;
          return true;
        }

        if (verdict === 'take-over') {
          log('leader: taking over an abandoned lease');
          try {
            fs.unlinkSync(this.file);
          } catch {
            // Another window beat us to it; the retry sees its lease.
          }
          continue; // retry the atomic create
        }

        // 'claim'
        if (this.create(now)) {
          if (!this.held) {
            log(`leader: this window (pid ${process.pid}) now runs the auto-switch timer`);
          }
          this.held = true;
          return true;
        }
        // Lost the create race; loop once to read the winner's lease.
      }
    } catch (err) {
      log(
        `leader: lease check failed (${err instanceof Error ? err.message : String(err)}); ` +
          'running the timer anyway'
      );
      return true;
    }

    this.held = false;
    return false;
  }

  /** Give up the lease if we hold it, so another window can take over promptly. */
  release(): void {
    if (!this.file || !this.held) {
      return;
    }
    try {
      const state = this.inspect(Date.now());
      if (state.holderPid === process.pid) {
        fs.unlinkSync(this.file);
        log('leader: released the timer');
      }
    } catch {
      // A stale lease ages out on its own; nothing here is worth reporting.
    }
    this.held = false;
  }
}
