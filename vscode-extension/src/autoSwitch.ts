/**
 * Background auto-switch: move off an account before it hits its limit, with no
 * terminal window open.
 *
 * This runs `cswap auto --once`, which exists precisely for scheduled one-shot
 * invocation (cron, systemd timers — and now this). It is *not* a reimplementation
 * of the policy: threshold, cooldown, hysteresis, strategy, quarantine and the
 * usage-API rate budget all stay in claude-swap, which persists its own state
 * between runs. So a tick here is stateless and safe to miss.
 *
 * Deliberately no flags are passed. The engine reads claude-swap's own
 * `autoswitch.*` settings, which keeps one source of truth shared with
 * `cswap auto` in a terminal and the macOS menu bar app.
 */

import * as vscode from 'vscode';
import * as cswap from './cswap';
import { LeaderLease } from './leader';
import { log, logError } from './log';
import { AutoEvent, AutoOnceCode } from './types';

/** Kinds worth telling the user about, beyond a completed switch. */
const NOTABLE_EVENTS = new Set([
  'account-quarantined',
  'all-exhausted',
  'config-warning',
  'error',
]);

export class AutoSwitcher {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly onSwitched: () => void,
    /**
     * Only the window holding the lease ticks. Without it, N open windows spawn N
     * `cswap auto --once` processes on the same schedule — see `shouldClaimLease`.
     */
    private readonly lease: LeaderLease
  ) {}

  dispose(): void {
    this.stop();
    this.lease.release();
  }

  get enabled(): boolean {
    return (
      vscode.workspace.getConfiguration('claudeSwap').get<boolean>('autoSwitch.enabled') ?? false
    );
  }

  /** Start or stop to match the current setting. Safe to call repeatedly. */
  sync(): void {
    if (this.enabled) {
      this.start();
    } else {
      this.stop();
    }
  }

  private start(): void {
    const seconds = Math.max(
      30,
      vscode.workspace.getConfiguration('claudeSwap').get<number>('autoSwitch.intervalSeconds') ?? 60
    );
    this.stop();
    log(`auto-switch: enabled, checking every ${seconds}s`);
    this.timer = setInterval(() => void this.tick(), seconds * 1000);
    // Check once promptly, so enabling it has a visible effect.
    void this.tick();
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      log('auto-switch: disabled');
      this.lease.release();
    }
  }

  /** One check. Overlapping ticks are skipped rather than queued. */
  async tick(): Promise<void> {
    if (this.running) {
      log('auto-switch: previous check still running, skipping this tick');
      return;
    }
    // Another window owns the timer. Standing down is not a failure: that window
    // is switching for the whole machine, and the account is shared.
    if (!this.lease.acquire()) {
      return;
    }
    this.running = true;
    try {
      const { code, events } = await cswap.autoOnce();
      this.report(code, events);
      if (code === AutoOnceCode.Switched) {
        this.onSwitched();
      }
    } catch (err) {
      logError('auto-switch tick', err);
    } finally {
      this.running = false;
    }
  }

  private report(code: AutoOnceCode, events: AutoEvent[]): void {
    const notify =
      vscode.workspace.getConfiguration('claudeSwap').get<boolean>('autoSwitch.notify') ?? true;

    for (const event of events) {
      if (event.event === 'poll') {
        continue; // Routine; the log has it if needed.
      }
      log(`auto-switch event: ${JSON.stringify(event)}`);
    }

    const switched = events.find((e) => e.event === 'switch');
    if (switched && notify) {
      const to = switched.to;
      const label = to ? `#${to.number} (${to.email})` : 'another account';
      void vscode.window
        .showInformationMessage(
          `Claude Swap switched you to account ${label} before you hit the limit.`,
          'Reload window to apply now',
          'OK'
        )
        .then((choice) => {
          if (choice === 'Reload window to apply now') {
            void vscode.commands.executeCommand('workbench.action.reloadWindow');
          }
        });
      return;
    }

    if (code === AutoOnceCode.Blocked) {
      const detail = events.find((e) => e.event === 'all-exhausted');
      if (notify) {
        void vscode.window.showWarningMessage(
          'Claude Swap wanted to switch accounts but no account has quota left. ' +
            (detail?.detail ?? 'Waiting for the next reset.')
        );
      }
      return;
    }

    if (notify) {
      for (const event of events) {
        if (!NOTABLE_EVENTS.has(event.event)) {
          continue;
        }
        const message = event.message ?? event.detail ?? event.reason ?? event.event;
        if (event.event === 'error') {
          void vscode.window.showWarningMessage(`Claude Swap auto-switch: ${message}`);
        } else {
          void vscode.window.showInformationMessage(`Claude Swap: ${message}`);
        }
      }
    }
  }
}
