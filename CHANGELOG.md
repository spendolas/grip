# Changelog

Newest first. Each `## <version>` heading is the exact version number; the GitHub Release for that version uses its section as the release notes. The history starts at 0.6.0.

## 0.9.3

**Fixes a wrong hint when your imported plugin is already up to date.**

- If the Grip plugin you imported (even a git clone of yours) is already current but another Figma window still runs an older plugin, Grip no longer tells your agent to "git pull and rebuild" a folder that is already up to date. It now shows that window the "Reopen the plugin" message, which is what is actually left to do. Right after Grip refreshes an imported plugin it stays quiet for a minute, because that plugin reloads itself.

## 0.9.2

**Grip now tells you inside Figma when it has updated, and what to do next.**

- After an update, every open Figma window with the Grip plugin shows a short message ("Grip updated to 0.9.2"). If the update fails, the window you clicked says why. A Community plugin that needs reopening gets that in the same message ("Reopen the plugin to load its new version"), and the reopen message is shorter than in 0.9.1. These messages come from the bridge, so they work with any plugin version.

## 0.9.1

**Grip now keeps the plugin you imported up to date, and your agent only steps in for what Grip cannot do.**

- When your Grip plugin needs a newer bridge than the one you run, clicking the purple bar now asks the bridge to update itself (any bridge from 0.8.0 on). Only a bridge too old to update itself sends you to the install page. Needs the updated plugin.
- The bridge now keeps the Grip plugin you imported into Figma up to date, wherever you imported it from. Figma records every plugin you imported; when you click the purple bar to update (or, if only your plugin is behind, a purple bar offering "Refresh the Grip plugin you imported"), Grip also copies the new plugin files into that folder, and Figma reloads the plugin by itself. It only touches a folder whose `manifest.json` is Grip's, never a git checkout (your own clone), never writes more than the three plugin files, never downgrades, and reads only the plugin list from Figma's settings. Nothing is written without your click.
- If the Grip plugin you run came from Figma Community and is older than the plugin your bridge ships, Grip shows a short message inside that Figma window after the update ("Close and reopen the Grip plugin to load its newer version"), once per window. Figma cannot reload a running plugin, and loads the newest published version when it is opened. Your agent can also mention it if you ask. Works with any plugin version, no plugin update needed.
- Your agent now steps in only for what Grip cannot do itself: a plugin copy it will not write to (a git checkout), a plugin whose origin it cannot find out, a Community plugin that needs reopening, or a bridge that cannot update itself (a developer install, or no update on offer). It offers help once, never changes anything on its own, shows each notice at most once per 3 days, and `GRIP_NO_UPDATE_CHECK=1` silences it. `grip_health.update` always shows the facts (`pluginBehind`, `pluginCopies`, `pluginHelp`, `bridgeHelp`). The update result lists which plugin folders were refreshed or left alone.

## 0.9.0

**Several agents can now work in the same Figma file, or in several files, without stepping on each other.**

