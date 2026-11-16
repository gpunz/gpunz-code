# gpu.nz Code

A desktop coding agent that rents its own model: sign in with a gpu.nz account, pick a model, and the app starts a
GPU server at [gpu.nz](https://gpu.nz), waits for the model and opens the agent with everything configured.

**Built on [OpenCode](https://github.com/anomalyco/opencode) v1.19.5 (MIT). This project is not built by the
OpenCode team and is not affiliated with it.** The upstream licence is in `LICENSE`.

## What is ours

| Where | What |
|---|---|
| `packages/desktop/src/main/gpunz/` | the gpu.nz API client, the key vault (OS keychain), the local bridge to the rented model, the session (launch, relaunch on another server, keepalive, delete), the controller and IPC |
| `packages/desktop/src/renderer/gpunz/` | our screens: sign in, model picker (tested models and «your own model»), launch progress, the session pill in the title bar |
| `packages/desktop/src/main/index.ts` | start-up order: the window first, the agent server once a model answers (or «open without a model») |
| `packages/ui/src/theme/themes/oc-2.json` | the default dark theme in the gpu.nz console palette  |
| `packages/ui/src/components/logo.tsx`, `packages/desktop/icons/` | the gpu.nz mark and icons |
| `packages/app/src/i18n/*`, `packages/desktop/electron-builder.config.ts` | the product name, ids (`nz.gpu.code`), the `gpunzcode://` scheme, packaging |

Everything else is upstream. Keep it that way: an upstream security fix should merge cleanly.

## How it works

```
gpu.nz Code (Electron)
 ├─ our screens ── gpu.nz API (device login, /offers/pick, POST /instances offer_id:"auto", keepalive)
 ├─ agent (OpenCode server + UI), configured with ONE provider:
 │      http://127.0.0.1:<port>/v1  ← the local bridge (main process)
 └─ bridge ── https://<id>-21434.run.gpu.nz/v1 (the rented server, the rental's key)
```

- The agent runs on the user's computer; only model requests leave it. The server holds nothing of the user's, so it
  is deleted, not stopped.
- The bridge is why the server can change under a running agent (a host died → another server, the same
  conversation), why the rental's key is never written to the agent's files, and where «in use» is measured.
- The service deletes a server whose client stopped saying «in use» (`idle_stop_minutes` + keepalive), so a closed
  laptop does not bill all night.
- Destructive shell commands ask first (`agent-config.ts` `ASK_BEFORE`).
- The upstream updater, release notes, provider catalogue and WSL servers are off: the app must never update itself
  from, or send users to, a project that is not ours.

## Security decisions (review of 2026-11-12)

- **No link scheme.** Upstream's `opencode://` links open any folder as a project and prefill a prompt, and a
  project's own config starts programs (MCP servers, plugins). `gpunzcode://` is not registered and links are
  ignored; nothing of ours needs them (sign-in is a code confirmed in the browser).
- **The account key** lives in the main process only, encrypted by the operating system (`vault.ts`); where the
  system has no real encryption it is kept in memory and never written down. It is sent to `https://gpu.nz` only
  (`GPUNZ_API_URL` is honoured in development runs only). The page's generic key-value IPC cannot name the account
  store or a path. Our own IPC channels answer the app's page in a window's top frame only.
- **A server's key** goes to `https://*.run.gpu.nz` only (`isGatewayUrl`), through the local bridge (127.0.0.1,
  random port, its own key on every request).
- **Money.** A server that never answers is deleted after 30 minutes; a delete that fails is retried in the
  background with the same key; at most three servers are replaced without asking in an hour; errors of the
  service never leave a server unwatched (`session.ts`, tests next to it).
- **The agent asks first** before destructive commands, wrapped or piped ones (`bash -c`, `powershell`, `| sh`),
  and before writing files that something runs later (`.opencode/`, `opencode.json`, `.git/`, editor tasks) —
  `agent-config.ts`. These are patterns over the command text: a speed bump against a model led astray by text it
  read, not a sandbox.
- **Packaging.** Electron fuses: no `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `--inspect`; code only from the asar.
- **Updates** come from our feed only and are installed only with a valid signature of our release key (see
  «Releases and updates»).
- Known and open: no content security policy in the page; upstream's WSL handlers are still registered (the tab is
  hidden); a folder the person opens themselves is trusted with its own config, as upstream does; builds are not
  signed with a paid certificate yet (macOS builds carry an ad hoc signature).

## Build (Windows, macOS, Linux)

Needs Bun 1.4.4 (the version upstream pins) and Node 24.

```sh
bun install --ignore-scripts            # tree-sitter-powershell wants a C++ toolchain; only its .wasm is used
cd packages/desktop && node node_modules/electron/install.js

# the agent server bundle (no upstream model catalogue: ours is the only provider)
cd ../opencode
OPENCODE_VERSION=1.19.5 OPENCODE_CHANNEL=prod MODELS_DEV_API_JSON=/path/to/empty.json bun script/build-node.ts   # empty.json: {}

cd ../desktop
OPENCODE_CHANNEL=prod bun ./scripts/copy-icons.ts prod && OPENCODE_CHANNEL=prod bun ./scripts/copy-metainfo.ts prod
OPENCODE_VERSION=1.19.5 OPENCODE_CHANNEL=prod npx electron-vite build
OPENCODE_CHANNEL=prod npx electron-builder --win --x64 --publish never --config electron-builder.config.ts   # or --mac / --linux
```

Artifacts land in `packages/desktop/dist/` (`gpunz-code-win-x64.exe`, `.dmg`, `.AppImage`, `.deb`, `.rpm`).
Unsigned builds: Windows shows SmartScreen, macOS needs a Developer ID and notarization (set `APPLE_ID` /
`APPLE_API_KEY` and the build signs and notarizes).

Development: `OPENCODE_CHANNEL=dev`, then `npx electron .` in `packages/desktop` — data in `nz.gpu.code.dev`,
Chrome DevTools protocol on port 9222.

`GPUNZ_API_URL` points the app at another API (default `https://gpu.nz/api/v1`).

## Releases and updates

An installed release build (Windows, Linux) checks `https://gpu.nz/downloads/code/latest*.yml` at start and every
ten minutes, downloads a newer version in the background and shows «install and restart» in the title bar (also
«Help and feedback» and Settings → Updates). It never asks the upstream project's servers. A macOS build cannot
update itself until it has a Developer ID signature (its updater refuses an unsigned app): it reads the same signed
manifest, says «version X is out» and sends the person to the download page. Development and beta builds do not
update; a Microsoft Store install is updated by the Store.

An update is installed only if its manifest is signed with our release key and names the file being downloaded
(`src/main/gpunz/release.ts`); downgrades are off. The private key lives on the release machine only — never on
the web server, never in this repository and never in its CI secrets: whoever holds it can ship code to every
installed copy. Losing it means every user reinstalls by hand once; leaking it means replacing the key in
`release.ts` and the same reinstall.

To release (a person does this, by hand, every time):

1. raise `version` in `packages/desktop/package.json` (the updater only moves forward) and push;
2. run the `desktop` workflow: it builds Windows, macOS (both architectures) and Linux on GitHub's own runners and
   starts every packaged build once (`scripts/smoke.mjs`) — a build that does not come up fails the run;
3. on the release machine: take the run's artifacts, check that every file matches its manifest, put the two macOS
   manifests together and sign `latest*.yml` with the release key (`latest*.yml.sig`);
4. upload — installers first, manifests last — to `https://gpu.nz/downloads/code/`; the signed manifests are the
   moment of release: installed copies pick the version up within minutes;
5. tag the built commit `code-v<version>` (the fork carries the upstream project's `v*` tags, so ours have their
   own prefix), create a draft GitHub release for it, run the `release` workflow to add the run's files, add the
   signed manifests and publish.

## Error reports and feedback

`src/main/gpunz/reports.ts`. The app sends its own errors to `POST https://gpu.nz/api/v1/app/errors`: uncaught
exceptions and rejections of the main process and of the window, a window or helper process that died, the agent
server exiting by itself, a launch that failed for a reason the app has no words for. A report is the error's text
and stack after `scrub()` (keys, tokens, e-mail addresses, the home folder and the user name in paths are cut), the
app's version, the system, the phase of the session, and an install id the app made up — never the account, a file
of the project or a request to the model. The same error goes out once in six hours, at most twenty-five reports a
day leave a computer, network failures are not reported at all, and the person can turn the whole thing off
(«Help and feedback» → «Send error reports»). Development and beta builds send nothing (`GPUNZ_REPORTS=1` to test).

«Help and feedback» (`src/renderer/gpunz/help.tsx`) posts to `/app/feedback` when the person presses «Send»: the
text, the kind (problem, idea, feedback), the account if signed in and — only with the box ticked — the end of the
app's log, scrubbed the same way.

The renderer is built without minification on purpose: a reported stack then names real functions.

## Microsoft Store

The free way to a signed Windows build: the Store signs an MSIX/AppX package itself, a developer account costs
nothing (individual or company), and the Store delivers updates — our own updater is off in such an install
(`FROM_STORE` in `src/main/constants.ts`). The ordinary installer stays for direct downloads.

- Build: `electron-builder --win appx --x64` after the usual build → `dist/gpunz-code-store-x64.appx` (unsigned on
  purpose: the Store signs it).
  Before a real submission set the three values from Partner Center → the app → Product identity:
  `GPUNZ_STORE_IDENTITY` (Package/Identity/Name), `GPUNZ_STORE_PUBLISHER` (`CN=…`), `GPUNZ_STORE_PUBLISHER_NAME`.
- Tiles and the manifest: `resources/appx/`. The manifest turns file and registry write virtualization off
  (`desktop6:*WriteVirtualization` + the restricted capability `unvirtualizedResources`): without it everything the
  agent's commands write under AppData would land in a private per-package folder, invisible to the person's own
  terminal — the known problem of coding agents shipped as MSIX.
- To try the package on a PC before the Store has signed it: turn on Developer Mode (Settings → System → For
  developers), unpack the .appx (it is a zip) and run `Add-AppxPackage -Register <folder>\AppxManifest.xml`;
  `Get-AppxPackage gpunz.Code | Remove-AppxPackage` removes it.

What the reviewers will ask (texts to paste into the submission):

- *runFullTrust*: «The app is a desktop (Electron) application: a code editor's companion that edits files in the
  user's project folder and runs the build and test commands the user approves.»
- *unvirtualizedResources*: «The app is a developer tool that runs command-line programs (git, node, python,
  package managers) on the user's behalf in their own project. These programs must read and write the user's real
  profile (configuration, caches, globally installed tools) so that results are the same as in the user's own
  terminal; with write virtualization on, files would be redirected into the package and be invisible outside
  it.»
- A test account: the app needs a gpu.nz sign-in and a balance to rent a server — give the reviewers an account
  with a small balance in «Notes for certification», and say that a model takes about ten minutes to start.

## Tests

```sh
cd packages/desktop && bun test src/main/gpunz     # the session, the bridge, the agent configuration
bunx tsgo -b                                       # types
```

## Updating from upstream

`git fetch upstream && git merge <tag>`; then rebuild, run the tests and the live check (launch a model, give the
agent a task, delete the server). Watch for: the theme file's keys, `packages/desktop/src/main/index.ts` (our
start-up order), i18n strings with the upstream name, new outbound URLs (`grep -rn "opencode.ai"`).
