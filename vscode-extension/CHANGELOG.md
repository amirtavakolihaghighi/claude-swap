# Changelog

All notable changes to the Claude Swap VS Code extension are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file covers **the extension only**. The core `cswap` CLI is maintained
[upstream](https://github.com/realiti4/claude-swap) and versioned separately.

## [Unreleased]

## [0.1.0] - 2026-09-23

First working version.

### Added

- **Status bar** showing the active account and its most-consumed usage window,
  amber from 75% and red from 90%. With four accounts or fewer it shows every
  account at once (`#2 58% | #1 61%`), controlled by
  `claudeSwap.statusBar.showAllAccounts`.
- **Hover tooltip** with each account's 5-hour, weekly and per-model usage, reset
  countdowns, pace markers and warnings, plus one-click actions.
- **Switch accounts** from the status bar — a specific account, or whichever has
  the most quota left.
- **Sidebar panel** (activity bar) listing accounts with usage bars, expandable to
  individual windows, with an inline switch button.
- **Background auto-switch**, off by default, which moves you off an account before
  it reaches its limit without a terminal window open. Runs `cswap auto --once` and
  takes its threshold, cooldown and strategy from claude-swap's own settings, so
  there is one source of truth shared with the CLI.
- **Rescue** command: switch to the account with the most quota and reload the
  window in one step, for when a limit has already interrupted you.
- **Per-model limit warning.** A weekly per-model window (for example Fable) can be
  far further along than the account-level windows, in which case it — not the
  account percentage — is what will actually stop you. The status bar flags it, and
  the notification explains that auto-switch ignores per-model windows until
  `autoswitch.model` names one.
- **Reset alarm.** Notifies when every account is spent, and again the moment quota
  becomes available, with a button to switch straight to the account that has room.
- **Burn rate.** Records usage readings locally and estimates how fast the 5-hour
  window is being consumed, answering "how long have I got?" via
  *Claude Swap: How Fast Am I Using Quota?*. Rates are scoped to a single window
  generation, so a window resetting is not read as negative consumption.
- **Login-expiry warning** a configurable number of days before a stored account's
  refresh token expires and needs a fresh `/login`.
- **Weekly pace warning** when an account is projected to exhaust its weekly quota
  before that quota resets.
- **Bind this folder to an account**, wrapping `cswap map`.
- Commands to open the full terminal dashboard, show logs, and clear usage history.
- **One window runs the auto-switch timer.** Every open VS Code window loads its own
  copy of this extension, so N windows would otherwise spawn N `cswap auto --once`
  processes on the same schedule. A lease file in global storage elects a single
  leader; the rest stand down, and an abandoned lease is taken over after four
  minutes. claude-swap's own locking remains the correctness boundary; this removes
  the redundant work and the narrow case that its cooldown deliberately bypasses
  (`at-limit` and `failover`, where an account already at its limit must move
  regardless of how recently anything moved).

### Security

- `claudeSwap.executablePath` is declared `"scope": "machine"`, so a workspace
  cannot set the path to a binary this extension executes.
- Discovery of `cswap` inside an opened folder is gated on VS Code's Workspace
  Trust. Without that gate, opening an untrusted repository containing
  `.venv/Scripts/cswap.exe` would have caused the extension to execute it.

### Notes

- Requires the [claude-swap](https://github.com/realiti4/claude-swap) CLI. The
  extension is a front-end and duplicates none of its account, credential or
  rate-limit logic.
- Zero runtime dependencies.
- The per-model warning was verified end to end (status bar, tooltip, sidebar and
  notification) against a payload whose shape is taken from upstream's own API test
  fixture: account weekly at 72% with the per-model Fable window at 100%. It has
  still not been seen against a live account that reports per-model windows, because
  neither account on the development machine does.
- Cross-process claims were measured rather than assumed, on Windows, 2026-09-24:
  claude-swap's `FileLock` strictly serialised 5 competing processes with no
  interleaving, and the leader lease elected exactly 1 leader from 8 simultaneous
  processes across 5 consecutive runs.

[Unreleased]: https://github.com/amirtavakolihaghighi/claude-swap/compare/vscode-extension-v0.1.0...HEAD
[0.1.0]: https://github.com/amirtavakolihaghighi/claude-swap/releases/tag/vscode-extension-v0.1.0
