# Upstream merge prompt

Copy everything in the box below into a **new, empty Claude Code chat** opened in
this repository. It is written to be self-contained — a fresh session needs no
other context.

---

```
This repository is my fork of realiti4/claude-swap. The `fork-tools/check-upstream.ps1`
script has told me the original repository has new commits. Please review them and,
if they are safe, merge them.

Background you need:

- `upstream` = the original repo (realiti4/claude-swap). `origin` = my fork.
- Most of MY OWN work lives in two top-level directories that upstream has never
  used, so they can never conflict:
    - `vscode-extension/`  — a VS Code extension I built (TypeScript)
    - `fork-tools/`        — this update-checking tooling
- I have also ADDED these files at the root, which upstream does not have. If
  upstream ever adds a file of the same name, mine and theirs both have a claim and
  you must ask me rather than silently picking one:
    - `CLAUDE.md`, `.gitattributes`, `.editorconfig`, `SECURITY.md`,
      `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
      `.github/PULL_REQUEST_TEMPLATE.md`, `.github/workflows/vscode-extension.yml`
- I have MODIFIED exactly one upstream file: **`README.md`**, which now carries a
  short "This is a fork" block after the opening paragraph, pointing at the
  extension. If upstream changed its README, expect a conflict here: **keep my fork
  block AND take upstream's changes**. Do not drop either.
- `src/`, `tests/` and `pyproject.toml` are upstream's and must stay byte-identical.
  Verify that with `git diff --stat <merge-base> HEAD -- src tests pyproject.toml`,
  which should print nothing. If it prints something, stop and tell me.
- The VS Code extension shells out to the `cswap` CLI and parses its `--json`
  output. It does NOT import any Python. Its only coupling to upstream is that
  JSON contract, which upstream documents as additive-only in
  `src/claude_swap/json_output.py`.

Please do this, in order:

1. Run `.\fork-tools\check-upstream.ps1` and read `fork-tools/.upstream-report.md`.

2. Show me what changed upstream. Group the commits by theme rather than listing
   them one by one, and for each theme say in plain language what it does and
   whether it affects me. I am not a developer — explain it accordingly.

3. Assess the risk specifically for my extension. These are the things that
   actually matter, in priority order:
   a. Did `src/claude_swap/json_output.py` change? If so, did any EXISTING field
      change shape or meaning, or was `SCHEMA_VERSION` bumped? Additive new
      fields are harmless; a changed or removed field is not.
      My extension reads these fields, so check each one that changed:
      list: schemaVersion, activeAccountNumber, accounts[].{number, email,
      organizationName, organizationUuid, active, usageStatus, usage, alias,
      disabled, loginExpiresAt, usageFetchedAt, usageAgeSeconds, lastGoodUsage,
      lastGoodAgeSeconds, usageError}
      usage windows: {pct, resetsAt, countdown, clock, name, expectedPct,
      aheadOfPace, projectedExhaustionAt, willLastToReset}
      status: active.{number, email, usageStatus, usage}
      switch: {switched, from, to, reason, message, warnings}
      auto (JSONL): {event, ts, active, from, to, reason, detail, message,
      threshold, headroomPct, windowsPct}
   b. Did the CLI's command surface change — were `list`, `status`, `switch`,
      `auto --once`, `config get`, or `map` renamed, or did their flags change?
   c. Did the exit codes of `auto --once` change? My extension relies on
      0=switched, 1=error, 2=nothing-to-do, 3=blocked.
   d. Did anything change about how accounts are stored or switched that I should
      know about as a user (new settings, new warnings, changed defaults)?

4. Tell me whether you recommend merging, and say plainly if you found anything
   that looks risky or that would break the extension. If it is not safe, stop
   here and explain what you'd need to change first.

5. If it IS safe and I say go ahead, then:
   - Merge with `git merge upstream/main`.
   - If there are conflicts, resolve them using the ownership rules above:
     `vscode-extension/`, `fork-tools/` and my added root files are mine;
     `src/`, `tests/` and `pyproject.toml` are upstream's; `README.md` keeps
     both sides.
   - If the JSON contract changed in a way that affects the extension, update
     `vscode-extension/src/types.ts` and whatever else needs it to match. Any pure
     logic belongs in `vscode-extension/src/analysis.ts`, which has tests.
   - If upstream changed behaviour worth documenting, update `CLAUDE.md`.

6. Verify before you tell me it worked — do not skip this:
   - `.venv\Scripts\python -m pytest` (the upstream Python test suite). Note that
     `uv` is NOT installed on this machine. The expected baseline on this Windows
     box is **2186 passed, 4 failed, 81 skipped** — the 4 failures are symlink tests
     that Windows blocks without Developer Mode and are NOT caused by any change.
     Treat only NEW failures as real.
   - `cd vscode-extension; npm test` (compiles the extension AND runs its 37
     analysis tests).
   Report the actual numbers. If something fails, say so and show the output.

7. If everything passes, commit the merge and push to `origin`. Then tell me
   whether I need to rebuild and reinstall the extension — and if so, give me
   the exact commands.

Do not push anything until step 6 passes.
```

---

## How to run the check

Manually, whenever you feel like it:

```powershell
.\fork-tools\check-upstream.ps1
```

Automatically, once a day, with no window popping up — create a Windows
Scheduled Task:

Run this from the repository root — `$PWD` fills in the path, so there is nothing
to edit by hand:

```powershell
$script = Join-Path $PWD 'fork-tools\check-upstream.ps1'
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -WindowStyle Hidden -File `"$script`" -Quiet"
$trigger = New-ScheduledTaskTrigger -Daily -At 10am
Register-ScheduledTask -TaskName "claude-swap upstream check" `
  -Action $action -Trigger $trigger -Description "Check for claude-swap updates"
```

With `-Quiet` the task is silent when there is nothing new. To see the last
result, read `fork-tools\.upstream-report.md` — it is only rewritten when updates
are actually found, so its timestamp tells you when something last landed.

If you would rather be actively notified than have to look, run the script
without `-Quiet` from a shortcut you click, or ask Claude to add a toast
notification to it.
