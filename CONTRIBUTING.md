# Contributing to gpu.nz Code

Thank you for looking. gpu.nz Code is a fork of [OpenCode](https://github.com/anomalyco/opencode): everything that
is not about renting a model (the agent, its tools, the interface of sessions) is upstream code, and the best place
to improve it is upstream — we merge their releases.

Ours is small and listed in [GPUNZ.md](GPUNZ.md): `packages/desktop/src/main/gpunz/` (the gpu.nz API client, the
session, the bridge, updates, error reports) and `packages/desktop/src/renderer/gpunz/` (our screens).

- **A bug or an idea:** the quickest way is «Help and feedback» inside the app; an
  [issue](https://github.com/gpunz/gpunz-code/issues) here works too.
- **A pull request:** keep it small and about one thing; say what you checked. Before sending:
  `cd packages/desktop && bun test src/main/gpunz && bun run typecheck`.
- **Strings** of our screens are in `packages/desktop/src/renderer/gpunz/i18n.ts` (Russian and English).
- Every change is reviewed and every release is approved by the gpu.nz team by hand.
