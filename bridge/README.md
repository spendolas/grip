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

### HTTP transport (preferred for Claude Hub)

For a host that spawns many short-lived agents (Claude Hub), register grip
by **URL** instead of stdio. Agents then connect directly to one long-lived
daemon — no per-process shim to die mid-call, no IPC hop to lose a message
(the leader-death stall class). Requires the daemon to be always running,
so install it as a Login Item first:

```sh
npm run build                                     # ensure dist/ is current
bash scripts/install-loginitem.sh                 # always-on daemon as a Login Item; also starts it now
claude mcp remove -s user grip 2>/dev/null; claude mcp add --transport http -s user grip http://127.0.0.1:7778/mcp
```

`install-loginitem.sh` builds `/Applications/Grip Daemon.app` (a hidden
`LSUIElement` background app whose executable is the persistent daemon) and
registers it as a **Login Item** — so grip starts at every login. This is
the same mechanism Claude Hub / FigmaAgent use; Login Item `.app`s launch
fine from a secondary/cloud volume. (A hand-rolled LaunchAgent plist via
`launchctl bootstrap` errors `5: Input/output error` on such a box —
`install-launchd.sh` is kept only for boot-volume installs.)

Start the daemon **before** registering the URL — HTTP has no on-demand
bootstrap, so if nothing is listening grip is simply dead (Figma's sandbox
can't start it). `scripts/start-daemon.sh` is a manual one-shot starter
(nohup) if you just need it up now without the login item.

Note: launch-time `GRIP_FILE` binding is stdio-only (it rides the shim's IPC
control frame). Over HTTP, agents bind at runtime with `set_active_file`.

Then in Figma Desktop: **Plugins → Development → Import from manifest…** →
point to `plugin/manifest.json`. Run the plugin in any file (or several).
The status strip goes green when the WebSocket connects.

For local dev, `npm run dev` runs `tsc --watch`. The plugin hot-reloads
on rebuild. The bridge needs a restart of its parent MCP client to pick
up changes.

## Environment

- `GRIP_WS_PORT` — override `7777` (WebSocket to Figma plugins).
- `GRIP_HTTP_PORT` — override `7778` (HTTP `/mcp` for direct MCP clients).
- `GRIP_PERSISTENT=1` — disable idle-exit + lifetime ceiling (set by the
  launchd LaunchAgent, which owns the daemon's lifecycle).
- `GRIP_IPC_PATH` — override the leader's UNIX-socket path
  (default `tmpdir/grip-bridge.sock`).
- `GRIP_FILE` — bind this agent to a Figma file at launch (fileKey, exact
  file name, or figma.com URL). The shim forwards it to the daemon so tool
  calls route to that file without the agent calling `set_active_file`.
  Binds even before the file is open (resolves when it connects).

## Important

- **stdout is the MCP transport.** All bridge logs go to stderr. Do not
  add `console.log` in this package.
- 10s per-request timeout (60s for `export_node` — raster export of a big
  frame is legitimately slow; `GRIP_EXPORT_TIMEOUT_MS` overrides). Plugin no
  answer → agent gets a descriptive error; pending requests bound to a
  dropped plugin session are rejected with `"Plugin disconnected"`.
- `export_node` with a `path` writes bytes to disk on the bridge and returns
  `{path, format, bytes}` — required for PNG/JPG/PDF, whose inline base64
  overflows the MCP result token limit.
- Many plugins, many MCP sessions. Each plugin window gets its own
  `sessionId`; each MCP client (stdio leader or IPC proxy) gets its own
  `activeFileId` and subscription set. Use `list_files` /
  `set_active_file` to target.
- 178 tools today. Per-tool reference in [`../TOOLS.md`](../TOOLS.md).
- Leader exits 30s after the last MCP session detaches; sockets
  cleaned up automatically.
