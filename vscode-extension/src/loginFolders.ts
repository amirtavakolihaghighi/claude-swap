/**
 * File work for separate folder logins: create a login folder that shares the
 * right parts of the main Claude setup, keep it in step, read its state, and
 * remove it without ever touching what it links to. Also the small record files
 * through which windows see each other. Node-only (no `vscode` import), so the
 * tests run it against real folders and junctions.
 *
 * What a login folder shares with the main setup (~/.claude), and how:
 *
 *  - projects/ and file-history/ are linked (a directory junction, which needs no
 *    admin rights or Developer Mode). So conversations, Claude's notes about a
 *    project and its rewind checkpoints are the same in every window, whichever
 *    login each window uses.
 *  - commands/, agents/, rules/ and each folder in skills/ are linked when they
 *    exist, EXCEPT skills/synced: claude.ai syncs that one per account, and sharing
 *    it would let one account's sync overwrite the other's. Same for plugins/,
 *    which is not shared at all (cswap's session mode excludes it for the same
 *    reason).
 *  - settings.json, keybindings.json and CLAUDE.md are copied, because files cannot
 *    be junctioned. A copy is refreshed only when the MAIN file changes, so a
 *    setting changed inside the folder survives until the main one changes.
 *  - user-level MCP servers (`mcpServers` in ~/.claude.json) are mirrored into the
 *    login folder's own .claude.json, but only while no Claude runs on that login,
 *    because Claude rewrites that file itself.
 *  - The login (.credentials.json), account details and everything else are the
 *    folder's own.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LauncherSession, LoginState, WindowBeat, loginStateFrom, WINDOW_BEAT_STALE_MS } from './folderMap';
import { writeAtomic } from './launcher';

/** Directories shared live through a junction. */
export const LINKED_DIRS = ['projects', 'file-history', 'commands', 'agents', 'rules'];
/** Created in the main home when missing, so the link has a target from day one. */
const ALWAYS_LINKED = new Set(['projects', 'file-history']);
/** Copied, refreshed when the main file changes. */
export const COPIED_FILES = ['settings.json', 'keybindings.json', 'CLAUDE.md'];
/** The skills/ entry claude.ai syncs per account: never shared. */
const ACCOUNT_SYNCED = 'synced';
/** What Claude Swap made in a login folder, so removal touches only that. */
const MANIFEST = '.claude-swap.json';

interface Manifest {
  version: 1;
  /** File name → hash of the main file's content when it was last copied. */
  copied: Record<string, string>;
  mcpMirrored?: boolean;
}

/** The main Claude home, as Claude Code itself decides it. */
export function mainClaudeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** The main login's global config file (where user-level MCP servers live). */
export function mainClaudeConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR
    ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json')
    : path.join(os.homedir(), '.claude.json');
}

type Log = (message: string) => void;

/** Create or refresh a login folder's shared parts. Safe to call repeatedly. */
export function ensureLoginFolder(loginDir: string, mainHome: string, log: Log): void {
  fs.mkdirSync(loginDir, { recursive: true });
  const manifest = readManifest(loginDir);

  for (const name of LINKED_DIRS) {
    const target = path.join(mainHome, name);
    if (!fs.existsSync(target)) {
      if (!ALWAYS_LINKED.has(name)) {
        continue;
      }
      fs.mkdirSync(target, { recursive: true });
    }
    ensureJunction(path.join(loginDir, name), target, log);
  }

  const mainSkills = path.join(mainHome, 'skills');
  if (isDirectory(mainSkills)) {
    for (const entry of fs.readdirSync(mainSkills, { withFileTypes: true })) {
      if (entry.name === ACCOUNT_SYNCED || !entry.isDirectory()) {
        continue;
      }
      ensureJunction(path.join(loginDir, 'skills', entry.name), path.join(mainSkills, entry.name), log);
    }
  }

  for (const name of COPIED_FILES) {
    const from = path.join(mainHome, name);
    const to = path.join(loginDir, name);
    let content: Buffer | undefined;
    try {
      content = fs.readFileSync(from);
    } catch {
      content = undefined;
    }
    if (content === undefined) {
      if (manifest.copied[name] !== undefined && fs.existsSync(to)) {
        fs.unlinkSync(to);
      }
      delete manifest.copied[name];
      continue;
    }
    const hash = createHash('sha256').update(content).digest('hex');
    if (manifest.copied[name] !== hash || !fs.existsSync(to)) {
      writeAtomic(to, content);
      manifest.copied[name] = hash;
    }
  }
  writeAtomic(path.join(loginDir, MANIFEST), JSON.stringify(manifest, null, 2));
}

