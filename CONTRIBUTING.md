# Contributing

First, the thing that decides where your change belongs.

## This is a fork. Where does your change go?

| Your change | Where it belongs |
|---|---|
| The `cswap` CLI, switching, credentials, usage — anything in `src/` or `tests/` | **[Upstream](https://github.com/realiti4/claude-swap)**, not here |
| The VS Code extension (`vscode-extension/`) | Here |
| Upstream-tracking tooling (`fork-tools/`) | Here |

`src/` and `tests/` are kept **byte-identical to upstream** on purpose. That is
what makes merging upstream a non-event: everything added in this fork lives in
directories upstream has never used, so the two never collide. A core fix made
here would help one person and drift out of date; the same fix upstream helps
everyone and comes back to this fork automatically on the next merge.

If you are unsure, open an issue and ask.

## Setting up

### The VS Code extension

```bash
cd vscode-extension
npm install
npm test          # compiles, then runs the analysis tests
npm run package   # produces a .vsix you can install locally
```

Press <kbd>F5</kbd> with `vscode-extension/.vscode/launch.json` selected to launch a
development instance of VS Code with the extension loaded.

The extension needs a working `cswap` to do anything useful. It finds one on your
PATH, in the usual `uv`/`pipx` locations, or in a `.venv` inside a **trusted**
workspace.

### The core tool (only if you are debugging it locally)

```bash
uv sync
uv run pytest
```

If `uv` is not installed, the committed virtualenv works the same way:
`.venv/Scripts/python -m pytest` on Windows, `.venv/bin/python -m pytest` elsewhere.

## Things that will bite you

**Never point the tests at your real account store.** The Python suite installs a
process-wide audit hook that refuses writes to the real store and raises
`RealStoreWriteBlocked` — it exists because the developer's actual accounts were
once overwritten by test data. If you see that exception, your test is escaping its
fixture, not hitting a bug in the guard.

**Four tests fail on Windows without Developer Mode.** The three in
`TestAtomicWriteThroughSymlink` and one in `test_launch_agent.py` call
`Path.symlink_to()`, which Windows blocks without elevated rights or Developer
Mode. They pass in CI. Treat only *new* failures as yours.

**The extension parses a contract, not an implementation.** It reads the JSON
`cswap --json` prints, whose shape is defined in `src/claude_swap/json_output.py`
and documented as additive-only. If you change how output is parsed, update
`vscode-extension/src/types.ts` to match, and keep every field optional unless the
contract guarantees it.

**Don't duplicate policy.** Threshold, cooldown and strategy live in claude-swap's
own settings. The extension deliberately passes no policy flags to `cswap auto`, so
that the CLI, the extension and the macOS menu bar all agree. Adding a competing
threshold setting to the extension would create two sources of truth.

## Style

- **Comments record evidence, not intent.** The convention throughout this codebase
  is to write down the measurement, the platform, the issue number, and what the
  obvious alternative got wrong. `poll_policy.py` and `claude_locks.py` are the
  reference examples. If you change behaviour in such a place, replace the evidence
  with your own measurement rather than deleting it.
- Keep dependencies few and justify new ones. The extension currently has **zero**
  runtime dependencies, and its tests use Node's built-in runner for that reason.
- There is no configured linter or formatter. Please don't add one incidentally;
  match the surrounding code.

## Tests

Logic that transforms data needs a test. In the extension, put pure logic in
`src/analysis.ts` — it has no `vscode` import specifically so it can be tested with
plain `node --test`, and anything testable should live there rather than inside a
class that needs an editor instance.

Name a test as a sentence about behaviour, so a failure reads as a statement about
what broke.

## Commits

Conventional-commit prefixes (`feat:`, `fix:`, `docs:`, `chore:`) and a body that
explains **why**. The audience is somebody reading it in six months with no memory
of the conversation that produced it.
