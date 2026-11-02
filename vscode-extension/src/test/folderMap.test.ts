/**
 * Tests for the pure folder-login logic. The path cases mirror the launcher's own
 * checks (launcher.test.ts): if the sidebar and the launcher disagree on which
 * login a folder uses, the sidebar is lying.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FolderBinding,
  LauncherSession,
  WindowBeat,
  bindingFor,
  describeVerdict,
  folderContains,
  launcherMap,
  loginIdFor,
  loginStateFrom,
  loginVerdict,
  windowRows,
} from '../folderMap';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-02T12:00:00Z');

function binding(folder: string, over: Partial<FolderBinding> = {}): FolderBinding {
  return { folder, loginId: 'login-x', createdAt: '2026-11-02T00:00:00Z', ...over };
}

describe('folderContains', () => {
  it('matches the folder itself and anything inside it, ignoring case and trailing slashes', () => {
    assert.ok(folderContains('D:\\Work\\B', 'd:\\work\\b'));
    assert.ok(folderContains('D:\\Work\\B\\', 'D:\\Work\\B\\src\\x'));
    assert.ok(folderContains('D:\\Work\\B', 'D:/Work/B/src'));
  });

  it('does not match a sibling whose name merely starts the same', () => {
    assert.equal(folderContains('D:\\Work\\B', 'D:\\Work\\B2'), false);
    assert.equal(folderContains('D:\\Work\\B', 'D:\\Work'), false);
  });

  it('treats a drive root as containing the whole drive', () => {
    assert.ok(folderContains('C:\\', 'C:\\Users\\x'));
  });
});

describe('bindingFor', () => {
  it('lets the nearest folder win, like the launcher', () => {
    const outer = binding('D:\\Work', { loginId: 'outer' });
    const inner = binding('D:\\Work\\B', { loginId: 'inner' });
    assert.equal(bindingFor('D:\\Work\\B\\src', [outer, inner])?.loginId, 'inner');
    assert.equal(bindingFor('D:\\Work\\C', [outer, inner])?.loginId, 'outer');
    assert.equal(bindingFor('E:\\Elsewhere', [outer, inner]), undefined);
  });
});

describe('loginIdFor', () => {
  it('gives one login per account, so two folders on one account share a sign-in', () => {
    const a = loginIdFor({ email: 'Me@Example.com', organizationUuid: 'o1' }, 'D:\\A');
    const b = loginIdFor({ email: 'me@example.com', organizationUuid: 'o1' }, 'D:\\B');
    assert.equal(a, b);
    assert.notEqual(a, loginIdFor({ email: 'me@example.com', organizationUuid: 'o2' }, 'D:\\A'));
  });

  it('keeps the email out of the folder name', () => {
    assert.doesNotMatch(loginIdFor({ email: 'me@example.com' }, 'D:\\A'), /example/);
  });

  it('gives "whichever I sign in with" a login per folder', () => {
    assert.notEqual(loginIdFor(undefined, 'D:\\A'), loginIdFor(undefined, 'D:\\B'));
    assert.equal(loginIdFor(undefined, 'D:\\A'), loginIdFor(undefined, 'd:\\a\\'));
  });
});

describe('launcherMap', () => {
  it('writes one tab-separated line per folder, with Windows line endings', () => {
    const text = launcherMap([binding('D:\\Work\\B\\', { loginId: 'login-1' })], (id) => `C:\\L\\${id}`);
    const lines = text.split('\r\n');
    assert.ok(lines[0].startsWith('#'));
    assert.equal(lines[1], 'D:\\Work\\B\tC:\\L\\login-1');
    assert.ok(text.endsWith('\r\n'));
  });

  it('leaves out a path that could not be written as one line', () => {
    const text = launcherMap([binding('D:\\bad\tname')], () => 'C:\\L');
    assert.equal(text.split('\r\n').filter((l) => l && !l.startsWith('#')).length, 0);
  });
});

describe('loginStateFrom / loginVerdict', () => {
  const claudeJson = { oauthAccount: { emailAddress: 'two@example.com', organizationUuid: 'o2' } };
  const creds = (expiresAt: number) => ({
    claudeAiOauth: { accessToken: 'at', refreshToken: 'rt', refreshTokenExpiresAt: expiresAt },
  });
  const bound = binding('D:\\B', { account: { email: 'two@example.com', organizationUuid: 'o2' } });

  it('reads who is signed in and when the login ends, without keeping any token', () => {
    const state = loginStateFrom(claudeJson, creds(NOW + 10 * DAY));
    assert.deepEqual(state, {
      hasCredentials: true,
      email: 'two@example.com',
      organizationUuid: 'o2',
      expiresAt: NOW + 10 * DAY,
    });
    assert.doesNotMatch(JSON.stringify(state), /"at"|"rt"/);
  });

  it('says "not signed in" for a fresh login folder', () => {
    assert.deepEqual(loginVerdict(bound, loginStateFrom({}, undefined), NOW), { kind: 'not-signed-in' });
  });

  it('counts the days left on a good login', () => {
    const v = loginVerdict(bound, loginStateFrom(claudeJson, creds(NOW + 10.5 * DAY)), NOW);
    assert.deepEqual(v, { kind: 'signed-in', email: 'two@example.com', daysLeft: 10 });
    assert.equal(describeVerdict(v, bound), 'Signed in as two@example.com · login lasts 10 more days');
  });

  it('notices a sign-in with a different account than the folder was set to', () => {
    const other = { oauthAccount: { emailAddress: 'one@example.com', organizationUuid: 'o1' } };
    const v = loginVerdict(bound, loginStateFrom(other, creds(NOW + DAY * 5)), NOW);
    assert.equal(v.kind, 'wrong-account');
    assert.match(describeVerdict(v, bound), /Signed in as one@example.com, but set to two@example.com/);
  });

  it('says an expired login will ask to sign in again', () => {
    const v = loginVerdict(bound, loginStateFrom(claudeJson, creds(NOW - 1)), NOW);
    assert.equal(v.kind, 'expired');
    assert.match(describeVerdict(v, bound), /ask you to sign in again/);
  });

  it('accepts any account for a folder set to "whichever I sign in with"', () => {
    const free = binding('D:\\F');
    assert.equal(loginVerdict(free, loginStateFrom(claudeJson, creds(NOW + DAY)), NOW).kind, 'signed-in');
  });
});

describe('windowRows', () => {
  const beat = (hostPid: number, name: string, folders: string[], updatedAt = NOW): WindowBeat => ({
    hostPid,
    name,
    folders,
    focused: false,
    updatedAt,
  });
  const session = (over: Partial<LauncherSession>): LauncherSession => ({
    launcherPid: 900,
    hostPid: 0,
    claudePid: 901,
    cwd: 'D:\\X',
    loginFolder: null,
    startedAt: '',
    ...over,
  });
  const allAlive = () => true;

  it('lists this window first and the others by name', () => {
    const rows = windowRows(
      [beat(2, 'zeta', []), beat(1, 'mine', []), beat(3, 'alpha', [])],
      [],
      [],
      1,
      allAlive,
      NOW
    );
    assert.deepEqual(rows.map((r) => r.beat.name), ['mine', 'alpha', 'zeta']);
    assert.ok(rows[0].isThisWindow);
  });

  it('drops a closed window: its process is gone and its heartbeat is old', () => {
    const rows = windowRows([beat(1, 'mine', []), beat(2, 'closed', [], NOW - 5 * 60_000)], [], [], 1, (pid) => pid === 1, NOW);
    assert.deepEqual(rows.map((r) => r.beat.name), ['mine']);
  });

  it('shows the folder login of a window whose folder has one', () => {
    const b = binding('D:\\B', { loginId: 'login-b' });
    const rows = windowRows([beat(1, 'mine', ['D:\\A']), beat(2, 'b', ['D:\\B'])], [], [b], 1, allAlive, NOW);
    assert.equal(rows.find((r) => r.beat.name === 'b')?.binding?.loginId, 'login-b');
    assert.equal(rows.find((r) => r.beat.name === 'mine')?.binding, undefined);
  });

  it('counts a window\'s running Claude sessions by the process that started them', () => {
    const rows = windowRows(
      [beat(1, 'mine', ['D:\\A']), beat(2, 'b', ['D:\\B'])],
      [session({ hostPid: 2, cwd: 'D:\\B' }), session({ hostPid: 2, cwd: 'D:\\B', claudePid: 902 }), session({ hostPid: 1, cwd: 'D:\\A', claudePid: 903 })],
      [],
      1,
      allAlive,
      NOW
    );
    assert.equal(rows.find((r) => r.beat.name === 'b')?.sessions.length, 2);
    assert.equal(rows.find((r) => r.beat.name === 'mine')?.sessions.length, 1);
  });

  it('falls back to the folder when the launcher could not tell which window started it', () => {
    const rows = windowRows([beat(1, 'mine', ['D:\\A']), beat(2, 'b', ['D:\\B'])], [session({ hostPid: 0, cwd: 'D:\\B\\src' })], [], 1, allAlive, NOW);
    assert.equal(rows.find((r) => r.beat.name === 'b')?.sessions.length, 1);
  });

  it('ignores sessions whose Claude has exited', () => {
    const rows = windowRows([beat(1, 'mine', ['D:\\A'])], [session({ hostPid: 1, claudePid: 999 })], [], 1, (pid) => pid !== 999, NOW);
    assert.equal(rows[0].sessions.length, 0);
  });
});
