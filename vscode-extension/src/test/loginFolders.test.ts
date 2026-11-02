/**
 * Tests for the login-folder file work, on real folders and real junctions in a
 * temp directory. The removal tests are the ones that matter most: a login folder
 * LINKS to the main conversation history, and deleting through a link would wipe
 * it. They run on Windows only, where the junctions exist.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import {
  ensureLoginFolder,
  mirrorMcpServers,
  readBeats,
  readLoginState,
  readSessions,
  removeTree,
  writeBeat,
} from '../loginFolders';

const windowsOnly = { skip: process.platform !== 'win32' ? 'junctions are a Windows feature' : false };
const quiet = () => {};

function sandbox(): { main: string; login: string; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cswap-login-'));
  const main = path.join(root, 'main-claude');
  const login = path.join(root, 'logins', 'login-test');
  fs.mkdirSync(path.join(main, 'projects', 'D--Work-B'), { recursive: true });
  fs.writeFileSync(path.join(main, 'projects', 'D--Work-B', 'conversation.jsonl'), '{"real":"history"}\n');
  fs.mkdirSync(path.join(main, 'skills', 'synced', 'from-claude-ai'), { recursive: true });
  fs.mkdirSync(path.join(main, 'skills', 'my-skill'), { recursive: true });
  fs.writeFileSync(path.join(main, 'skills', 'my-skill', 'SKILL.md'), '# mine');
  fs.writeFileSync(path.join(main, 'settings.json'), '{"hooks":{}}');
  return { main, login, root };
}

describe('ensureLoginFolder', windowsOnly, () => {
  it('links history and personal skills, copies settings, and keeps claude.ai-synced skills separate', () => {
    const { main, login } = sandbox();
    ensureLoginFolder(login, main, quiet);

    assert.equal(fs.readFileSync(path.join(login, 'projects', 'D--Work-B', 'conversation.jsonl'), 'utf8'), '{"real":"history"}\n');
    assert.ok(fs.lstatSync(path.join(login, 'projects')).isSymbolicLink(), 'projects should be a link, not a copy');
    assert.ok(fs.existsSync(path.join(login, 'file-history')), 'file-history link is created even when the main one did not exist');
    assert.ok(fs.existsSync(path.join(login, 'skills', 'my-skill', 'SKILL.md')));
    assert.equal(fs.existsSync(path.join(login, 'skills', 'synced')), false, 'per-account synced skills must not be shared');
    assert.equal(fs.readFileSync(path.join(login, 'settings.json'), 'utf8'), '{"hooks":{}}');
    assert.equal(fs.existsSync(path.join(login, 'plugins')), false);
  });

  it('keeps a setting changed inside the folder until the MAIN settings change', () => {
    const { main, login } = sandbox();
    ensureLoginFolder(login, main, quiet);
    fs.writeFileSync(path.join(login, 'settings.json'), '{"changed":"inside"}');
    ensureLoginFolder(login, main, quiet);
    assert.equal(fs.readFileSync(path.join(login, 'settings.json'), 'utf8'), '{"changed":"inside"}');
    fs.writeFileSync(path.join(main, 'settings.json'), '{"changed":"main"}');
    ensureLoginFolder(login, main, quiet);
    assert.equal(fs.readFileSync(path.join(login, 'settings.json'), 'utf8'), '{"changed":"main"}');
  });

  it('never replaces a folder that already holds its own files with a link', () => {
    const { main, login } = sandbox();
    fs.mkdirSync(path.join(login, 'projects'), { recursive: true });
    fs.writeFileSync(path.join(login, 'projects', 'own.jsonl'), 'own');
    ensureLoginFolder(login, main, quiet);
    assert.equal(fs.readFileSync(path.join(login, 'projects', 'own.jsonl'), 'utf8'), 'own');
  });
});

describe('removeTree', windowsOnly, () => {
  it('deletes a login folder and leaves everything it linked to untouched', () => {
    const { main, login } = sandbox();
    ensureLoginFolder(login, main, quiet);
    fs.writeFileSync(path.join(login, '.credentials.json'), '{}');

    removeTree(login);

    assert.equal(fs.existsSync(login), false, 'the login folder itself is gone');
    assert.equal(
      fs.readFileSync(path.join(main, 'projects', 'D--Work-B', 'conversation.jsonl'), 'utf8'),
      '{"real":"history"}\n',
      'the REAL conversation history must survive'
    );
    assert.ok(fs.existsSync(path.join(main, 'skills', 'my-skill', 'SKILL.md')), 'linked skills must survive');
    assert.ok(fs.existsSync(path.join(main, 'settings.json')));
  });

  it('removes a link it is pointed at directly, not what the link points to', () => {
    const { main, login } = sandbox();
    ensureLoginFolder(login, main, quiet);
    removeTree(path.join(login, 'projects'));
    assert.equal(fs.existsSync(path.join(login, 'projects')), false);
    assert.ok(fs.existsSync(path.join(main, 'projects', 'D--Work-B', 'conversation.jsonl')));
  });
});

describe('mirrorMcpServers', () => {
  it('copies user-level MCP servers in, and keeps the rest of the file', () => {
    const { root, login } = sandbox();
    fs.mkdirSync(login, { recursive: true });
    const mainConfig = path.join(root, 'main.claude.json');
    fs.writeFileSync(mainConfig, JSON.stringify({ mcpServers: { blender: { command: 'uvx' } }, projects: {} }));
    fs.writeFileSync(path.join(login, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'x@y' } }));

    assert.equal(mirrorMcpServers(login, mainConfig), 'updated');
    const after = JSON.parse(fs.readFileSync(path.join(login, '.claude.json'), 'utf8'));
    assert.deepEqual(after.mcpServers, { blender: { command: 'uvx' } });
    assert.equal(after.oauthAccount.emailAddress, 'x@y', 'who is signed in must be kept');
    assert.equal(mirrorMcpServers(login, mainConfig), 'unchanged');
  });

  it('leaves a half-written or broken config alone instead of replacing it', () => {
    const { root, login } = sandbox();
    fs.mkdirSync(login, { recursive: true });
    const mainConfig = path.join(root, 'main.claude.json');
    fs.writeFileSync(mainConfig, JSON.stringify({ mcpServers: { blender: {} } }));
    fs.writeFileSync(path.join(login, '.claude.json'), '{"oauthAccount": {"emailAd');
    assert.equal(mirrorMcpServers(login, mainConfig), 'skipped');
    assert.equal(fs.readFileSync(path.join(login, '.claude.json'), 'utf8'), '{"oauthAccount": {"emailAd');
  });
});

describe('readLoginState', () => {
  it('reads sign-in state from a login folder', () => {
    const { login } = sandbox();
    fs.mkdirSync(login, { recursive: true });
    assert.equal(readLoginState(login).hasCredentials, false);
    fs.writeFileSync(path.join(login, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'two@example.com' } }));
    fs.writeFileSync(path.join(login, '.credentials.json'), JSON.stringify({ claudeAiOauth: { refreshToken: 'r', refreshTokenExpiresAt: 123 } }));
    assert.deepEqual(readLoginState(login), { hasCredentials: true, email: 'two@example.com', organizationUuid: undefined, expiresAt: 123 });
  });
});

describe('records', () => {
  it('reads live window heartbeats and deletes ones from long-closed windows', () => {
    const { root } = sandbox();
    const dir = path.join(root, 'windows');
    writeBeat(dir, { hostPid: 1, name: 'live', folders: ['D:\\A'], focused: true, updatedAt: 1_000 });
    writeBeat(dir, { hostPid: 2, name: 'closed', folders: [], focused: false, updatedAt: 1_000 });
    const beats = readBeats(dir, (pid) => pid === 1, 1_000 + 10 * 60_000);
    assert.deepEqual(beats.map((b) => b.name), ['live']);
    assert.equal(fs.existsSync(path.join(dir, '2.json')), false);
  });

  it('reads running sessions and deletes the records of finished ones', () => {
    const { root } = sandbox();
    const dir = path.join(root, 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const rec = (launcherPid: number, claudePid: number) =>
      fs.writeFileSync(path.join(dir, `${launcherPid}.json`), JSON.stringify({ launcherPid, hostPid: 7, claudePid, cwd: 'D:\\A', loginFolder: null, startedAt: '' }));
    rec(10, 11);
    rec(20, 21);
    const sessions = readSessions(dir, (pid) => pid === 11);
    assert.deepEqual(sessions.map((s) => s.launcherPid), [10]);
    assert.equal(fs.existsSync(path.join(dir, '20.json')), false);
  });
});
