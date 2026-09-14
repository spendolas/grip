# Grip

Full Figma canvas read/write for MCP agents. Pairs with **Gaffer** (After Effects, separate tool).

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

This copies the bridge to `~/.grip` and registers it with your agent. Add `--http` if you'd rather have an always-on background daemon (Login Item on macOS, Startup entry on Windows, systemd user service on Linux). Without it, nothing stays running and the first agent call starts the bridge on demand.

**2. The plugin** — in Figma, go to **Plugins → Development → Import plugin from manifest…** and choose the **`figma-plugin`** folder.

**3. Check it.** Restart your agent, run the plugin in any Figma file, then ask your agent to read your selection. The small status strip turns green.

Requirements: **Node 18+** and **Figma**. Figma Desktop exists on macOS and Windows; on Linux use Figma in the browser — plugin development import works there too.

## What's in here

```
figma-plugin/     import this folder in Figma — 3 files, nothing to build
bridge/           the bridge + installer — single self-contained files
src/              source for both halves (ignore unless you're changing Grip)
```

- **[`CLAUDE.md`](./CLAUDE.md)** — architecture (canonical).
- **[`TOOLS.md`](./TOOLS.md)** — the 150-tool surface (canonical).

## Cold start

The Figma sandbox can't launch a local process, so opening the plugin **before** any agent has called Grip shows it disconnected (grey). That's expected — the first agent call starts the bridge and the plugin reconnects within a couple of seconds. Use `--http` if you'd rather it always be running.

## Developing

```sh
npm run setup     # install dependencies for both halves
npm run build     # rebuild the plugin and the bridge bundles
npm test          # test suites
```

`figma-plugin/code.js` and `bridge/*.mjs` are build artifacts that are **deliberately committed**, so users don't need a toolchain. Rebuild and commit them whenever you change source.

For live work, `npm --prefix src/plugin run dev` watches the plugin (it hot-reloads in Figma); the bridge picks up changes when its parent agent restarts.

## Licence

[PolyForm Shield 1.0.0](./LICENSE.md) — use it freely, including commercially at work; modify and share it. You may not use it to build something that competes with Grip.
