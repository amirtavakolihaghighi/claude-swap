/**
 * The bridge to the `cswap` CLI.
 *
 * Every piece of account logic stays in claude-swap itself; this extension only
 * runs its documented `--json` commands and renders the result. That is a
 * deliberate boundary — credential handling, token refresh, lock cooperation and
 * the usage-API rate budget are all subtle enough that duplicating any of it here
 * would be a bug waiting to happen.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { log } from './log';
import {
  AutoEvent,
  AutoOnceCode,
  ErrorPayload,
  ListPayload,
  StatusPayload,
  SwitchPayload,
} from './types';

/** Thrown when `cswap` itself cannot be located. Callers offer a fix for this. */
export class CswapNotFoundError extends Error {
  constructor(searched: string[]) {
    super(
      'Could not find the cswap executable. Set "claudeSwap.executablePath" to its full path.'
    );
    this.searched = searched;
  }
  readonly searched: string[];
}

/** Thrown when cswap ran but reported a handled failure. */
export class CswapError extends Error {
  constructor(message: string, readonly code: number, readonly type?: string) {
    super(message);
  }
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

let cachedPath: string | undefined;

/** Clear the memoized executable location (called when the setting changes). */
export function resetExecutableCache(): void {
  cachedPath = undefined;
}

function configuredPath(): string {
  return (vscode.workspace.getConfiguration('claudeSwap').get<string>('executablePath') ?? '').trim();
}

function candidatePaths(): string[] {
  const home = os.homedir();
  const out: string[] = [];

  // A workspace holding the claude-swap source itself (the development case):
  // its virtualenv has a working cswap even when nothing is installed globally.
  //
  // GATED ON WORKSPACE TRUST, and it must stay that way. This path is *inside the
  // opened folder*, so without the gate, opening any untrusted repository that
  // happened to contain `.venv/Scripts/cswap.exe` would have this extension
  // execute that file. Trust is the difference between a convenience and an
  // arbitrary-code-execution path.
  if (vscode.workspace.isTrusted) {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const base = folder.uri.fsPath;
      out.push(path.join(base, '.venv', 'Scripts', 'cswap.exe'));
      out.push(path.join(base, '.venv', 'bin', 'cswap'));
    }
  }

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    out.push(
      path.join(home, '.local', 'bin', 'cswap.exe'),
      path.join(localAppData, 'uv', 'tools', 'claude-swap', 'Scripts', 'cswap.exe'),
      path.join(localAppData, 'pipx', 'venvs', 'claude-swap', 'Scripts', 'cswap.exe'),
      path.join(home, 'pipx', 'venvs', 'claude-swap', 'Scripts', 'cswap.exe'),
      path.join(appData, 'Python', 'Scripts', 'cswap.exe')
    );
  } else {
    out.push(
      path.join(home, '.local', 'bin', 'cswap'),
      path.join(home, '.local', 'share', 'uv', 'tools', 'claude-swap', 'bin', 'cswap'),
      '/opt/homebrew/bin/cswap',
      '/usr/local/bin/cswap',
      '/usr/bin/cswap'
    );
  }
  return out;
}

function whichCswap(): string | undefined {
  // Resolve through the shell's own lookup first, so a PATH install wins over
  // any guessed location. Done once and cached; `execFile` afterwards always
  // gets an absolute path, so no command ever goes through a shell.
  const finder = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    const { execFileSync } = require('child_process') as typeof import('child_process');
    const out = execFileSync(finder, ['cswap'], { encoding: 'utf8', timeout: 5000 });
    const first = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
    if (first && fs.existsSync(first)) {
      return first;
    }
  } catch {
    // Not on PATH — fall through to the candidate list.
  }
  return undefined;
}

/** Locate cswap, preferring the user's setting. Memoized. */
export function resolveExecutable(): string {
  if (cachedPath) {
    return cachedPath;
  }

  const configured = configuredPath();
  if (configured) {
    if (!fs.existsSync(configured)) {
      throw new CswapNotFoundError([configured]);
    }
    log(`Using configured cswap: ${configured}`);
    cachedPath = configured;
    return cachedPath;
  }

  const onPath = whichCswap();
  if (onPath) {
    log(`Found cswap on PATH: ${onPath}`);
    cachedPath = onPath;
    return cachedPath;
  }

  const candidates = candidatePaths();
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      log(`Found cswap at: ${candidate}`);
      cachedPath = candidate;
      return cachedPath;
    }
  }

  throw new CswapNotFoundError(['(PATH)', ...candidates]);
}

