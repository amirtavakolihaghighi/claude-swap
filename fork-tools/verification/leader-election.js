/**
 * Does LeaderLease elect exactly ONE leader among racing processes?
 *
 * This test caught a real bug and exists to stop it coming back. The first
 * implementation decided lease staleness from the file's JSON body and treated an
 * unreadable body as abandoned. Between one process creating the lease file and
 * writing into it, the others read it as EMPTY, concluded it was abandoned, deleted
 * the winner's lease and created their own:
 *
 *     results: 3 WON, 5 LOST (of 8)      <-- the bug
 *     results: 1 WON, 7 LOST (of 8)      <-- after the fix
 *
 * The fix makes the file's EXISTENCE the mutex, via openSync(..., 'wx') — a single
 * atomic create-or-fail — and takes staleness from mtime, which the filesystem stamps
 * at creation. `leaseVerdict` in analysis.ts has unit tests for the decision table;
 * only separate OS processes can test the atomicity, because a single-process test
 * cannot produce the race.
 *
 * Measured 2026-09-24, Windows 10, Node 24: exactly 1 leader from 8 simultaneous
 * processes, 5 consecutive runs.
 *
 * Requires a compiled extension:  cd vscode-extension && npm run compile
 *
 * Run from anywhere:
 *     node fork-tools/verification/leader-election.js
 * Exit code 0 = exactly one leader and staleness handled, 1 = not.
 */
const Module = require('module');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// Repo-relative, so this works on any checkout and leaks no local paths.
const REPO = path.resolve(__dirname, '..', '..');
const OUT = path.join(REPO, 'vscode-extension', 'out');
const N = 8;
const STALE_MS = 4 * 60 * 1000; // must match LEASE_STALE_MS in analysis.ts

function loadLease(storageDir) {
  const originalLoad = Module._load;
  Module._load = function (request) {
    if (request === 'vscode') {
      return {
        window: {
          createOutputChannel: () => ({
            appendLine: () => {}, show: () => {}, dispose: () => {},
          }),
        },
      };
    }
    return originalLoad.apply(this, arguments);
  };
  const leaderPath = path.join(OUT, 'leader.js');
  if (!fs.existsSync(leaderPath)) {
    console.error(`Not compiled: ${leaderPath}\nRun: cd vscode-extension && npm run compile`);
    process.exit(1);
  }
  const { LeaderLease } = require(leaderPath);
  return new LeaderLease({ globalStorageUri: { fsPath: storageDir }, subscriptions: [] });
}

// ---- child roles -----------------------------------------------------------

if (process.argv[2] === 'race') {
  const lease = loadLease(process.argv[3]);
  // Spin to a shared wall-clock boundary so the racers actually collide; arriving
  // in sequence would leave the race untested and the test worthless.
  const target = Number(process.argv[4]);
  while (Date.now() < target) { /* deliberate busy-wait */ }
  process.stdout.write(lease.acquire() ? `WON ${process.pid}\n` : `LOST ${process.pid}\n`);
  process.exit(0);
}

if (process.argv[2] === 'aged') {
  const dir = process.argv[3];
  const ageMs = Number(process.argv[4]);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'autoswitch-leader.json');
  fs.writeFileSync(f, JSON.stringify({ pid: 999999, ts: Date.now() - ageMs }), 'utf8');
  // Age it on the FILESYSTEM. Writing an old `ts` into the body is exactly the
  // signal the current design ignores on purpose, so a body-only fake would test
  // nothing — an earlier version of this script made that mistake and "failed"
  // against correct code.
  const when = (Date.now() - ageMs) / 1000;
  fs.utimesSync(f, when, when);
  const lease = loadLease(dir);
  process.stdout.write(lease.acquire() ? 'TOOK_OVER\n' : 'STOOD_DOWN\n');
  process.exit(0);
}

// ---- parent ----------------------------------------------------------------

const dir = path.join(__dirname, '.leaderstore');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

let failures = 0;

console.log(`Test 1: ${N} processes race for the lease simultaneously`);
const target = Date.now() + 1500;
const kids = Array.from({ length: N }, () =>
  spawn(process.execPath, [__filename, 'race', dir, String(target)],
    { stdio: ['ignore', 'pipe', 'pipe'] })
);
let out = '';
kids.forEach((k) => k.stdout.on('data', (d) => { out += d.toString(); }));

Promise.all(kids.map((k) => new Promise((r) => k.on('close', r)))).then(() => {
  const lines = out.trim().split(/\r?\n/).filter(Boolean);
  const won = lines.filter((l) => l.startsWith('WON'));
  console.log(`  results: ${won.length} WON, ${lines.length - won.length} LOST (of ${N})`);
  won.forEach((l) => console.log(`    ${l}`));
  if (lines.length !== N) {
    console.log(`  FAIL: only ${lines.length}/${N} processes reported`);
    failures++;
  } else if (won.length !== 1) {
    console.log(`  FAIL: expected exactly 1 leader, got ${won.length}`);
    failures++;
  } else {
    console.log('  PASS: exactly one leader elected under a real race');
  }

  console.log('\nTest 2: a live lease is respected by another process');
  const holder = JSON.parse(
    fs.readFileSync(path.join(dir, 'autoswitch-leader.json'), 'utf8')
  );
  const stole = loadLease(dir).acquire();
  console.log(`  fresh process against pid ${holder.pid}'s lease: `
    + (stole ? 'ACQUIRED' : 'stood down'));
  if (stole) {
    console.log('  FAIL: stole a live lease');
    failures++;
  } else {
    console.log('  PASS');
  }

  console.log('\nTest 3: staleness, both directions');
  const staleDir = path.join(__dirname, '.leaderstore-stale');
  const freshDir = path.join(__dirname, '.leaderstore-fresh');
  [staleDir, freshDir].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  const aged = spawnSync(process.execPath,
    [__filename, 'aged', staleDir, String(STALE_MS + 60_000)], { encoding: 'utf8' });
  const fresh = spawnSync(process.execPath,
    [__filename, 'aged', freshDir, String(10_000)], { encoding: 'utf8' });
  const a = (aged.stdout || '').trim();
  const f = (fresh.stdout || '').trim();
  console.log(`  lease older than the stale window: ${a}`);
  console.log(`  10-second-old lease:                ${f}`);
  if (a !== 'TOOK_OVER') {
    console.log('  FAIL: did not reclaim an abandoned lease (the timer would wedge)');
    failures++;
  }
  if (f !== 'STOOD_DOWN') {
    console.log('  FAIL: stole a fresh lease (two leaders)');
    failures++;
  }
  if (a === 'TOOK_OVER' && f === 'STOOD_DOWN') {
    console.log('  PASS');
  }

  [dir, staleDir, freshDir].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  console.log(failures === 0
    ? '\nALL LEADER TESTS PASSED'
    : `\n${failures} LEADER TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
});