/**
 * Mirror the main login's user-level MCP servers into a login folder. The CALLER
 * must have checked that no Claude runs on this login: Claude rewrites its
 * .claude.json itself, and two writers lose each other's changes.
 *
 * A .claude.json that exists but does not parse is left alone. It could be
 * mid-write, and replacing it would drop who is signed in there.
 */
export function mirrorMcpServers(loginDir: string, mainConfigFile: string): 'updated' | 'unchanged' | 'skipped' {
  const main = readJsonFile(mainConfigFile);
  if (main.state === 'unreadable') {
    return 'skipped';
  }
  const file = path.join(loginDir, '.claude.json');
  const current = readJsonFile(file);
  if (current.state === 'unreadable') {
    return 'skipped';
  }
  const config = (current.state === 'ok' ? current.value : {}) as Record<string, unknown>;
  const servers = main.state === 'ok' ? (main.value as Record<string, unknown>).mcpServers : undefined;
  const manifest = readManifest(loginDir);

  if (servers && typeof servers === 'object') {
    if (JSON.stringify(config.mcpServers) === JSON.stringify(servers)) {
      return 'unchanged';
    }
    config.mcpServers = servers;
    manifest.mcpMirrored = true;
  } else if (manifest.mcpMirrored && config.mcpServers !== undefined) {
    delete config.mcpServers;
    manifest.mcpMirrored = false;
  } else {
    return 'unchanged';
  }
  writeAtomic(file, JSON.stringify(config, null, 2));
  writeAtomic(path.join(loginDir, MANIFEST), JSON.stringify(manifest, null, 2));
  return 'updated';
}

/** Who is signed in to a login folder, and until when. */
export function readLoginState(loginDir: string): LoginState {
  const config = readJsonFile(path.join(loginDir, '.claude.json'));
  const creds = readJsonFile(path.join(loginDir, '.credentials.json'));
  return loginStateFrom(
    config.state === 'ok' ? config.value : undefined,
    creds.state === 'ok' ? creds.value : undefined
  );
}

/**
 * Delete a folder tree WITHOUT following links. A login folder links to the main
 * conversation history; following one would delete the real thing.
 *
 * Two independent guards: an entry lstat reports as a link is removed as a link,
 * and so is a directory whose real location is not "its parent's real location
 * plus its name". The second guard does not depend on how Node reports junctions,
 * and comparing against the PARENT's real path keeps it correct when an ancestor
 * of the whole tree is itself redirected.
 */
export function removeTree(target: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(target);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) {
    removeLinkOnly(target);
    return;
  }
  if (!st.isDirectory()) {
    fs.unlinkSync(target);
    return;
  }
  removeContents(target, fs.realpathSync.native(target));
  fs.rmdirSync(target);
}

function removeContents(dir: string, realDir: string): void {
  for (const name of fs.readdirSync(dir)) {
    const entry = path.join(dir, name);
    const st = fs.lstatSync(entry);
    if (st.isSymbolicLink()) {
      removeLinkOnly(entry);
      continue;
    }
    if (st.isDirectory()) {
      const real = fs.realpathSync.native(entry);
      if (!samePath(real, path.join(realDir, name))) {
        removeLinkOnly(entry); // a link that lstat did not flag: never descend into it
        continue;
      }
      removeContents(entry, real);
      fs.rmdirSync(entry);
      continue;
    }
    fs.unlinkSync(entry);
  }
}

function removeLinkOnly(link: string): void {
  try {
    fs.unlinkSync(link);
  } catch {
    fs.rmdirSync(link); // a directory junction refuses unlink on some Windows builds
  }
}

function ensureJunction(link: string, target: string, log: Log): void {
  let st: fs.Stats | undefined;
  try {
    st = fs.lstatSync(link);
  } catch {
    st = undefined;
  }
  if (st) {
    if (st.isSymbolicLink()) {
      let current: string | undefined;
      try {
        current = fs.readlinkSync(link);
      } catch {
        current = undefined;
      }
      if (current && samePath(current, target)) {
        return;
      }
      removeLinkOnly(link);
    } else if (st.isDirectory()) {
      if (fs.readdirSync(link).length > 0) {
        log(`${link} already holds its own files, so it is left unshared`);
        return;
      }
      fs.rmdirSync(link);
    } else {
      log(`${link} is a file, so it is left unshared`);
      return;
    }
  }
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link, 'junction');
}