- Local and unsaved Figma files are no longer mixed up. These files have no real file key (Figma gives all of them the same placeholder, "0:0"), and Grip used to treat them as one file: your agent could end up reading or editing whichever of those windows had most recently switched pages. Now each of those windows is listed on its own, and when more than one is open your agent is asked to choose instead of guessing.
- Binding your agent to a local file by its name (or by its window) now sticks to that file instead of drifting to another local file.
- When Figma restarts the plugin (it does this every few minutes), an agent bound to that file moves to the fresh connection right away instead of lingering on the old one.
- `list_files` now shows one entry per file, with its open windows, whether your agent is bound and connected, and how many other agents are working on the same file. Binding to a file another agent is already using gives a warning, so two agents don't edit the same thing by accident.
- If the name you bind to matches more than one open file, Grip now says so and lists them (with their keys and window ids) instead of claiming the file isn't open.
- `get_page_context` and `grip_health` now tell the truth about your agent's binding (connected, waiting for the file, or not bound), and `grip_health` shows how many other agents are connected.
- Agents that connect over HTTP can pick their file in the address, for example `http://127.0.0.1:7778/mcp?file=<file key, name or link>`, the same way `GRIP_FILE` works for other agents.
- Several agents can share one Figma window more smoothly. Calls wait in a fair queue: each agent gets its turn, so one agent sending many calls no longer holds up another agent's single call. A call that waited 2 seconds or more says so in its result.
- A slow but healthy call (an export, loading a big page, a long `map_nodes` or a `run_script` with a larger `timeoutMs`) no longer makes other agents' calls fail with "the Figma tab must be reloaded". While the plugin is busy, other calls either go through or get a new `plugin_working` error that names what the plugin is doing and says when to retry. `plugin_busy` (and the reload advice) is now only for a call that ran past its own time limit with no reply.
- "Too busy" errors (`plugin_working`, `plugin_busy`, `plugin_overloaded`) now say how long to wait before retrying (`retryAfterMs`).
- Several agents editing the same file no longer see healthy edits fail. The plugin runs edits one at a time, and Grip used to start each edit's time limit when it sent it, so an edit that waited behind other agents' edits could time out (and the plugin could still apply it later), and a read sent meanwhile could be told the plugin was stuck and the tab needed a reload. Now Grip sends a file's edits one at a time and holds the rest in a fair queue (each agent gets its turn), so an edit's time limit starts when it can actually run. Reads keep their own slots: one agent sending many edits no longer holds up other agents' reads, and a long edit never makes reads fail (or the other way round). An edit that waits more than 60 seconds behind a long edit fails without being sent (`plugin_working`, nothing changed). Needs the updated plugin; with an older plugin nothing changes.
- When the plugin is stuck, calls that were waiting in Grip's queue now fail at once (`plugin_busy`, never sent) instead of each waiting out its own time limit.
- A change that times out now says `maybe_applied`: the plugin may have started it in time and cannot stop it, so it may still be applied after the error. Re-read before retrying.
- When Figma reconnects the plugin in the middle of a call, Grip re-sends reads, and calls that had not been sent yet, once to the reconnected plugin instead of failing them. A change that had already been sent is never re-sent: it fails with a new `maybe_applied` error that says the change may already have been made and to check before retrying. Messages that used to say "retry safe" for any call now only say so when it is true.
- Live event subscriptions only deliver events from the file the agent is working on (its bound file, or the only open file), and each event now says which file it came from (`fileKey`, `fileName`) and whether this agent, another agent, or probably the user caused it (`causedBy`).
- When several agents edit the same file at once, their edits no longer get tangled. Each edit now runs to the end before the next one starts, in the order they arrived, so every tool call is exactly one undo step. Reads still run alongside edits without waiting. Undo requests wait for the edit in progress instead of landing in the middle of it.
- An edit that waited in the plugin until its time limit had already run out is skipped (`plugin_queue_timeout`, nothing changed) instead of running after the agent was told it failed. The plugin now uses the time limit Grip sends with each call (before, it assumed 10 seconds whatever Grip used). This only covers an edit that has not started: an edit that started in time and is still running when the time limit passes cannot be stopped, and the agent gets `maybe_applied`.
- Scripts that run at the same time no longer disturb each other's pacing.
- When Figma restarts the plugin while an edit is running, edits waiting behind it now move to the new connection and wait their turn there. Before, they could be sent to the old, dying connection and fail with `maybe_applied` although they never ran, while a newer edit went out on the new connection at the same time. A file now never gets two edits at once, also during the switch, and moving an edit does not restart its 60-second waiting limit.
- With two plugin windows open on the same file, switching pages in the older window no longer makes your agent's calls go to it instead of the newer one.
- Renaming a local or unsaved file no longer loses your agent's binding when Figma restarts the plugin. A copy of the file (same file ID, another name) is still never mistaken for it.
- An edit that times out while an earlier, already timed-out edit is still running in the plugin now says it was most likely skipped (the plugin does not start it), instead of only `maybe_applied`. Re-read before retrying all the same.
- If the connection to Grip drops during `trigger_undo`, `notify` or `open_external_url`, the error now says to check before retrying instead of calling the call safe to retry (retrying an undo could undo twice).
- `set_selection` and `scroll_to` accept `keepPage: true`, which never switches the page you are looking at (it reports an error naming the other page instead). `get_selection`, `find_with_criteria` and `create_node` accept `pageId` to work on a specific page without switching to it. Without these options nothing changes.
- Each file now gets its own ID, stored in the file, so files that have no Figma file key (local or unsaved files) can be told apart. A file you can only view gets no ID. A duplicated file can start with the same ID as its original, so the ID never overrides a real Figma file key: an agent bound to the original stays on it when a copy opens. For local files the ID counts together with the file name, so a copy under another name is listed on its own and an agent that is not bound is asked to choose.
- Document change notifications now say how many changes came from this Figma session and how many from other people in the file, and count every change in the half-second window instead of only the last batch.

