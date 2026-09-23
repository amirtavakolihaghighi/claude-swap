# Claude Swap for VS Code

[![VS Code extension CI](https://github.com/amirtavakolihaghighi/claude-swap/actions/workflows/vscode-extension.yml/badge.svg)](https://github.com/amirtavakolihaghighi/claude-swap/actions/workflows/vscode-extension.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/amirtavakolihaghighi/claude-swap/blob/main/vscode-extension/LICENSE)
![Version](https://img.shields.io/badge/version-0.1.0-orange.svg)

**You hit your Claude Code limit mid-conversation, and now you have to open a
terminal, remember a command, and start again.** This puts your accounts in the
status bar instead: see how much quota each one has left, switch with a click, and
optionally let it switch for you *before* you get cut off — with no terminal window
open.

Your conversations are never touched. Switching changes which account you are logged
in as, nothing else, so `Resume` picks up exactly where you were.

> This is a front-end for the [claude-swap](https://github.com/realiti4/claude-swap)
> CLI, which does all the real work. The extension never touches your credentials
> itself — it runs claude-swap's documented `--json` commands and renders the
> results. Credential handling, token refresh, lock cooperation and the usage-API
> rate budget are all subtle enough that duplicating any of it here would be a bug
> waiting to happen.

## What you get

**In the status bar** — every account at a glance: `#2 58% | #1 61%`. Amber at 75%,
red at 90%. Hover for the full picture: 5-hour, weekly and per-model windows, reset
countdowns, pace markers and warnings.

**A sidebar panel** with usage bars per account, expandable to individual windows,
and an inline button to switch.

**Click to switch** — a specific account, or whichever has the most quota left.

**Background auto-switch** (off by default) moves you to a better account before the
active one hits its limit. Same engine as `cswap auto`, so nothing is duplicated,
and it needs no terminal window. Turn it on with *Claude Swap: Toggle Background
Auto-Switch*.

**Rescue** — for when a limit already interrupted you. Switches to the best account
and reloads the window in one step, so the open Claude tab picks up the new login.

### Things it tells you that you would otherwise find out the hard way

- **A per-model limit is your real limit.** You can be blocked by the weekly Fable
  or Opus limit while your account-level number still reads 30%. The account
  percentage hides this completely. The status bar flags it, and tells you how to
  make auto-switch account for it.
- **Quota is back.** When every account is spent you get told, with a countdown —
  and told again the moment one frees up, with a button to switch straight to it.
- **How long have you got?** *Claude Swap: How Fast Am I Using Quota?* estimates your
  consumption rate from readings taken on this machine and turns it into plain
  minutes: "burning ~9%/h · about 2h 40m of headroom". Useful before starting
  something long.
- **A login is about to expire.** Stored logins eventually die and need a browser to
  fix. You get a few days' warning instead of discovering it when you switch.
- **A weekly budget will not last.** When an account is projected to exhaust its
  weekly quota before it resets. A rough linear projection — treated as a hint, not
  a fact, which is why the CLI keeps it out of its own output.

## Requirements

- [claude-swap](https://github.com/realiti4/claude-swap) installed, with at least one
  account added (`cswap add`).
- The extension finds `cswap` on your PATH, in the usual `uv`/`pipx` locations, or in
  a `.venv` inside a **trusted** workspace. Otherwise set
  `claudeSwap.executablePath`.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `claudeSwap.executablePath` | `""` | Full path to `cswap`. Empty = search automatically. |
| `claudeSwap.refreshIntervalSeconds` | `60` | Status bar refresh rate. |
| `claudeSwap.statusBar.showAllAccounts` | `true` | Show every account inline, not just the active one. |
| `claudeSwap.autoSwitch.enabled` | `false` | Background auto-switching. |
| `claudeSwap.autoSwitch.intervalSeconds` | `60` | How often it checks. |
| `claudeSwap.autoSwitch.notify` | `true` | Notify when it switches you. |
| `claudeSwap.notifyOnReset` | `true` | Notify when all accounts are spent, and when quota returns. |
| `claudeSwap.warnLoginExpiryDays` | `3` | Days of warning before a login expires. `0` disables. |
| `claudeSwap.showPaceWarnings` | `true` | Weekly burn-rate warnings. |

### Why a faster refresh will not help

Anthropic's usage endpoint allows roughly 28–30 requests per hour per account, and
claude-swap paces its own network calls to stay well under that. Lowering
`refreshIntervalSeconds` mostly just re-reads claude-swap's cache — it does **not**
get you fresher numbers. 60 seconds is already faster than the data changes.

Auto-switch policy (threshold, cooldown, strategy) is deliberately **not** duplicated
in these settings. There should be one source of truth, so change it through the CLI
and both this extension and `cswap auto` follow:

```bash
cswap config set autoswitch.threshold 80
cswap config set autoswitch.strategy consume-first
cswap config set autoswitch.model Fable      # count a per-model limit too
```

## Security

This extension executes the `cswap` binary, so two things are deliberate:

- `claudeSwap.executablePath` has `"scope": "machine"` — a workspace **cannot** set
  it. Only you can, in your own settings.
- Looking for `cswap` inside an opened folder is gated on VS Code's Workspace Trust.
  Without that, opening an untrusted repository containing `.venv/Scripts/cswap.exe`
  would cause this extension to run it.

It stores usage history (percentages and timestamps) in VS Code's `globalState`, and
**no credentials**. See [SECURITY.md](https://github.com/amirtavakolihaghighi/claude-swap/blob/main/SECURITY.md) for the full picture, including
the important detail that claude-swap stores tokens as base64 on Windows and Linux —
which is an encoding, not encryption.

## Building from source

```bash
cd vscode-extension
npm install
npm test                 # compiles, then runs the analysis tests
npm run package          # produces claude-swap-vscode-<version>.vsix
code --install-extension claude-swap-vscode-0.1.0.vsix
```

Zero runtime dependencies. Pure logic lives in `src/analysis.ts`, which has no
`vscode` import so it can be tested with Node's built-in test runner.

## License

MIT. The extension is © Amir Tavakoli Haghighi; the claude-swap CLI it drives is
© Onur Cetinkol and contributors. See [LICENSE](https://github.com/amirtavakolihaghighi/claude-swap/blob/main/vscode-extension/LICENSE).
