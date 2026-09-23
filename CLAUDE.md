# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## This is a fork — read this first

This repo is a **fork** of [realiti4/claude-swap](https://github.com/realiti4/claude-swap). `src/`, `tests/` and `pyproject.toml` are upstream's and are kept **byte-identical**, so that merging upstream is a non-event. Everything added in the fork lives in paths upstream has never used:

- **[vscode-extension/](vscode-extension/)** — a TypeScript VS Code extension (status bar usage, sidebar panel, click-to-switch, background auto-switch, burn-rate estimates). It shells out to `cswap --json` and imports no Python. Its *only* coupling to the core is the JSON contract in [json_output.py](src/claude_swap/json_output.py) — so a change there is the one thing that can break it.
- **[fork-tools/](fork-tools/)** — `check-upstream.ps1` (exit 10 = updates available) and `UPSTREAM-MERGE-PROMPT.md`, the merge workflow. **Read that prompt before merging upstream**; it records which files are intentionally modified.
- Added root files: `.gitattributes`, `.editorconfig`, `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `.github/PULL_REQUEST_TEMPLATE.md`, `.github/workflows/vscode-extension.yml`.
- `README.md` is the **one modified upstream file** (a "this is a fork" block after the intro). Expect a conflict there on upstream README changes; keep both sides.

Extension work: `cd vscode-extension && npm test` (compiles + runs 37 tests). Pure logic goes in `src/analysis.ts`, which has no `vscode` import specifically so it is testable with `node --test`.

**On this machine:** `uv` is not installed, and `cswap` exists only in this repo's `.venv`. The Python baseline here is **2186 passed, 4 failed, 81 skipped** — the 4 are symlink tests Windows blocks without Developer Mode. Treat only new failures as real.

## Commands

The canonical toolchain is `uv` (the lockfile is committed and CI runs `uv sync --locked`). `uv` is not on PATH on every dev box — the repo's `.venv/` works identically:

```bash
uv sync                                  # install deps + dev group (PEP 735)
uv run pytest                            # full suite (parallel by default)
uv run pytest tests/test_switcher.py     # one file
uv run pytest tests/test_paths.py::TestGetBackupRoot::test_linux_respects_xdg_data_home
uv run pytest -n0                        # serial — required for pdb/-s, and for
                                         # reading interleaved output
uv run cswap --list                      # run the CLI from source
```

Without `uv`: `.venv/Scripts/python -m pytest …` (Windows) / `.venv/bin/python -m pytest …`.

`addopts = "-n auto --dist loadgroup"` is set in `pyproject.toml`, so every run is xdist-parallel. `--dist loadgroup` is load-bearing: `pytest_collection_modifyitems` in [tests/conftest.py](tests/conftest.py) pins `no_keychain_fake` tests to one worker because they drive the real `security` CLI against a process-wide keychain.

There is no configured linter or formatter — don't introduce one incidentally. CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs the *whole* suite on ubuntu, windows, and macos; the macOS job's id is `macos-keychain` for branch-protection reasons and its comment explains, at length, why it must not be narrowed back to a file selection.

Debugging the CLI in VS Code: [.vscode/launch.json](.vscode/launch.json) has `debugpy` configs for `claude_swap.cli` with `PYTHONPATH=src`.

## What this is

`cswap` / `claude-swap` is a multi-account switcher for Claude Code. It reads and writes **Claude Code's own** credential and config files — it is not an SDK client. Two consequences shape most of the code:

1. **Every path, lock, and storage decision mirrors Claude Code's behavior**, verified against specific bundle versions. [paths.py](src/claude_swap/paths.py) and [claude_locks.py](src/claude_swap/claude_locks.py) cite the claude-code source symbols they mirror (e.g. `getGlobalClaudeFile`, the `uKi`/`CKi` lock helpers in the 2.1.218 bundle). When Claude Code's behavior is the spec, changing our side to "look cleaner" is a bug.
2. **OAuth refresh tokens are one-time-use.** Most of the apparent over-engineering in [switcher.py](src/claude_swap/switcher.py) and [credentials.py](src/claude_swap/credentials.py) exists to guarantee a given grant is POSTed exactly once, and that a credential is never destroyed without a copy surviving somewhere.

## Architecture

### Layering (enforced by docstrings, not tooling)

```
fsutil ──┐  leaf: atomic write / retry primitives, no claude_swap imports
paths ───┤
models ──┤
oauth ───┼──> credentials  (storage: Keychain-vs-file routing; NEVER imports switcher)
         ├──> usage_store  (+ poll_policy: the usage-API cadence budget)
         └──> switcher     (orchestration; imports everything above)
                 ├──> session      (must not import switcher — receives an instance)
                 ├──> mappings     (never imports switcher)
                 ├──> autoswitch   (UI-agnostic engine, composes a switcher)
                 └──> snapshot_source ──> tui/ , menubar
```

`credentials.CredentialStore` reads its live config (`platform`, `_logger`, `credentials_dir`) through a data-only *host view* onto the switcher and must never call a switcher *method* — that's what keeps storage and orchestration from re-coupling. `session.py` and `switcher.py` are mutually dependent by design, resolved with local imports inside functions.

### Core objects

- **`ClaudeAccountSwitcher`** ([switcher.py](src/claude_swap/switcher.py), ~7.4k lines) — the account orchestrator. Slot metadata lives in `sequence.json` (`activeAccountNumber`, `sequence`, `accounts{num: {email, uuid, organizationUuid, …}}`); account identity is the **(email, organizationUuid) composite**, not the slot number, because slot numbers get reused. Constructing one runs the legacy→XDG backup migration and `migrations.run_migrations`, so it is not free and not side-effect-free.
- **`CredentialStore`** ([credentials.py](src/claude_swap/credentials.py)) — owns *where* credentials live. Active credential: macOS Keychain, else `~/.claude/.credentials.json`. Per-slot backups: macOS Keychain while usable, otherwise base64 `.enc` files under `credentials/`; Windows/Linux always files (#45: Credential Manager rejects entries >~2500 bytes). Backup **reads are `.enc`-wins on every platform** so a recovered Keychain can't shadow a newer fallback file.
- **`UsageStore`** ([usage_store.py](src/claude_swap/usage_store.py)) — per-account last-known-good usage plus fetch/backoff/claim state at `cache/usage.json` (`schemaVersion: 2`). Stale-on-error: a failed fetch updates error/backoff fields and never touches `lastGood`. Sentinel states (`"api key"`, `"token expired"`, …) are derived per pass and **never persisted**.
- **`poll_policy`** ([poll_policy.py](src/claude_swap/poll_policy.py)) — every cadence constant for `/api/oauth/usage`, with the measurements they were derived from. The endpoint's limit is a ~60-minute trailing window of ~28–30 requests per identity, *not* a refilling bucket. Target is ≤~1 request / 3 min. Don't tune these from intuition.
- **`AutoSwitchEngine`** ([autoswitch.py](src/claude_swap/autoswitch.py)) — UI-agnostic: no printing, no argparse, no TUI imports. Reports typed events via an `on_event` callback; the CLI renders them as human lines or JSONL, and the TUI and menu bar consume the same stream. Cooldown + quarantine persist in `autoswitch_state.json`.
- **`SnapshotSource`** ([snapshot_source.py](src/claude_swap/snapshot_source.py)) — the supported read path for dashboards. Pacing is *store*-governed, so a TUI repainting every few seconds and a one-shot `cswap list` make identical network calls. `take()` blocks; call it from a thread.

### The switch path

`switch`/`switch_to` → `_perform_switch`, which holds **cswap's own `.lock` plus Claude Code's advisory locks** (`.oauth_refresh.lock`, `~/.claude.lock`, `~/.claude.json.lock`) across the whole mutation including rollback. Claude Code refreshes tokens under those same locks with a double-checked re-read, so a swap under the lock makes a concurrent refresh abort rather than clobber. `SwitchTransaction` ([models.py](src/claude_swap/models.py)) records completed steps and rolls them back in reverse.

Two invariants to preserve when touching this area:

- **Network I/O never runs under a lock others contend on.** Identity prefetch and token freshening happen *before* the locks are taken.
- **`consume_backup_grant` is the serialization point for spending a refresh token** — per-slot consume lock held across re-read → POST → CAS-on-fingerprint → persist-or-stash. A second call site exists (`_fetch_active_usage`'s recovery branch) and takes the same lock in the same order; its comment says why. A consumed generation is never discarded — it's *stashed* and adopted by the next pass.
- A live credential that provably doesn't belong to the active slot is **stashed** (`credentials/.unclaimed-*.enc` + `.unclaimed-manifest.json`, 0600 files on every platform) before being overwritten. A successful stash is the license to overwrite. `cswap unclaimed` lists these; nothing consumes them automatically.

### Session mode

`cswap run N` ([session.py](src/claude_swap/session.py)) launches Claude Code with `CLAUDE_CONFIG_DIR` pointed at `sessions/<num>-<email-slug>/`, leaving the default login untouched. Profiles are seeded with plaintext `.credentials.json` **even on macOS** — deliberately, so we never have to reproduce Claude's hashed-keychain naming, where a mismatch reads as "logged out". Shared assets (`settings.json`, `CLAUDE.md`, `skills/`, …) are symlinks on POSIX, re-synced copies on Windows, tracked by a manifest so removal never touches user data.

### Output & interfaces

- Human output goes through [printer.py](src/claude_swap/printer.py) (single warm accent, `force_utf8_output()` for Windows consoles); theme resolution is in [appearance.py](src/claude_swap/appearance.py), which must query the terminal in cooked mode *before* Textual's input driver starts.
- `--json` payload shapes live in one place, [json_output.py](src/claude_swap/json_output.py), at `SCHEMA_VERSION = 1`. **The contract is additive** — new fields and event kinds may appear, the version bumps only on a breaking shape change. In JSON mode stdout is the single payload and all human notices go to stderr.
- The CLI ([cli.py](src/claude_swap/cli.py)) keeps a flag-first interface (`--list`, `--switch`) with memorable verbs rewritten onto it by `_translate_subcommand`. `run`, `auto`, `map`, `config`, `alias`, … are *pre-dispatched* before the main parser is built, because a positional subcommand can't coexist with `main()`'s mutually-exclusive flag group. Both spellings are tested; don't drop the flags.
- The TUI ([tui/](src/claude_swap/tui/)) never parses printed CLI output — it consumes `accounts_snapshot()` and renders structured data. Blocking switcher work always runs in Textual thread workers.

### Data layout (`<backup_root>`)

`~/.claude-swap-backup/` on macOS/Windows; `${XDG_DATA_HOME:-~/.local/share}/claude-swap/` on Linux/WSL, with a one-time migration from the legacy path.

```
sequence.json  settings.json  autoswitch_state.json  mappings.json  .migrations.json
.lock  claude-swap.log  menubar_settings.json
configs/     .claude-config-<num>-<email>.json
credentials/ .creds-<num>-<email>.enc  .unclaimed-*.enc  .consume-<num>.lock
cache/       usage.json
sessions/    <num>-<email-slug>/
```

## Testing conventions

[tests/conftest.py](tests/conftest.py) is ~900 lines of mostly *safety net*, and its guards have already caught real incidents (the developer's actual account store being overwritten by test data). Understand these before writing tests:

- **A process-global `sys.addaudithook`** refuses any write to the real account-store roots, raising `RealStoreWriteBlocked` — deliberately *not* an `OSError` subclass, because `Path.mkdir(exist_ok=True)` swallows those. It cannot be uninstalled, which is the point: fixture-based isolation unwinds at teardown, and this repo's tests spawn threads that outlive their own test.
- **Autouse fixtures** isolate `$HOME`/`USERPROFILE`/`Path.home()`, neutralize `CLAUDE_CONFIG_DIR`/`CLAUDE_SECURESTORAGE_CONFIG_DIR`/`XDG_DATA_HOME`, fake the macOS Keychain in memory, stub `oauth.fetch_oauth_profile`, zero poll jitter, and pin terminal colour. Opt out only via the declared markers (`no_keychain_fake`, `no_oauth_profile_fake`).
- Patching `Path.home()` is **not** a superset of patching `XDG_DATA_HOME` — on Linux the env var wins. Harnesses that build a real switcher patch both (see `EngineHarness` in [tests/test_autoswitch.py](tests/test_autoswitch.py)).
- TUI tests drive the real Textual app headlessly with `Pilot` against a `FakeSwitcher` implementing exactly the structured surface the TUI consumes.

## Code style

The distinguishing convention here is **comments that record evidence, not intent**: measured numbers, dates, platform, commit/PR/issue references, and what the obvious alternative did wrong. `poll_policy.py`, `claude_locks.py`, the `macos-keychain` CI job, and the `pytest addopts` note are all examples. When you change behavior in these areas, update the evidence with your own measurement rather than deleting it — and if a comment says "a merge that restores X re-opens this hole invisibly", believe it.

Otherwise: `from __future__ import annotations` everywhere, module docstrings that state the module's job and its layering constraints, typed dataclasses (frozen for read models), and the `ClaudeSwitchError` hierarchy in [exceptions.py](src/claude_swap/exceptions.py) for anything the CLI should render as a clean error instead of a traceback.

## Caution when running the tool locally

`cswap add`, `switch`, `remove`, and `purge` mutate the real Claude Code login and the real account store on this machine. Prefer `cswap list` / `status` / `config` when verifying, and never run `purge`.
