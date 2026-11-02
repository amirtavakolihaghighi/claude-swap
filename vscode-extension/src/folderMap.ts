/**
 * Pure logic for separate folder logins: which login a folder uses, the map file
 * the launcher reads, the state of a login folder, and the overview of open
 * windows. No `vscode` import and no I/O, so all of it runs under `node --test`.
 *
 * The path rules must stay identical to `FindLoginFolder` in
 * launcher/claude-swap-launcher.cs: case-insensitive, whole path segments, and the
 * nearest (longest) folder wins. If one side changes without the other, the
 * sidebar describes a login the launcher is not actually using.
 */

import { createHash } from 'crypto';
import * as path from 'path';

/** A folder whose Claude tabs use their own login instead of the main one. */
export interface FolderBinding {
  /** Absolute folder path. Its subfolders follow it. */
  folder: string;
  /** Login folder id under the data root's `logins/` (see `loginIdFor`). */
  loginId: string;
  /** The account it is meant to sign in as; absent for "whichever I sign in with". */
  account?: { email: string; organizationUuid?: string; number?: number };
  /** ISO time it was set up. */
  createdAt: string;
}

export interface BindingsFile {
  version: 1;
  bindings: FolderBinding[];
}

/** An absolute Windows path without trailing separators, for comparisons. */
export function normalizeFolder(p: string): string {
  return path.win32.resolve(p).replace(/[\\/]+$/, '');
}

/** Whether `candidate` is `folder` or inside it, by whole path segments. */
export function folderContains(folder: string, candidate: string): boolean {
  const a = normalizeFolder(folder).toLowerCase();
  const b = normalizeFolder(candidate).toLowerCase();
  return b === a || (b.startsWith(a) && (b[a.length] === '\\' || b[a.length] === '/'));
}

/** The binding the launcher would apply to a Claude started in `cwd`. */
export function bindingFor(cwd: string, bindings: FolderBinding[]): FolderBinding | undefined {
  let best: FolderBinding | undefined;
  let bestLength = -1;
  for (const binding of bindings) {
    const length = normalizeFolder(binding.folder).length;
    if (folderContains(binding.folder, cwd) && length > bestLength) {
      best = binding;
      bestLength = length;
    }
  }
  return best;
}

/**
 * The login folder id. One per ACCOUNT, so two folders set to the same account
 * share one sign-in. "Whichever I sign in with" gets one per folder. The id is a
 * hash, so the email does not appear in folder names.
 */
export function loginIdFor(
  account: { email: string; organizationUuid?: string } | undefined,
  folder: string
): string {
  const key = account
    ? `account|${account.email.toLowerCase()}|${account.organizationUuid ?? ''}`
    : `folder|${normalizeFolder(folder).toLowerCase()}`;
  return 'login-' + createHash('sha256').update(key).digest('hex').slice(0, 12);
}

/**
 * The text of folder-map.tsv, read by the launcher on every Claude start. Windows
 * forbids tabs and line breaks in paths, so the format needs no escaping; a path
 * that somehow holds one is left out rather than written as a corrupt line.
 */
