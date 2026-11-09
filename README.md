# Grip

Full Figma canvas read/write for MCP agents.

Pairs with **[Gaffer](https://github.com/spendolas/gaffer-ae)**, which does the same job for After Effects. Enable both and one agent can read a design out of Figma and build it in After Effects in a single conversation.

Grip has two halves. The **plugin** runs inside Figma. The **bridge** runs on your machine and is what your agent actually talks to. The plugin is inert on its own — it opens a WebSocket to `127.0.0.1:7777` and waits for the bridge to answer.

```
your agent  ⇄  bridge (local)  ⇄  Figma plugin  ⇄  the canvas
```

One bridge serves many agents and many Figma windows at once.

## Install

Nothing to compile. Both halves ship prebuilt.

**1. The bridge** — one file, no dependencies, no npm:

```sh
node bridge/install.mjs
```

This copies the bridge **and the plugin** to `~/.grip` and registers the bridge with your agent. (Running it again also stops an old running bridge so the new one takes over.) Add `--http` if you'd rather have an always-on background daemon (Login Item on macOS, Startup entry on Windows, systemd user service on Linux). Without it, nothing stays running and the first agent call starts the bridge on demand.

**2. The plugin** — in Figma, go to **Plugins → Development → Import plugin from manifest…** and choose **`~/.grip/figma-plugin/manifest.json`** (the copy the installer made — importing that one, rather than the repo folder, lets updates refresh the plugin in place).

**3. Check it.** Restart your agent, run the plugin in any Figma file, then ask your agent to read your selection. The small status strip turns green.

Requirements: **Node 18+** and **Figma**. Figma Desktop exists on macOS and Windows; on Linux use Figma in the browser — plugin development import works there too.

## Updating

Grip never updates itself behind your back: **an update happens only when you say so.** It does check once a day whether a newer version exists (one small request, see below) and tells you in three places. Pick whichever you like:

1. **Ask your agent: "update Grip".** It calls `grip_update`, tells you what's new, and installs only after you say yes.
2. **Click the plugin strip.** When an update exists, a small **↑ update** label appears on the Grip plugin's status strip. Click it, then click again on **click to confirm** (you have 5 seconds).
3. **Manually.** `node ~/.grip/grip-bridge.mjs update` (asks first; `--yes` skips the question, `--check` only reports). Or from a clone: `git pull && node bridge/install.mjs`.

After an update the bridge restarts itself within a second (your agent may need one retry; agents on the HTTP transport may have to reconnect). If you imported the plugin from `~/.grip/figma-plugin` it was refreshed in place; re-run it in Figma (or turn on **Plugins → Development → Hot reload plugin**). If you imported it from a git clone instead, `git pull` there or import `~/.grip/figma-plugin/manifest.json` once.

**What gets downloaded, from where.** Only `bridge/version.json`, `bridge/grip-bridge.mjs` and the three `figma-plugin/` files from `https://raw.githubusercontent.com/spendolas/grip/main/` (this repo; nothing else is contacted, and redirects off that host are refused). Every file is checked against the SHA-256 and size in `version.json` *before* anything is written, and writes are atomic and confined to `~/.grip`. Be clear about what that proves: it catches corruption and a CDN serving a half-published release, but `version.json` comes from the same repo as the files, so you are trusting the repo owner exactly as much as you do when you `git pull`.

**Turning it off.** `GRIP_NO_UPDATE_CHECK=1` (in the environment of your agent / daemon) stops the daily check and every notice; nothing is contacted until you explicitly update yourself. `GRIP_UPDATE_BASE` points updates at a mirror (https, or `http://127.0.0.1`/`localhost`).

**Undo.** The previous bridge is kept: `node ~/.grip/grip-bridge.mjs update --rollback` puts it back.

## What's in here

```
figma-plugin/     the plugin — 3 files, nothing to build (the installer copies it to ~/.grip/figma-plugin)
bridge/           the bridge + installer — single self-contained files, plus version.json (release manifest)
scripts/          build helper that writes bridge/version.json
src/              source for both halves (ignore unless you're changing Grip)
assets/           artwork for the Community listing — not used at runtime
```

- **[`CLAUDE.md`](./CLAUDE.md)** — architecture (canonical).
- **[`TOOLS.md`](./TOOLS.md)** — the 154-tool surface (canonical).

## Cold start

The Figma sandbox can't launch a local process, so opening the plugin **before** any agent has called Grip shows it disconnected (grey). That's expected — the first agent call starts the bridge and the plugin reconnects within a couple of seconds. Use `--http` if you'd rather it always be running.

## Developing

```sh
npm run setup     # install dependencies for both halves
npm run build     # rebuild the plugin and the bridge bundles
npm test          # test suites
```

`figma-plugin/code.js`, `bridge/*.mjs` and `bridge/version.json` are build artifacts that are **deliberately committed**, so users don't need a toolchain and the self-updater has a manifest to read. Rebuild with `npm run build` at the repo root (it writes `version.json` last, after the bridge and plugin builds) and commit them whenever you change source; `npm test` fails if `version.json` is stale.

For live work, `npm --prefix src/plugin run dev` watches the plugin (it hot-reloads in Figma); the bridge picks up changes when its parent agent restarts.

## Licence

[PolyForm Shield 1.0.0](./LICENSE.md) — use it freely, including commercially at work; modify and share it. You may not use it to build something that competes with Grip.