function samePath(a: string, b: string): boolean {
  const clean = (p: string) => path.win32.resolve(p.replace(/^\\\\\?\\/, '')).replace(/[\\/]+$/, '').toLowerCase();
  return clean(a) === clean(b);
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readManifest(loginDir: string): Manifest {
  const parsed = readJsonFile(path.join(loginDir, MANIFEST));
  const value = parsed.state === 'ok' ? (parsed.value as Partial<Manifest>) : {};
  return { version: 1, copied: { ...(value.copied ?? {}) }, mcpMirrored: value.mcpMirrored };
}

type JsonRead = { state: 'missing' } | { state: 'unreadable' } | { state: 'ok'; value: unknown };

/** Missing and unreadable are different answers: only "missing" is safe to create. */
export function readJsonFile(file: string): JsonRead {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'missing' } : { state: 'unreadable' };
  }
  try {
    const value: unknown = JSON.parse(text.replace(/^﻿/, ''));
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? { state: 'ok', value }
      : { state: 'unreadable' };
  } catch {
    return { state: 'unreadable' };
  }
}

// ---------------------------------------------------------------------------
// Records through which windows see each other
// ---------------------------------------------------------------------------

/** Whether a process exists. EPERM means it exists but is not ours to signal. */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Running Claude sessions the launcher recorded. Records of finished ones are deleted. */
export function readSessions(dir: string, alive: (pid: number) => boolean = isAlive): LauncherSession[] {
  const out: LauncherSession[] = [];
  for (const { file, value } of readRecords(dir)) {
    const s = value as Partial<LauncherSession>;
    if (typeof s.claudePid !== 'number' || typeof s.launcherPid !== 'number' || typeof s.cwd !== 'string') {
      continue;
    }
    const session: LauncherSession = {
      launcherPid: s.launcherPid,
      hostPid: typeof s.hostPid === 'number' ? s.hostPid : 0,
      claudePid: s.claudePid,
      cwd: s.cwd,
      loginFolder: typeof s.loginFolder === 'string' ? s.loginFolder : null,
      startedAt: typeof s.startedAt === 'string' ? s.startedAt : '',
    };
    if (!alive(session.claudePid) && !alive(session.launcherPid)) {
      tryUnlink(file); // the launcher was killed before it could tidy up
      continue;
    }
    out.push(session);
  }
  return out;
}

/** Every window's latest heartbeat. Ones from long-closed windows are deleted. */
export function readBeats(dir: string, alive: (pid: number) => boolean = isAlive, now = Date.now()): WindowBeat[] {
  const out: WindowBeat[] = [];
  for (const { file, value } of readRecords(dir)) {
    const b = value as Partial<WindowBeat>;
    if (typeof b.hostPid !== 'number' || typeof b.updatedAt !== 'number') {
      continue;
    }
    if (!alive(b.hostPid) && now - b.updatedAt > WINDOW_BEAT_STALE_MS) {
      tryUnlink(file);
      continue;
    }
    out.push({
      hostPid: b.hostPid,
      name: typeof b.name === 'string' ? b.name : '(window)',
      folders: Array.isArray(b.folders) ? b.folders.filter((f): f is string => typeof f === 'string') : [],
      focused: Boolean(b.focused),
      updatedAt: b.updatedAt,
    });
  }
  return out;
}

export function writeBeat(dir: string, beat: WindowBeat): void {
  writeAtomic(path.join(dir, `${beat.hostPid}.json`), JSON.stringify(beat));
}

export function deleteBeat(dir: string, hostPid: number): void {
  tryUnlink(path.join(dir, `${hostPid}.json`));
}

function readRecords(dir: string): { file: string; value: unknown }[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: { file: string; value: unknown }[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) {
      continue;
    }
    const file = path.join(dir, name);
    const read = readJsonFile(file);
    if (read.state === 'ok') {
      out.push({ file, value: read.value });
    }
  }
  return out;
}

function tryUnlink(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // Already gone, or held open for a moment by another window.
  }
}
