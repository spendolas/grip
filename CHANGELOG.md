# Changelog

Newest first. Each `## <version>` heading is the exact version number; the GitHub Release for that version uses its section as the release notes. The history starts at 0.6.0.

## Unreleased

- Local and unsaved Figma files are no longer mixed up. These files have no real file key (Figma gives all of them the same placeholder, "0:0"), and Grip used to treat them as one file: your agent could end up reading or editing whichever of those windows had most recently switched pages. Now each of those windows is listed on its own, and when more than one is open your agent is asked to choose instead of guessing.
- Binding your agent to a local file by its name (or by its window) now sticks to that file instead of drifting to another local file.
- When Figma restarts the plugin (it does this every few minutes), an agent bound to that file moves to the fresh connection right away instead of lingering on the old one.
- `list_files` now shows one entry per file, with its open windows, whether your agent is bound and connected, and how many other agents are working on the same file. Binding to a file another agent is already using gives a warning, so two agents don't edit the same thing by accident.
- If the name you bind to matches more than one open file, Grip now says so and lists them (with their keys and window ids) instead of claiming the file isn't open.
- `get_page_context` and `grip_health` now tell the truth about your agent's binding (connected, waiting for the file, or not bound), and `grip_health` shows how many other agents are connected.
- Agents that connect over HTTP can pick their file in the address, for example `http://127.0.0.1:7778/mcp?file=<file key, name or link>`, the same way `GRIP_FILE` works for other agents.

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