/**
 * Run cswap and return its exit code and output without throwing on a non-zero
 * exit. `cswap auto --once` uses its exit code as a *result* (2 = nothing to do),
 * so a non-zero exit is not automatically an error here.
 */
function exec(args: string[], timeoutMs: number): Promise<ExecResult> {
  const bin = resolveExecutable();
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, encoding: 'utf8', windowsHide: true },
      (err, stdout, stderr) => {
        if (err && typeof (err as NodeJS.ErrnoException).code === 'string') {
          // A spawn-level failure (ENOENT, EACCES) rather than a non-zero exit.
          reject(err);
          return;
        }
        const code = err && typeof err.code === 'number' ? err.code : 0;
        resolve({ code, stdout, stderr });
      }
    );
  });
}

/** Run a command expected to print exactly one JSON object on stdout. */
async function json<T>(args: string[], timeoutMs = 30_000): Promise<T> {
  const full = [...args, '--json'];
  log(`run: cswap ${full.join(' ')}`);
  const { code, stdout, stderr } = await exec(full, timeoutMs);

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    const detail = stderr.trim() || stdout.trim() || `exit code ${code}`;
    throw new CswapError(`cswap produced unreadable output: ${detail}`, code);
  }

  const maybeError = parsed as ErrorPayload;
  if (maybeError && typeof maybeError === 'object' && maybeError.error) {
    throw new CswapError(maybeError.error.message, code, maybeError.error.type);
  }
  if (code !== 0) {
    throw new CswapError(stderr.trim() || `cswap exited with code ${code}`, code);
  }
  return parsed as T;
}

export function list(): Promise<ListPayload> {
  return json<ListPayload>(['list']);
}

export function status(): Promise<StatusPayload> {
  return json<StatusPayload>(['status']);
}

/** Switch to a specific account by slot number, email, or alias. */
export function switchTo(target: string): Promise<SwitchPayload> {
  return json<SwitchPayload>(['switch', target], 90_000);
}

/** Switch to whichever eligible account has the most quota left. */
export function switchBest(): Promise<SwitchPayload> {
  return json<SwitchPayload>(['switch', '--strategy', 'best'], 90_000);
}

export interface AutoOnceResult {
  code: AutoOnceCode;
  events: AutoEvent[];
}

/**
 * One auto-switch check. `cswap auto --once` is purpose-built for scheduled
 * single-shot runs: it reports the outcome in its exit code and emits one JSON
 * event per line. The threshold, cooldown and strategy come from claude-swap's
 * own settings, so this extension deliberately passes no policy flags — there is
 * one source of truth for them, editable with `cswap config set`.
 */
export async function autoOnce(): Promise<AutoOnceResult> {
  log('run: cswap auto --once --json');
  const { code, stdout, stderr } = await exec(['auto', '--once', '--json'], 120_000);
  const events: AutoEvent[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      events.push(JSON.parse(trimmed) as AutoEvent);
    } catch {
      log(`auto: skipped unparseable line: ${trimmed.slice(0, 200)}`);
    }
  }
  if (stderr.trim()) {
    log(`auto stderr: ${stderr.trim()}`);
  }
  return { code: code as AutoOnceCode, events };
}

/** Bind a directory to an account, so `cswap run` there picks it automatically. */
export async function mapDirectory(target: string, directory: string): Promise<string> {
  log(`run: cswap map ${target} ${directory}`);
  const { code, stdout, stderr } = await exec(['map', target, directory], 30_000);
  if (code !== 0) {
    throw new CswapError(stderr.trim() || stdout.trim() || `cswap exited with code ${code}`, code);
  }
  return (stdout.trim() || stderr.trim()).replace(/\s+/g, ' ');
}

/** The configured auto-switch threshold, for display. Best-effort. */
export async function autoSwitchThreshold(): Promise<number | undefined> {
  try {
    const { code, stdout } = await exec(
      ['config', 'get', 'autoswitch.threshold', '--json'],
      15_000
    );
    if (code !== 0) {
      return undefined;
    }
    const parsed = JSON.parse(stdout.trim()) as { value?: unknown };
    const value = Number(parsed?.value);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
