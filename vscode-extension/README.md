# Claude Swap for VS Code

Switch Claude Code accounts from the status bar, see how much quota each account
has left, and optionally let it switch for you before you hit a limit — without
keeping a terminal window open.

This is a thin front-end for the [claude-swap](https://github.com/realiti4/claude-swap)
CLI, which does all the actual work. The extension never touches your credentials
itself; it runs `cswap`'s documented `--json` commands and renders the results.

## What it gives you

**In the status bar** — the active account and its tightest usage window, e.g.
`#2 · 5h 19%`. It turns amber at 75% and red at 90%. Hover for every account's
5-hour, weekly and per-model usage, reset countdowns, and any warnings.

**Click it** to switch accounts. Pick a specific account, or let claude-swap pick
whichever has the most quota left.

**Background auto-switch** (off by default) — checks every minute and moves you to
a better account before the active one hits its limit. This is the same engine
`cswap auto` runs, so nothing is duplicated, and it needs no terminal window.
Turn it on with *Claude Swap: Toggle Background Auto-Switch*, or the
`claudeSwap.autoSwitch.enabled` setting.

**Rescue** (*Claude Swap: Rescue*) — for when you've already been cut off
mid-conversation. Switches to the best account and reloads the window in one step,
so the open Claude tab picks up the new login. Your conversation history is
untouched; use Resume afterwards to carry on.

**Warnings you'd otherwise find out about the hard way:**

- **Login expiry.** A stored account's refresh token eventually dies, and fixing
  it needs a browser. You get told a few days ahead instead of at the moment you
  try to switch to it.
- **Weekly pace.** When an account is burning weekly quota fast enough to run out
  before its reset, you hear about it once a day. This is a rough linear
  projection — the CLI deliberately keeps it out of its own output for that
  reason — so treat it as a hint, not a fact.

**Bind a folder to an account** (*Claude Swap: Bind This Folder to an Account*) —
wraps `cswap map`, so `cswap run` in that folder launches the right account.

## Requirements

- [claude-swap](https://github.com/realiti4/claude-swap) installed, with at least
  one account added (`cswap add`).
- The extension finds `cswap` on your PATH, in the usual `uv`/`pipx` install
  locations, or in a `.venv` inside an open workspace folder. If it can't, set
  `claudeSwap.executablePath` to the full path.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `claudeSwap.executablePath` | `""` | Full path to `cswap`. Empty = search automatically. |
| `claudeSwap.refreshIntervalSeconds` | `60` | Status bar refresh rate. |
| `claudeSwap.autoSwitch.enabled` | `false` | Background auto-switching. |
| `claudeSwap.autoSwitch.intervalSeconds` | `60` | How often it checks. |
| `claudeSwap.autoSwitch.notify` | `true` | Notify when it switches you. |
| `claudeSwap.warnLoginExpiryDays` | `3` | Days of warning before a login expires. `0` disables. |
| `claudeSwap.showPaceWarnings` | `true` | Weekly burn-rate warnings. |

### A note on refresh rates

Lowering `refreshIntervalSeconds` does **not** get you fresher numbers. Anthropic's
usage endpoint allows only about 28–30 requests per hour per account, and
claude-swap paces its own network calls to stay well under that — so a faster
refresh here mostly just re-reads claude-swap's cache. The default of 60 seconds
is already faster than the data changes.

Auto-switch policy (threshold, cooldown, strategy) is **not** duplicated in this
extension's settings on purpose — there should be one source of truth. Change it
through the CLI and both this extension and `cswap auto` follow:

```
cswap config set autoswitch.threshold 80
cswap config set autoswitch.strategy consume-first
```

## Building and installing from source

```bash
cd vscode-extension
npm install
npm run compile
npm run package          # produces claude-swap-vscode-<version>.vsix
code --install-extension claude-swap-vscode-0.1.0.vsix
```

## License

MIT, same as the parent project.
