# Grip Bridge

Local Node process that exposes the Figma plugin to MCP agents.

```
agent A ─stdio─┐
agent B ─stdio─┤  ⇄  bridge (leader)  ⇄ ws://localhost:7777 ⇄  plugin UI  ⇄ postMessage ⇄  plugin main
agent C ─stdio─┘             ▲
                             │ UNIX-socket IPC
                   bridge (proxy)  ←  agent D's bridge spawn
```

First `node dist/index.js` to bind `:7777` becomes leader. Every later
spawn auto-detects the busy port and runs as a thin proxy that pipes
its stdio MCP traffic to the leader's IPC socket. Multiple concurrent
Claude / Claude Hub sessions share one plugin connection without
`EADDRINUSE`.

## Setup

```sh
cd bridge
npm install
npm run build
```

## Run

The bridge is launched by your MCP client, not by hand. For Claude Code:

```sh
claude mcp add --scope user grip node /abs/path/to/grip/bridge/dist/index.js
```

This writes to `~/.claude.json` under user scope. Other clients use their
own config — the only requirement is `command: node`, `args: [<path to
dist/index.js>]`, transport: stdio.

Then in Figma Desktop: **Plugins → Development → Import from manifest…** →
point to `plugin/manifest.json`. Run the plugin in any file (or several).
The status strip goes green when the WebSocket connects.

For local dev, `npm run dev` runs `tsc --watch`. The plugin hot-reloads
on rebuild. The bridge needs a restart of its parent MCP client to pick
up changes.

## Environment

- `GRIP_WS_PORT` — override `7777`.
- `GRIP_IPC_PATH` — override the leader's UNIX-socket path
  (default `tmpdir/grip-bridge.sock`).

## Important

- **stdout is the MCP transport.** All bridge logs go to stderr. Do not
  add `console.log` in this package.
- 30s per-request timeout. Plugin no answer → agent gets a descriptive
  error; pending requests bound to a dropped plugin session are rejected
  with `"Plugin disconnected"`.
- Many plugins, many MCP sessions. Each plugin window gets its own
  `sessionId`; each MCP client (stdio leader or IPC proxy) gets its own
  `activeFileId` and subscription set. Use `list_files` /
  `set_active_file` to target.
- 178 tools today. Per-tool reference in [`../TOOLS.md`](../TOOLS.md).
- Leader exits 30s after the last MCP session detaches; sockets
  cleaned up automatically.
