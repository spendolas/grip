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
so install it as a launchd LaunchAgent first:

```sh
npm run build                                     # ensure dist/ is current
bash scripts/start-daemon.sh                      # persistent daemon on WS :7777 + HTTP :7778 (nohup)
claude mcp add --transport http -s user grip http://127.0.0.1:7778/mcp
```

Start the daemon **before** registering the URL — Figma's sandbox can't start
it the way gaffer's AE panel starts gaffer's, so nothing else will. Run
`start-daemon.sh` once and/or have Claude Hub run it at startup (gaffer's
pattern). It's idempotent and reparents past the launching shell.

`scripts/install-launchd.sh` (a launchd LaunchAgent) exists as the "nicer"
alternative, **but launchd refuses to run a program on a `noowners` volume**
— secondary APFS / cloud mounts like `/Volumes/…/CloudStorage` — with
`Bootstrap failed: 5: Input/output error`. If grip lives on such a volume
(it does here, under Dropbox), use `start-daemon.sh`; the launchd installer
preflights for this and points you at the starter.

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
