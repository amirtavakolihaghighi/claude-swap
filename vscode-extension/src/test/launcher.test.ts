/**
 * Builds the real launcher with Windows' own C# compiler and drives it the way
 * Anthropic's extension does: shell:false, windowsHide, piped stdio, with the
 * program to start as the first argument. A node script stands in for claude.exe
 * and reports what it received. Windows only, and skipped where the .NET Framework
 * compiler is missing.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';

import { findCsc, installLauncher } from '../launcher';

const skip =
  process.platform !== 'win32'
    ? 'the launcher is Windows-only'
    : findCsc() === undefined
      ? "this Windows has no .NET Framework C# compiler"
      : false;

// out/test/launcher.test.js → ../../launcher/claude-swap-launcher.cs
const SOURCE = path.join(__dirname, '..', '..', 'launcher', 'claude-swap-launcher.cs');

const CHILD = `
const { spawn } = require('child_process');
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const out = { argv: process.argv.slice(2), configDir: process.env.CLAUDE_CONFIG_DIR ?? null, input };
  if (process.argv.includes('--start-background-program')) {
    const s = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], { detached: true, stdio: 'ignore', windowsHide: true });
    out.backgroundPid = s.pid; s.unref();
  }
  process.stdout.write(JSON.stringify(out));
  const code = process.argv.find((a) => a.startsWith('--exit='));
  process.exit(code ? Number(code.slice(7)) : 0);
});
if (process.argv.includes('--wait')) { process.stdin.resume(); }
`;

interface Run {
  code: number | null;
  out: Record<string, unknown>;
  exitedAt: number;
  closedAt: number;
}

describe('claude-swap-launcher', { skip }, () => {
  let root: string;
  let exe: string;
  let child: string;
  let project: string;
  let login: string;

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cswap-launcher-'));
    ({ exe } = await installLauncher(SOURCE, root));
    child = path.join(root, 'child.js');
    fs.writeFileSync(child, CHILD);
    project = path.join(root, 'Work Folder', 'project B');
    login = path.join(root, 'logins', 'login-test');
    fs.mkdirSync(path.join(project, 'src'), { recursive: true });
    fs.mkdirSync(login, { recursive: true });
  });

  function map(text: string | undefined): void {
    const file = path.join(root, 'folder-map.tsv');
    if (text === undefined) {
      fs.rmSync(file, { force: true });
    } else {
      fs.writeFileSync(file, text);
    }
  }

  function run(args: string[], cwd: string, input = 'hello\n'): Promise<Run> {
    return new Promise((resolve) => {
      const env = { ...process.env };
      delete env.CLAUDE_CONFIG_DIR;
      const p = spawn(exe, [process.execPath, child, ...args], { cwd, env, shell: false, windowsHide: true });
      let out = '';
      let exitedAt = 0;
      p.stdout.on('data', (d) => (out += d));
      p.stdin.end(input);
      p.on('exit', () => (exitedAt = Date.now()));
      p.on('close', (code) => {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(out);
        } catch {
          // left empty; the assertion names what was missing
        }
        resolve({ code, out: parsed, exitedAt, closedAt: Date.now() });
      });
    });
  }

  it('changes nothing for a folder without its own login, and passes arguments byte for byte', async () => {
    map(undefined);
    const tricky = ['--mcp-config', '{"mcpServers":{"b":{"command":"C:\\\\Program Files\\\\x.exe","args":["a b","\\"q\\""]}}}', 'trailing\\', '', 'two  spaces', '--exit=7'];
    const r = await run(tricky, project);
    assert.equal(r.out.configDir, null);
    assert.deepEqual(r.out.argv, tricky);
    assert.equal(r.out.input, 'hello\n');
    assert.equal(r.code, 7);
  });

  it('gives a folder and its subfolders the folder\'s own login, nearest folder winning', async () => {
    map(`# test\r\n${path.join(root, 'Work Folder')}\t${path.join(root, 'logins', 'outer')}\r\n${project.toUpperCase()}\t${login}\r\n`);
    const r = await run([], path.join(project, 'src'));
    assert.equal(r.out.configDir, login);
  });

  it('falls back to the main login when the login folder is missing or the map is garbage', async () => {
    map(`${project}\t${path.join(root, 'logins', 'gone')}\r\n`);
    assert.equal((await run([], project)).out.configDir, null);
    fs.writeFileSync(path.join(root, 'folder-map.tsv'), Buffer.from([0xff, 0xfe, 0x00, 0x09, 0x41]));
    const r = await run([], project);
    assert.equal(r.out.configDir, null);
    assert.equal(r.code, 0);
  });

  it('records the running session, naming the process that started it, and removes the record after', async () => {
    map(`${project}\t${login}\r\n`);
    const p = spawn(exe, [process.execPath, child, '--wait'], { cwd: project, shell: false, windowsHide: true });
    await new Promise((r) => setTimeout(r, 1500));
    const file = path.join(root, 'sessions', `${p.pid}.json`);
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(record.hostPid, process.pid);
    assert.equal(record.loginFolder, login);
    p.stdin.end('x');
    await new Promise((r) => p.on('close', r));
    assert.equal(fs.existsSync(file), false);
  });

  it('ends the session on time even when Claude started a background program', async () => {
    // Regression, measured 2026-11-02: inheriting every inheritable handle leaked
    // the output pipe into such programs, and the session's output stayed open for
    // the program's whole life.
    map(undefined);
    const r = await run(['--start-background-program'], project);
    assert.ok(r.closedAt - r.exitedAt < 1000, `output closed ${r.closedAt - r.exitedAt} ms after exit`);
    const pid = r.out.backgroundPid as number;
    assert.ok(pid > 0);
    assert.doesNotThrow(() => process.kill(pid, 0), 'the background program must keep running');
    process.kill(pid);
  });

  it('stops Claude when the launcher itself is stopped', async () => {
    map(undefined);
    const p = spawn(exe, [process.execPath, child, '--wait'], { cwd: project, shell: false, windowsHide: true });
    await new Promise((r) => setTimeout(r, 1500));
    const record = JSON.parse(fs.readFileSync(path.join(root, 'sessions', `${p.pid}.json`), 'utf8'));
    p.kill();
    await new Promise((r) => p.on('close', r));
    await new Promise((r) => setTimeout(r, 500));
    assert.throws(() => process.kill(record.claudePid, 0), 'claude must not outlive the launcher');
  });

  it('does not rebuild when the source has not changed', async () => {
    const again = await installLauncher(SOURCE, root);
    assert.equal(again.rebuilt, false);
    assert.equal(again.exe, exe);
  });
});
