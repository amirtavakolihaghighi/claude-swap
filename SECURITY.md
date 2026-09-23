# Security

## What this repository is

This is a fork of [realiti4/claude-swap](https://github.com/realiti4/claude-swap).
It adds a VS Code extension (`vscode-extension/`) and upstream-tracking tooling
(`fork-tools/`); the core tool under `src/` is upstream's, unmodified.

**Report vulnerabilities in the core tool to
[upstream](https://github.com/realiti4/claude-swap/security), not here** — that is
where they can be fixed for everyone. Report problems with the VS Code extension
or the fork tooling in this repository.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository's **Security** tab.
Please do not open a public issue for something exploitable. If private reporting
is unavailable, open an issue saying only that you have found a security problem
and asking for a private channel — no details.

Expect a first response within a week. This is a personal project, not a funded
one; there is no bounty.

## What this software actually touches

Being specific matters more than reassurance, so:

- **OAuth refresh tokens for your Claude accounts.** claude-swap's whole purpose is
  storing and swapping them. On macOS they go in the Keychain. **On Windows and
  Linux they are stored as base64 `.enc` files** under the backup directory —
  base64 is an encoding, **not encryption**. Anyone who can read your home
  directory can recover those tokens. This is upstream's documented design, not a
  defect, but it is the single most important thing to understand: the security of
  your accounts rests on the security of your user account and disk.
- **`cswap export` writes plaintext JSON containing credentials.** Treat an export
  file exactly as you would a password. Encrypt it yourself if it leaves the
  machine (`cswap export - | gpg -c > backup.gpg`).
- **Your active Claude Code login.** Switching rewrites `~/.claude.json` and the
  credential store. A bug here logs you out, or crosses two accounts' credentials.
- **The network.** claude-swap calls Anthropic's OAuth token endpoint and its usage
  endpoint, identifying itself as `claude-swap/1.0`. The VS Code extension makes no
  network calls of its own.

## The VS Code extension specifically

The extension executes the `cswap` binary and parses its JSON output. Two
consequences were designed around:

- **`claudeSwap.executablePath` is a path this extension will execute.** It is
  therefore declared `"scope": "machine"`, which means a workspace
  (`.vscode/settings.json` in a repository you opened) **cannot** set it. Only you
  can, in your user or machine settings. If you change this, do not weaken that
  scope.
- **Automatic discovery of `cswap` inside an opened folder is gated on VS Code's
  Workspace Trust.** The extension will look for `.venv/Scripts/cswap.exe` in your
  workspace as a convenience for development, but only in a trusted workspace.
  Without that gate, opening any untrusted repository containing a file at that
  path would cause this extension to run it.

The extension stores usage history (percentages and timestamps) in VS Code's
`globalState`. It stores **no credentials** and never reads the credential store
directly.

## What this cannot protect against

- Anyone with read access to your user account on the machine, on Windows and Linux
  (see base64 above).
- Malware running as you. It can read the same files claude-swap does.
- Full-disk backups, sync clients, or anything else that copies your home directory
  off the machine.
- A compromised Anthropic account. Rotate by logging out everywhere and re-adding.

## If a token leaks

Deleting a file does not un-leak it. Log out of the affected Claude account to
invalidate the refresh token, log back in, then re-add the account with
`cswap add --slot N`.
