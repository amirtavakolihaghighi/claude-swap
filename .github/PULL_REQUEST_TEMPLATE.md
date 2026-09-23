## What this changes

<!-- What it does and why. If it fixes an issue, link it. -->

## Which part of the repository

- [ ] `vscode-extension/` — the VS Code extension
- [ ] `fork-tools/` — upstream tracking tooling
- [ ] Core claude-swap (`src/`, `tests/`) — **see note below**

> Changes to `src/` or `tests/` belong upstream at
> [realiti4/claude-swap](https://github.com/realiti4/claude-swap), not here. This
> fork deliberately keeps those directories identical to upstream so that merging
> upstream stays trivial. If you have a core fix, please open it there.

## Checks

- [ ] `cd vscode-extension && npm test` passes (compiles, and the analysis tests run)
- [ ] If the JSON that `cswap` emits is parsed differently, `src/types.ts` was updated to match
- [ ] No absolute personal paths, emails or credentials added
