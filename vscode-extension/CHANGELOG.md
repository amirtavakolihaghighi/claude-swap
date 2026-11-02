# Changelog

All notable changes to the Claude Swap VS Code extension are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file covers **the extension only**. The core `cswap` CLI is maintained
[upstream](https://github.com/realiti4/claude-swap) and versioned separately.

## [Unreleased]

## [0.2.1] - 2026-11-02

### Fixed

- The background work separate folder logins start with the extension (the launcher
  check, keeping login folders in step, and updating which buttons show) now logs a
  failure instead of leaving it unhandled.
- The per-model verification check (`fork-tools/verification/per-model-rendering.js`)
  failed on every CI runner with 0.2.0. Its stub VS Code lacked the APIs the Windows
  view uses at activation. It now has them, and it no longer writes into the real
  data root.

## [0.2.0] - 2026-11-02

### Added

- **Separate folder logins** (Windows). Claude tabs in a chosen folder use their own
  login for an account, while every other window keeps the main login and follows
  it when you switch. Anthropic's Claude extension can start Claude through a
  program named in `claudeCode.claudeProcessWrapper`. Claude Swap builds such a
  launcher with the C# compiler that ships with .NET Framework 4, and points the
  setting at it. In a folder you set up, the launcher sets `CLAUDE_CONFIG_DIR` to
  that folder's login folder; everywhere else it changes nothing. The Claude
  extension then shows that login, its sign-in screen and its history, in that
  window only, because it follows the config home `claude auth status` reports.
  - The folder's login is a separate sign-in, not a copy of the saved one, so the
    main login and a folder can use the same account at once. A copied login would
    break at the first renewal, because renewal tickets work once.
  - Shared with other windows: conversations, Claude's project notes and rewind
    checkpoints (directory junctions, which need no admin rights), settings and
    hooks, CLAUDE.md and user-level MCP servers. Kept separate: the login, and the
    skills and plugins claude.ai syncs to each account.
  - Commands: *Turn On / Turn Off Separate Folder Logins*, *Use a Separate Login in
    This Folder…*, *Stop Using the Separate Login in This Folder…*. Each confirms
    first and says what changes and any side effects.
- **Windows view** in the sidebar. Every open VS Code window, the same in each one:
  which login its Claude tabs use, whether a separate login is signed in (and as
  whom, and for how many more days), how many Claude tabs run there, and a button
  to bring it to the front.
- **Help.** *Claude Swap: Help* (also the ? button and the Help link in the hover
  box) opens a page describing every command, view, message and setting: what it
  does, what you will see, and anything risky or lasting. Every setting's
  description now follows the same pattern, and every sidebar row explains itself
  on hover.
- Warnings for a separate login that signed in with the wrong account, or is about
  to end.

### Changed

- Turning on background auto-switch and clearing usage history now ask first,
  saying what will happen.
- *Bind This Folder to an Account* is renamed *Bind Folder for Terminal Sessions
  (cswap run)*, since it only ever affected `cswap run`, not Claude tabs.

### Notes

- Verified on Windows 10 against Claude Code 2.1.314, with the real bundled
  `claude.exe` run through the launcher: a set-up folder reports its own login
  folder as `configDirectory` (not signed in), and any other folder still reports
  `~\.claude` (signed in).
- The launcher hands claude only its three standard handles. Plain inheritance
  leaked a second reference to the extension's output pipe into programs claude
  starts. Measured 2026-11-02: under the launcher, a background program kept the
  session's output open for its whole 6 s life; without the launcher, 1 ms. The
  launcher's tests now guard this.
- Deleting a login folder never follows a link: its tests delete one that links
  to a sample conversation history and check that history is intact.

## [0.1.3] - 2026-11-02

### Added

- **Save Current Login** — after signing in to Claude again, or with a new
  account, one click stores that login in claude-swap. It runs `cswap add`, which
  updates the signed-in account in place, or adds it when claude-swap does not
  know it, and refuses a login that does not match the signed-in account. Offered
  as the key icon in the sidebar's title bar, *Save login* in the hover box, and
  the command palette.
- **It offers itself.** A fresh sign-in to a known account moves that account's
  `loginExpiresAt` later — the date is otherwise fixed for a login's whole life —
  and a sign-in to an account claude-swap does not know leaves no account active.
  Either way a notification offers to save it. claude-swap often saves a fresh
  sign-in by itself, but only once Anthropic confirms whose it is, and on a flaky
  connection that check often fails.

### Changed

- Every "run `cswap add` in a terminal" instruction now points to the button: the
  sidebar, the hover box, the login-expiry warning and the account picker.
- The sidebar's failed-check line uses the plain words the hover box got in 0.1.2.

### Fixed

- The account picker, *Bind This Folder* and *How Fast Am I Using Quota?* load
  data first when there is none yet, and since 0.1.2 that popped up the Refresh
  summary as well. Only the Refresh command reports now.

## [0.1.2] - 2026-11-02

### Changed

- **Refresh says what it found.** A click now ends with a short message giving
  each account's reading age — "#2 (active) was checked just now. #1 was checked
  4m ago." — and, for a check that failed, the reason in plain words, how old the
  numbers on screen are and when the next try is ("a network problem reaching
  Anthropic — showing numbers from 25m ago, next try in about 3m"). Refresh cannot
  force new numbers: claude-swap serves its latest reading until the account's next
  scheduled check, because Anthropic allows only about 30 usage checks an hour per
  account. So a click usually changed nothing on screen, and looked broken.
- The tooltip's failure line uses the same plain words instead of codes like
  `http-429`.

### Fixed

- **A click on Refresh during a background refresh was dropped without a word.**
  It now waits for the refresh already running ("Checking usage…" in the status
  bar) and reports what it found. A `cswap list` waiting out a network timeout can
  take many seconds, so this was easy to hit.

## [0.1.1] - 2026-11-02

### Changed

- **Clearer message after a switch.** On Windows and Linux the popup now says the
  new account is already active — "your next message in any Claude tab uses it" —
  and no longer offers a *Reload window* button. The button made the switch look
  unfinished (a user asked whether it was active at all), yet it never did anything
  there: Claude Code re-reads a file-based login when the file changes, so every
  open tab is on the new account from its next message. macOS keeps the button,
  because Claude Code caches the Keychain for about 30 seconds. The background
  auto-switch notification follows the same rule.

### Notes

- Checked against claude-swap 0.29.0, merged from upstream the same day: the
  `--json` output this extension reads only gained an optional per-account
  `threshold` field, the commands it runs are unchanged, and so are the
  `auto --once` exit codes.

## [0.1.0] - 2026-09-25

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

[Unreleased]: https://github.com/amirtavakolihaghighi/claude-swap/compare/vscode-extension-v0.2.1...HEAD
[0.2.1]: https://github.com/amirtavakolihaghighi/claude-swap/releases/tag/vscode-extension-v0.2.1
[0.2.0]: https://github.com/amirtavakolihaghighi/claude-swap/releases/tag/vscode-extension-v0.2.0
[0.1.3]: https://github.com/amirtavakolihaghighi/claude-swap/releases/tag/vscode-extension-v0.1.3
[0.1.2]: https://github.com/amirtavakolihaghighi/claude-swap/releases/tag/vscode-extension-v0.1.2
[0.1.1]: https://github.com/amirtavakolihaghighi/claude-swap/releases/tag/vscode-extension-v0.1.1
[0.1.0]: https://github.com/amirtavakolihaghighi/claude-swap/releases/tag/vscode-extension-v0.1.0
