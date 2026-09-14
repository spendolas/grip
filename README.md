# Grip

Figma plugin + local Node bridge that exposes full canvas read/write to MCP agents. Pairs with **Gaffer** (After Effects, separate tool).

An agent (Claude Code, Claude Hub, any MCP client) talks to a small stdio **shim**; the shim spawns a single detached **daemon** that owns a WebSocket on `:7777`; each Figma window running the plugin connects to that daemon. One daemon serves many agents and many files at once.

- **[`CLAUDE.md`](./CLAUDE.md)** — architecture (canonical).
- **[`TOOLS.md`](./TOOLS.md)** — the 150-tool surface (canonical).
- **[`bridge/README.md`](./bridge/README.md)** — bridge internals.

## Build from this repo

Clone, then build both halves. `node_modules/`, `bridge/dist/`, and `plugin/build/` are **not** checked in — you regenerate them.

Prerequisites: **Node 18+**, **Figma**, and the **Claude Code CLI** (`claude`) if registering there.

**Platforms.** macOS, Windows and Linux are all supported. Figma Desktop exists only on macOS and Windows — on Linux, run Figma in the browser; the plugin reaches the local bridge the same way. The bridge talks to its background daemon over a UNIX socket on macOS/Linux and a named pipe on Windows; this is handled automatically.

```sh
git clone <your-repo-url>
cd grip
```

### 1. Bridge (the MCP server)

```sh
cd bridge
npm install
npm run build          # tsc → dist/index.js (+ chmod +x)
```

Then run the installer, which does the registration for you:

```sh
node dist/install.js install
```

It copies the built bridge to a stable location (`~/.grip/bridge`) so the registered path survives rebuilds, registers grip with Claude Code, and falls back to writing `~/.claude.json` directly if the `claude` CLI isn't on your PATH. Add `--http` if you want an always-on daemon instead of the on-demand default — a Login Item on macOS, a Startup entry on Windows, a systemd user service on Linux.

Nothing needs to keep running by default: the first agent tool call spawns the detached daemon on demand.

<details>
<summary>Registering by hand instead</summary>

```sh
claude mcp add --scope user grip node "$(pwd)/dist/index.js"
```

The path is stored **absolutely**. Run this from inside `bridge/` so `$(pwd)` resolves correctly, or paste the full absolute path to `dist/index.js`. Other MCP clients: transport `stdio`, `command: node`, `args: ["<abs>/bridge/dist/index.js"]`.

</details>

### 2. Plugin (the Figma side)

```sh
cd ../plugin
npm install
npm run build          # tsc → build/code.js  (manifest.json points here)
```

Then in **Figma Desktop → Plugins → Development → Import plugin from manifest…** and pick `plugin/manifest.json`. Run the plugin in any file; the 120×32 status strip goes green once connected.

### 3. Verify

```sh
claude mcp list                 # grip listed
# make one grip call from your agent, then:
cat ~/.grip-bridge.status       # daemon pid / version / plugin count
```

## Cold-start note

The Figma sandbox can't launch a local process, so opening the plugin **before** any agent has called grip shows it disconnected (grey). That's expected: the first agent call starts the daemon and the plugin's auto-reconnect latches within ~2s. Make one grip call and the strip greens.

## Develop

```sh
cd bridge && npm run dev     # tsc --watch
cd plugin && npm run dev     # tsc --watch — plugin hot-reloads in Figma on rebuild
```

The bridge picks up changes when its parent MCP client restarts. A **manifest** change requires re-importing in Figma; a code-only change hot-reloads.
