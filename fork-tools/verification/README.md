# Verification scripts

Three checks that cannot live in a normal test suite, kept here so the claims they
support stay re-derivable rather than becoming folklore. Each one is referenced by a
code comment or changelog entry that states a measured result; if you change the code
those comments describe, **re-run the script and update the number** rather than
trusting what is written.

None of them touch your real account store, your credentials, or the network.

## Why these are not unit tests

| Script | Why it needs its own harness |
| --- | --- |
| `filelock-crossprocess.py` | Tests exclusion between separate **OS processes**. A single-process test cannot produce the condition. |
| `leader-election.js` | Tests atomicity under a genuine **race**. Same reason. |
| `per-model-rendering.js` | Drives real VS Code classes (`StatusBar`, tree, notifications) against data **this machine's accounts never produce**. |

The pure logic underneath all three *is* unit-tested — `leaseVerdict`,
`hiddenModelConstraint` and friends live in `vscode-extension/src/analysis.ts`
precisely so they can be tested with `npm test`. These scripts cover the part that
only a real process, a real race or a real render can cover.

## Running them

The two JavaScript ones need a compiled extension first:

```bash
cd vscode-extension && npm run compile && cd ..
```

Then, from the repository root:

```bash
.venv/Scripts/python fork-tools/verification/filelock-crossprocess.py   # Windows
node fork-tools/verification/leader-election.js
node fork-tools/verification/per-model-rendering.js
```

Each exits `0` on success and `1` on failure, so they can be chained or run from CI.

## What each one establishes

### `filelock-crossprocess.py`

That `claude_swap.locking.FileLock` excludes across processes — the premise upstream's
`test_locked_recheck_stops_concurrent_engine` relies on but cannot check, since it runs
two engines in one process. It matters because two VS Code windows spawn two
`cswap auto --once` **processes**, and on Windows the lock is `msvcrt.locking` rather
than `fcntl.flock`.

Five processes take the lock in turn; the log must show every `start` immediately
followed by its own `end`. Elapsed time is also compared against the serial floor, so a
run that avoided interleaving by racing through still fails.

*Measured 2026-09-24, Windows 10, Python 3.14: strictly serialised, zero interleaving,
2.15s against a 1.75s floor.*

### `leader-election.js`

That exactly one VS Code window claims the auto-switch timer.

**This script caught a real bug.** The first implementation read lease staleness from
the file's JSON body and treated an unreadable body as abandoned — but between one
process creating the file and writing into it, the others see it empty, so they deleted
the winner's lease and created their own:

```
results: 3 WON, 5 LOST (of 8)      <-- the bug
results: 1 WON, 7 LOST (of 8)      <-- after the fix
```

The fix makes the file's *existence* the mutex via `openSync(..., 'wx')`, one atomic
create-or-fail, and takes staleness from `mtime`, which the filesystem stamps at
creation. Keep this script: a refactor could reintroduce exactly that hole, and nothing
in a single-process test would notice.

*Measured 2026-09-24, Windows 10, Node 24: 1 leader from 8 simultaneous processes, 5
consecutive runs.*

### `per-model-rendering.js`

That a per-model (`scoped`) usage window reaches the status bar, the hover tooltip, the
sidebar tree **and** a notification.

You can be blocked by a weekly per-model limit (Fable, Opus) while the account-level
percentage still reads comfortably — so the account number alone hides the thing that
actually stops you. The payload is upstream's own API fixture (account weekly 72%,
Fable 100%), not invented numbers.

Among its ten assertions, one is about restraint rather than display: the status bar
must still report the **account** window as binding, because claude-swap's auto-switch
ignores per-model windows unless `autoswitch.model` names one. The display must never
imply a decision the switching policy will not make.

*Measured 2026-09-24: 10/10 assertions pass. Still unconfirmed against a live account
that reports per-model windows, because neither account on the development machine
does.*
