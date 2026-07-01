# Grip

Figma plugin + local Node bridge that exposes full canvas read/write to MCP agents. Pairs with **Gaffer** (After Effects, separate tool).

An agent (Claude Code, Claude Hub, any MCP client) talks to a small stdio **shim**; the shim spawns a single detached **daemon** that owns a WebSocket on `:7777`; each Figma window running the plugin connects to that daemon. One daemon serves many agents and many files at once.

- **[`CLAUDE.md`](./CLAUDE.md)** — architecture (canonical).
- **[`TOOLS.md`](./TOOLS.md)** — the 178-tool surface (canonical).
- **[`bridge/README.md`](./bridge/README.md)** — bridge internals.

## Build from this repo

Clone, then build both halves. `node_modules/`, `bridge/dist/`, and `plugin/build/` are **not** checked in — you regenerate them.

Prerequisites: **Node 20+**, **Figma Desktop**, and the **Claude Code CLI** (`claude`) if registering there.

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

Register it with Claude Code (writes user-scope config to `~/.claude.json`):

```sh
claude mcp add --scope user grip node "$(pwd)/dist/index.js"
```

> The path is stored **absolutely**. Run the `claude mcp add` line from inside `bridge/` so `$(pwd)` resolves correctly, or paste the full absolute path to `dist/index.js`. Other MCP clients: transport `stdio`, `command: node`, `args: ["<abs>/bridge/dist/index.js"]`.

Nothing to keep running — the first agent tool call spawns the detached daemon on demand.

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