export function launcherMap(
  bindings: FolderBinding[],
  loginFolderOf: (loginId: string) => string
): string {
  const lines = [
    '# Written by Claude Swap. One "<folder><TAB><login folder>" per line; the nearest folder wins.',
  ];
  for (const binding of bindings) {
    const folder = normalizeFolder(binding.folder);
    const login = loginFolderOf(binding.loginId);
    if (/[\t\r\n]/.test(folder + login)) {
      continue;
    }
    lines.push(`${folder}\t${login}`);
  }
  return lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// The state of one login folder
// ---------------------------------------------------------------------------

export interface LoginState {
  /** Claude has stored a login in this folder. */
  hasCredentials: boolean;
  email?: string;
  organizationUuid?: string;
  /** When the login itself lapses (`refreshTokenExpiresAt`), epoch ms. */
  expiresAt?: number;
}

/**
 * Read from a login folder's parsed `.claude.json` (who is signed in) and
 * `.credentials.json` (whether a login exists, and when it lapses). Only presence
 * and the expiry date are taken from the credentials, never a token's value.
 */
export function loginStateFrom(claudeJson: unknown, credentials: unknown): LoginState {
  const account = asRecord(asRecord(claudeJson)?.oauthAccount);
  const oauth = asRecord(asRecord(credentials)?.claudeAiOauth);
  const present = (v: unknown) => typeof v === 'string' && v.length > 0;
  const expiry = oauth?.refreshTokenExpiresAt;
  return {
    hasCredentials: Boolean(oauth && (present(oauth.refreshToken) || present(oauth.accessToken))),
    email: typeof account?.emailAddress === 'string' ? account.emailAddress : undefined,
    organizationUuid: typeof account?.organizationUuid === 'string' ? account.organizationUuid : undefined,
    expiresAt: typeof expiry === 'number' && expiry > 0 ? expiry : undefined,
  };
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

export type LoginVerdict =
  | { kind: 'not-signed-in' }
  | { kind: 'signed-in'; email?: string; daysLeft?: number }
  | { kind: 'wrong-account'; email: string; expected: string }
  | { kind: 'expired'; email?: string };

const DAY_MS = 86_400_000;

/** What a folder's own login amounts to right now. */
export function loginVerdict(binding: FolderBinding, state: LoginState, now: number): LoginVerdict {
  if (!state.hasCredentials) {
    return { kind: 'not-signed-in' };
  }
  if (state.expiresAt !== undefined && state.expiresAt <= now) {
    return { kind: 'expired', email: state.email };
  }
  const expected = binding.account;
  if (expected && state.email) {
    const sameEmail = state.email.toLowerCase() === expected.email.toLowerCase();
    const sameOrg =
      !expected.organizationUuid ||
      !state.organizationUuid ||
      expected.organizationUuid === state.organizationUuid;
    if (!sameEmail || !sameOrg) {
      return { kind: 'wrong-account', email: state.email, expected: expected.email };
    }
  }
  return {
    kind: 'signed-in',
    email: state.email,
    daysLeft: state.expiresAt !== undefined ? Math.floor((state.expiresAt - now) / DAY_MS) : undefined,
  };
}

/** One line for a verdict, as the sidebar shows it. */
export function describeVerdict(verdict: LoginVerdict, binding: FolderBinding): string {
  const target = binding.account?.email ?? 'the account you want here';
  switch (verdict.kind) {
    case 'not-signed-in':
      return `Not signed in yet: open a Claude tab in this folder and sign in as ${target}`;
    case 'expired':
      return 'Login expired: Claude in this folder will ask you to sign in again';
    case 'wrong-account':
      return `Signed in as ${verdict.email}, but set to ${verdict.expected}`;
    case 'signed-in': {
      const who = verdict.email ? `Signed in as ${verdict.email}` : 'Signed in';
      if (verdict.daysLeft === undefined) {
        return who;
      }
      return verdict.daysLeft < 1 ? `${who} · login ends today` : `${who} · login lasts ${verdict.daysLeft} more days`;
    }
  }
}

// ---------------------------------------------------------------------------
// Open windows
// ---------------------------------------------------------------------------

/** What each VS Code window writes about itself to `windows/<host pid>.json`. */
export interface WindowBeat {
  /** The window's extension host process (Claude tabs are started by it). */
  hostPid: number;
  name: string;
  folders: string[];
  focused: boolean;
  /** Epoch ms of the last write. */
  updatedAt: number;
}

/** What the launcher writes to `sessions/<launcher pid>.json` while Claude runs. */
export interface LauncherSession {
  launcherPid: number;
  /** The process that started the launcher: one window's extension host. */
  hostPid: number;
  claudePid: number;
  cwd: string;
  loginFolder: string | null;
  startedAt: string;
}

export interface WindowRow {
  beat: WindowBeat;
  isThisWindow: boolean;
  /** The binding of the window's first folder that has one. */
  binding?: FolderBinding;
  /** Claude processes this window started that are still running. */
  sessions: LauncherSession[];
}

/**
 * A heartbeat older than this, from a process that is gone, is a closed window. The
 * age alone is not enough (a window can sit idle while its extension host is busy),
 * and neither is the pid alone (Windows reuses them).
 */
export const WINDOW_BEAT_STALE_MS = 2 * 60_000;

/**
 * Every open window, this one first. A session is matched to a window by the pid
 * of the process that started it, and, failing that, by folder. The pid can be 0
 * when the launcher could not read its parent.
 */
export function windowRows(
  beats: WindowBeat[],
  sessions: LauncherSession[],
  bindings: FolderBinding[],
  thisHostPid: number,
  isAlive: (pid: number) => boolean,
  now: number
): WindowRow[] {
  const newest = new Map<number, WindowBeat>();
  for (const beat of beats) {
    const known = newest.get(beat.hostPid);
    if (!known || beat.updatedAt > known.updatedAt) {
      newest.set(beat.hostPid, beat);
    }
  }
  const live = [...newest.values()].filter(
    (b) => b.hostPid === thisHostPid || (isAlive(b.hostPid) && now - b.updatedAt < WINDOW_BEAT_STALE_MS)
  );
  const livePids = new Set(live.map((b) => b.hostPid));
  const running = sessions.filter((s) => isAlive(s.claudePid));

  const rows = live.map((beat): WindowRow => {
    const binding = beat.folders.map((f) => bindingFor(f, bindings)).find((b) => b !== undefined);
    const mine = running.filter(
      (s) =>
        s.hostPid === beat.hostPid ||
        (!livePids.has(s.hostPid) && beat.folders.some((f) => folderContains(f, s.cwd)))
    );
    return { beat, isThisWindow: beat.hostPid === thisHostPid, binding, sessions: mine };
  });
  return rows.sort(
    (a, b) => Number(b.isThisWindow) - Number(a.isThisWindow) || a.beat.name.localeCompare(b.beat.name)
  );
}

/** Whether a session record's process is gone, so its file can be removed. */
export function isDeadSession(session: LauncherSession, isAlive: (pid: number) => boolean): boolean {
  return !isAlive(session.claudePid) && !isAlive(session.launcherPid);
}