The changes to edit ordering, skipped late edits, script pacing, `keepPage`/`pageId`, file IDs and change notifications are in the Figma plugin, so they take effect only once the updated plugin is republished in Figma (and each user's plugin has updated).

## 0.8.0

**Grip can update itself, but only when you say so, and only to a version your Figma plugin can talk to.**

- Grip works with any MCP agent, not just Claude. The install steps now let the installing agent decide how to register Grip in its own client: `install.mjs --no-register` installs the files and prints how to connect (HTTP address, stdio command, example snippets for Cursor and Codex), and `--print-config` prints that without installing anything. The default still registers with Claude.
- When a newer version is available, the plugin's status strip in Figma turns **purple** and pulses. Hover it for a short "Update available" tooltip; **one click installs it**. The strip goes grey for a second while Grip restarts, then green again. If something goes wrong it flashes red once and goes back to purple.
- If your bridge is older than 0.8.0 (it cannot update itself), the plugin's strip also turns purple with "Bridge update needed"; clicking it opens the install page.
- Grip checks that your Figma plugin is new enough for the update first. The update is offered per Figma window: a window whose plugin is too old never turns purple, and it does not stop other windows from being offered the update. If no open window has a new enough plugin, the update is not offered at all (not in the strip, not to your agent) and Grip tells you to update the plugin in Figma first. When you update, any other window with an old plugin stops working until you update that plugin in Figma, and Grip warns about it. A release that cannot prove its compatibility is never offered.
- Ask your agent to "update Grip" and it tells you what is new, then installs only after you say yes; if your agent can show prompts, Grip asks you itself. Nothing is ever installed on its own, and your agent hears about a given update at most once every three days.
- You can also update from a terminal: `node ~/.grip/grip-bridge.mjs update` (add `--check` to only look, `--rollback` to go back to the previous bridge; the plugin files stay at the new version).
- Updates come from this repository's GitHub Releases. Every file is checked against the SHA-256 list published with the release, and the new bridge must start and report its version before it replaces the old one. The previous bridge is kept so you can undo.
- Grip looks once a day whether a newer version exists. Set `GRIP_NO_UPDATE_CHECK=1` to turn that off completely.
- Installing is now one download: tell your agent "Install Grip from https://github.com/spendolas/grip/releases/latest" and the steps in the README fetch a single zip from that release, verify it, and run the installer.
- If you installed from a git clone, Grip never overwrites that install. Update it with `git pull`, `npm run build` and `node bridge/install.mjs`.
- Bridge schemas moved to zod 4, which fixes the one dependency advisory the audit used to accept (zod memory exhaustion on oversized lists). The tool descriptions agents see are unchanged, and the dependency audit now has no accepted advisories.

## 0.7.0

**Grip now covers many more of Figma's newer plugin features.**

- Dev Mode status: read and set the "Ready for dev" / "Completed" status on a node.
- Pages: page guides, page background colors and prototype starting points can be read and changed.
- Components: description with Markdown, default variants, and a way to clear a slot back to its default.
- Text: leading trim, list and hanging indents, extra decoration options, and a flag for text whose font is missing.
- Variables: resolve what a variable ends up as for a specific layer, see the modes a layer actually uses, read values of extended collections, and remove a mode override or a code syntax.
- Styles: reorder style folders, and read the file's color profile.
- Layout and shapes: wrap alignment, mask types, mirrored handles on vectors, fixed children in auto layout, appending into specific grid cells, optional geometry data on reads, and pattern paints.
- FigJam and Slides: more sticky, connector and table-cell properties, and slide focus and skip.

## 0.6.1

**Importing a library item with a wrong key now fails in seconds instead of hanging.**

- Importing a component, style or variable by key from a team library used to wait for Figma, which never answers for a key it cannot resolve. Grip now gives up after 6 seconds with a clear `library_key_unresolved` error that explains the usual causes: an unknown key, a library that is not enabled for this file, or an item that was never published.

## 0.6.0

**Browse team libraries, and a clear message when a Figma plugin is out of date.**

- Team libraries: list the variables a library offers, so you can find the keys needed to import them.
- Extended variable collections: see which collections extend others, with their parents, overrides and per-mode inheritance. You can create an extended collection and remove its overrides.
- Publish status now works for components and component sets, not only styles and variables.
- Fixed extending a library collection by key, which never worked.
- If the plugin open in Figma is older than the bridge, calls it cannot answer now say so and tell you to re-run the plugin, instead of failing with a confusing protocol error. The plugin and bridge versions now move together.
