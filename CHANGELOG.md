# Changelog

Newest first. Each `## <version>` heading is the exact version number; the GitHub Release for that version uses its section as the release notes. The history starts at 0.6.0.

## 0.8.0

**Grip can update itself, but only when you say so, and only to a version your Figma plugin can talk to.**

- When a newer version is available, the plugin's status strip in Figma turns **purple** and pulses. Hover it to see what is new; **one click installs it**. The strip goes grey for a second while Grip restarts, then green again. If something goes wrong it flashes red once and goes back to purple with the reason in the tooltip.
- Grip checks that your Figma plugin is new enough for the update first. If any open Figma window has an older plugin, the update is not offered (not in the strip, not to your agent) and Grip tells you to update the plugin in Figma first. A release that cannot prove its compatibility is never offered.
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
