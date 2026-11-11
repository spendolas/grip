# Grip

Full Figma canvas read/write for MCP agents.

Pairs with **[Gaffer](https://github.com/spendolas/gaffer-ae)**, which does the same job for After Effects. Enable both and one agent can read a design out of Figma and build it in After Effects in a single conversation.

## Quick Start

Open your agent (the Claude desktop app, Claude Code, Cursor, Codex, or any MCP agent that can run shell commands) and say:

> Install Grip from https://github.com/spendolas/grip/releases/latest

Or open the **[install page](https://spendolas.github.io/grip/)**: it has one-click buttons that start the same prompt in the Claude desktop app (Code), Cursor or Codex, and a button that copies it for any other agent. Nothing is sent until you press Enter.

Your agent opens the latest release, follows the install steps in this README (every release links the README at its own tag, so the steps and the downloadable files always match), downloads and verifies the release, installs it, and asks you a question or two along the way. Then you import the plugin in Figma (one menu step that only you can do) and restart your agent.

## How it works

Grip has two halves. The **plugin** runs inside Figma. The **bridge** runs on your machine and is what your agent actually talks to. The plugin is inert on its own — it opens a WebSocket to `127.0.0.1:7777` and waits for the bridge to answer.

```
your agent  ⇄  bridge (local)  ⇄  Figma plugin  ⇄  the canvas
```

One bridge serves many agents and many Figma windows at once.

## Prerequisites

- **Node.js 18 or newer** (`node --version`). The bridge is one self-contained file, no npm and no dependencies.
- **Figma**: Figma Desktop (macOS and Windows) or Figma in the browser (Linux; plugin development import works there too).
- An MCP agent that can run shell commands, such as the Claude desktop app, Claude Code, Cursor or Codex.
- Nothing else. No git, no build tools.

---

## Install Instructions for Agents

<details>
<summary>Agent: read this section when asked to install Grip.</summary>

### Rules for the agent

Before you begin, read these rules. They apply to every step below.

- Follow the steps in order. Do not skip, reorder, or combine steps.
- Do not improvise. If a step seems wrong for this system, stop and ask the user rather than deviating.
- Do not install prerequisites the user is missing (Node.js, Figma). If one is missing, stop and tell the user what to install, with a link. Resume only after they confirm it is installed.
- Do not change proxy, certificate or network settings, do not turn off certificate checks, and do not ask the user to approve that either. If a download fails, stop and tell the user.
- Do not add shell aliases, modify the user's PATH, or change any config outside the paths explicitly named in these steps.
- Shell variables do not carry over between your separate command runs, so every block below sets the paths it needs.
- If any step fails, stop. Report the exact error. Do not retry with modifications unless the user asks you to.
- Each code block is its own command: run it on its own, and do not merge blocks or add commands to them. Blocks that delete a folder are kept separate on purpose, because Claude Code's own command check can block a delete that shares a command with other path-like text.
- Run each Windows block in PowerShell. If your shell is bash, run it as `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ...`, or save it to a .ps1 file and run that with `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <file>`. Bash expands `$` inside double quotes, so the .ps1 file is the safer choice.
- Never decide for the user whether Grip runs as an always-on background service. That is step 6: ask, say which one is recommended, and wait for the answer.
- You cannot click in Figma. Step 7 is the user's. Say so, and wait for them to confirm.
- After the install completes, run the verification step. Do not skip it.

### What to do

1. **Check prerequisites.** Run this and report the result to the user before proceeding:

   ```bash
   node --version
   ```

   It must print `v18` or higher. If `node` is missing or older than 18, STOP. Tell the user to install the current LTS from https://nodejs.org and come back. Also ask them to confirm they have Figma (Desktop, or Figma in a browser). Do not proceed until both are in place.

2. **Check for an existing install.** Look for `~/.grip/grip-bridge.mjs` (Windows: `$env:USERPROFILE\.grip\grip-bridge.mjs`):

   ```bash
   # macOS / Linux
   ls -l "$HOME/.grip/grip-bridge.mjs" "$HOME/.grip/install.json" 2>&1
   ```

   ```powershell
   # Windows (PowerShell)
   Get-Item "$env:USERPROFILE\.grip\grip-bridge.mjs", "$env:USERPROFILE\.grip\install.json" -ErrorAction SilentlyContinue
   ```

   If the bridge file exists, tell the user: "Grip is already installed. Reinstalling overwrites the installed bridge and plugin files. To upgrade, you can instead ask me to update Grip, which asks you first and shows what is new. Reinstall anyway?" Wait for their answer. If they decline, stop. If `install.json` says `"source": "clone"`, this is a developer install from a git clone: do not reinstall over it, tell the user to use `git pull && node bridge/install.mjs` in their clone, and stop.

3. **Detect the platform.** This step only reads.

   ```bash
   uname -s
   ```

   `Darwin` is macOS and `Linux` is Linux: use the macOS / Linux blocks. If the command does not exist, you are on Windows: use the PowerShell blocks. Do not ask the user to confirm.

4. **Download the install package and its checksum list** from the latest GitHub release into a new private folder. Each block prints the folder's path; the next steps need it.

   ```bash
   # macOS / Linux
   DL="$(mktemp -d "${TMPDIR:-/tmp}/grip-install.XXXXXX")" && echo "Download folder: $DL" \
     && curl -fsSL --proto '=https' --connect-timeout 20 --max-time 600 --retry 3 --retry-delay 2 -o "$DL/grip-install.zip" https://github.com/spendolas/grip/releases/latest/download/grip-install.zip \
     && curl -fsSL --proto '=https' --connect-timeout 20 --max-time 600 --retry 3 --retry-delay 2 -o "$DL/SHA256SUMS.txt" https://github.com/spendolas/grip/releases/latest/download/SHA256SUMS.txt
   ```

   ```powershell
   # Windows (PowerShell)
   [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
   $ProgressPreference = 'SilentlyContinue'
   $dl = Join-Path $env:TEMP ("grip-install-" + [guid]::NewGuid().ToString("N"))
   New-Item -ItemType Directory -Path $dl | Out-Null
   "Download folder: $dl"
   Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/spendolas/grip/releases/latest/download/grip-install.zip" -OutFile "$dl\grip-install.zip"
   Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/spendolas/grip/releases/latest/download/SHA256SUMS.txt" -OutFile "$dl\SHA256SUMS.txt"
   ```

   If a download fails (for example HTTP 404 because no release exists yet), stop and report the exact error. Do not take the files from anywhere else.

5. **Verify the checksum before you extract anything.** Replace `<download folder step 4 printed>` with the folder step 4 printed. The file must match the line for `grip-install.zip` in `SHA256SUMS.txt`.

   ```bash
   # macOS
   DL="<download folder step 4 printed>"
   cd "$DL" && grep ' grip-install.zip$' SHA256SUMS.txt | shasum -a 256 -c -
   ```

   ```bash
   # Linux
   DL="<download folder step 4 printed>"
   cd "$DL" && grep ' grip-install.zip$' SHA256SUMS.txt | sha256sum -c -
   ```

   ```powershell
   # Windows (PowerShell)
   $dl = "<download folder step 4 printed>"
   $line = Get-Content "$dl\SHA256SUMS.txt" | Where-Object { $_.EndsWith(' grip-install.zip') } | Select-Object -First 1
   $want = if ($line) { $line.Split(' ', [StringSplitOptions]::RemoveEmptyEntries)[0].ToLower() } else { $null }
   $got = (Get-FileHash "$dl\grip-install.zip" -Algorithm SHA256).Hash.ToLower()
   if ($want -and $got -eq $want) { "SHA-256 OK" } else { "SHA-256 MISMATCH: expected $want, got $got" }
   ```

   macOS and Linux must print `grip-install.zip: OK`; Windows must print `SHA-256 OK`. If it does not, stop and tell the user the download did not match its checksum. Never extract an archive that failed this check.

6. **Ask the user how Grip should run, then run the installer.** Ask exactly this and wait for the answer: "Do you want Grip to run as an always-on background service (recommended: a Login Item on macOS, a Startup entry on Windows, a systemd user service on Linux — it starts with your computer, so the plugin goes green the moment you open it in Figma), or on demand (nothing stays running; the first time your agent uses Grip it starts the bridge, and until then the plugin sits grey)? Always-on is the recommended default; on-demand is fine if you would rather nothing ran in the background." Do not choose for them. Extract the package, then run the installer from the extracted folder (it copies the bridge and the plugin to `~/.grip` and registers Grip with your agent). Replace `<download folder step 4 printed>` as before.

   ```bash
   # macOS / Linux
   DL="<download folder step 4 printed>"
   unzip -q "$DL/grip-install.zip" -d "$DL/extract"
   ```

   ```bash
   # macOS / Linux: always-on service (recommended default)
   DL="<download folder step 4 printed>"
   node "$DL/extract/grip/bridge/install.mjs" --http
   ```

   ```bash
   # macOS / Linux: only if the user chose on demand
   DL="<download folder step 4 printed>"
   node "$DL/extract/grip/bridge/install.mjs"
   ```

   ```powershell
   # Windows (PowerShell)
   $dl = "<download folder step 4 printed>"
   Expand-Archive -LiteralPath "$dl\grip-install.zip" -DestinationPath "$dl\extract"
   ```

   ```powershell
   # Windows (PowerShell): always-on service (recommended default)
   $dl = "<download folder step 4 printed>"
   node "$dl\extract\grip\bridge\install.mjs" --http
   ```

   ```powershell
   # Windows (PowerShell): only if the user chose on demand
   $dl = "<download folder step 4 printed>"
   node "$dl\extract\grip\bridge\install.mjs"
   ```

   `--http` installs the always-on service for this platform, starts it now, and registers Grip over HTTP (`http://127.0.0.1:7778/mcp`) instead of stdio. Without it Grip is registered as a stdio command and starts on the first call. Either way the installer does the whole thing; you do not start anything by hand.

   **Which client are you? This is your decision.** Grip is a standard MCP server, so any MCP client can use it. By default the installer registers Grip with Claude: it runs `claude mcp add` when the Claude Code CLI exists, otherwise it writes the server entry into `~/.claude.json`. If you are Claude Code or the Claude desktop app, run the commands above as they are and tell the user that is what it did. If you are any other agent (Codex, Cursor, or another MCP client), add `--no-register` to the installer command: it installs the files and changes no agent config, then prints how to connect (HTTP address, stdio command, and example snippets). Register Grip in your own client from that output (or from `node "$DL/extract/grip/bridge/install.mjs" --print-config`), after showing the user exactly what you will write and where, and asking. The examples are starting points; your client's own docs win if the format differs.

   The installer prints what it did. It ends with `Done. Grip <version> installed.` If it prints an error, stop and report it. If Claude Code's permission check blocks the installer, show the user the exact command from the block above and ask them to run it in a terminal and reply when it is done.

7. **Tell the user to import the plugin in Figma. This step is theirs.** You cannot click in Figma. Say, with the right path for their system:

   "In Figma, open **Plugins → Development → Import plugin from manifest…** and choose `~/.grip/figma-plugin/manifest.json` (Windows: `%USERPROFILE%\.grip\figma-plugin\manifest.json`). Import that copy, not a download folder, so later updates can refresh the plugin in place. Then run the plugin from **Plugins → Development → Grip** in any file. Reply when that is done."

   Wait for them to confirm.

8. **Clean up the download folder.** Replace `<download folder step 4 printed>` with the folder step 4 printed. Delete it as its own command.

   ```bash
   # macOS / Linux
   DL="<download folder step 4 printed>"
   rm -rf "$DL"
   ```

   ```powershell
   # Windows (PowerShell)
   $dl = "<download folder step 4 printed>"
   Remove-Item -LiteralPath $dl -Recurse -Force
   ```

   Also delete the folder of any failed attempt.

9. **Restart the agent and verify.** Tell the user to restart their agent (for example quit and reopen the Claude desktop app, or start a new Claude Code, Cursor or Codex session) so it picks up the new Grip server. In the new session, with the plugin running in a Figma file, run `grip_health` (the bridge is up and shows the connected plugin) and then `get_page_context` (it names the open file and page). If `get_page_context` reports no plugin connected, ask the user to run the Grip plugin in Figma (step 7) and try again. The plugin's small status strip turns green when it is connected. If the install was run in a session that already had Grip registered, say plainly that the verification happens after the restart, and ask the user to come back and say "check Grip".

</details>

---

## What's in here

```
figma-plugin/     the plugin: manifest.json and ui.html are hand-written; code.js is build output (not in git). The installer copies it to ~/.grip/figma-plugin
bridge/           local build output only (not in git): the bridge + installer, single self-contained files. Release downloads contain them
scripts/          release packaging, the release gate, bundle hygiene and license notices (used by CI)
src/              source for both halves (ignore unless you're changing Grip)
assets/           artwork for the Community listing — not used at runtime
CHANGELOG.md      what changed in each release (also the release notes)
```

- **[`CLAUDE.md`](./CLAUDE.md)** — architecture (canonical).
- **[`TOOLS.md`](./TOOLS.md)** — the 154-tool surface (canonical).

## Cold start

With the always-on service (`--http`, the recommended install) the bridge is already running, so the plugin is green as soon as you open it.

On an on-demand install the Figma sandbox can't launch a local process, so opening the plugin **before** any agent has called Grip shows it disconnected (grey). That's expected — the first agent call starts the bridge and the plugin reconnects within a couple of seconds.

## Updating

Grip never updates itself behind your back: **an update happens only when you say so.** It does check once a day whether a newer release exists (one small request, see below), and it only tells you about a release that works with the Figma plugin(s) you have open (see "Plugin compatibility"). Pick whichever way you like:

1. **Click the plugin strip.** When a compatible update exists, the Grip plugin's status strip in Figma turns **purple and pulses** (grey = no bridge, green = connected, yellow = warning, red = error: purple is only ever an update). Hover it for a short "Update available" tooltip; **one click installs it.** While it installs the strip pulses faster and says "Updating…", goes grey for a second while the bridge restarts, then turns green again. If an install fails it flashes red once and goes back to purple (the tooltip then says "Update failed. Click to retry").
2. **Ask your agent: "update Grip".** It calls `grip_update`, tells you what's new (the release notes) and installs only after you say yes. If your agent can ask you directly (MCP elicitation) Grip asks you itself and installs only if you accept; the agent saying "they said yes" is not enough there.
3. **Manually.** `node ~/.grip/grip-bridge.mjs update` (asks first; `--yes` skips the question, `--check` only reports and shows the notes, `--rollback` puts the previous bridge back).
4. **Developer installs (a git clone).** `git pull && npm run build && node bridge/install.mjs` (the bundles are not in git, so rebuild after pulling). An install made from a clone is never updated in place: the updater, the agent tool and the plugin all tell you to update the clone instead (the strip is not purple for a clone install). (`update --force` on the command line overrides that.)

After an update the bridge restarts itself within a second (your agent may need one retry; agents on the HTTP transport may have to reconnect). The plugin you imported is refreshed too, wherever you imported it from (Figma keeps a list of imported plugins and Grip copies the three plugin files into that folder; Figma reloads the plugin by itself). If only your plugin is behind, the strip turns purple once to offer that refresh. The one exception is a git clone: Grip never writes into a checkout, so run `git pull && npm run build` there. A plugin installed from Figma Community updates through Figma.

**Plugin compatibility.** The published Figma plugin is updated through Figma, not by this updater, so the plugin you have can be older than the bridge. Every release carries a `compat.json` (`{"version", "minPlugin"}`, checked against `SHA256SUMS.txt`) naming the oldest plugin it works with. Grip signals (purple strip, agent notices) and installs an update only when at least one plugin window is connected and **every** connected plugin is at least that version, because an update replaces the bridge for all your Figma windows. If one is too old, `grip_health` says so ("plugin 0.6.0 in "Fidelity" is older than 0.9.0 requires (>=0.8.0); update the Grip plugin in Figma first") and nothing is offered. A release without a verifiable `compat.json` is never offered or installed (only the command line's `--force` overrides that, with a loud warning). The check runs again at install time against the windows connected then; from the command line it asks a running bridge, and if it cannot (no bridge or plugin open) it says so and needs `--yes`.

**Agent notices are rationed.** For a given new version your agent is told at most once every 3 days, across all its sessions (the purple strip, `grip_update` check and `grip_health` always show the truth).

**What gets downloaded, from where.** Updates come from this repository's [GitHub Releases](https://github.com/spendolas/grip/releases). The bridge asks `api.github.com` which release is the latest, then downloads `compat.json` and `SHA256SUMS.txt` to check compatibility, and, when you install, four more files from that release (`grip-bridge.mjs`, `grip-plugin-code.js`, `grip-plugin-ui.html`, `grip-plugin-manifest.json`). Downloads may only come from `github.com`, `api.github.com` and `*.githubusercontent.com` (GitHub redirects release downloads to `release-assets.githubusercontent.com`; anything else is refused). Every file must be listed in `SHA256SUMS.txt` and match its hash, and stay under a size cap, *before* anything is written. The downloaded bridge is then run once (`--selftest`, ten seconds at most, no ports, nothing written) and is only swapped in if it starts and reports the expected version. Writes are atomic and confined to `~/.grip`, plus the three plugin files in any folder you imported the Grip plugin from (found in Figma's own plugin list; Grip reads nothing else from Figma's settings, and never writes into a git checkout), and the previous bridge is kept. The request carries only a generic user agent (`grip-bridge/<version>`): no account, email or machine identifier.

**Firewalls.** If you run an outbound firewall (LuLu, Little Snitch, a corporate proxy), allow `api.github.com`, `github.com` and `release-assets.githubusercontent.com` for `node`. Without them the daily check just fails quietly.

**Turning it off.** `GRIP_NO_UPDATE_CHECK=1` (in the environment of your agent / daemon) stops the daily check, the purple strip and every notice; nothing is contacted until you explicitly update yourself.

**What that does and does not prove.** Releases are built by CI (GitHub Actions) from the tagged commit in this repository, and the checksum list is published with each release. The checksums catch corruption and a half-published release. They do not make the download independent of this repository: `SHA256SUMS.txt` comes from the same release as the files, so you are trusting the repo owner exactly as much as you do when you `git pull`.

**Undo.** `node ~/.grip/grip-bridge.mjs update --rollback` puts the previous bridge back. Only the bridge goes back: the plugin files in `~/.grip/figma-plugin` stay at the new version.

<details>
<summary>Agent: read this when the user asks you to update Grip.</summary>

- Call `grip_update` with `action: "check"`. Tell the user the installed and latest versions and what is new (the release notes it returns). **Do not install until they say yes.** If it reports `signalled: false` with a `blockedReason` (for example a connected Figma plugin is too old), do not install: tell the user the reason and what to do (update the Grip plugin in Figma first).
- On a clear yes, call `grip_update` with `action: "install"` and `version` set to the exact `latest` you showed the user (`version` is required; if a newer release has appeared the call fails with `version_changed` and returns its notes: show them and ask again). If your client can show prompts, the bridge asks the user itself and may answer `declined`; respect that. Then tell them the bridge restarts within a second (you may need to retry once or reconnect) and that the plugin needs re-running in Figma.
- If the tool answers `plugins_unverifiable`, ask the user to open the Grip plugin in Figma and try again. If it answers `incompatible_plugin`, relay the reason.
- If the tool answers `clone_install`, this is a developer install: tell the user to run `git pull && npm run build && node bridge/install.mjs` in their clone. Do not work around it.
- If `grip_update` does not exist, Grip is older than 0.8.0 and cannot update itself: follow the install instructions above (step 2 covers the "already installed" case and asks the user first).
- If the check fails or reports no network, say so and stop; do not fetch Grip from anywhere except this repository's releases.

</details>

## For developers

Install from a clone when you want to change Grip:

```sh
npm run setup                  # install dependencies for both halves (npm ci: lockfile-pinned, so your build matches CI's)
npm run build                  # a LOCAL build: bridge/grip-bridge.mjs, bridge/install.mjs, bridge/THIRD-PARTY-NOTICES.txt and figma-plugin/code.js (all gitignored)
node bridge/install.mjs        # try that build: install it into ~/.grip (a "developer install"; add --http for the always-on daemon)
npm test                       # builds first, then the bridge suites and the release gate, packager, hygiene and notices tests
```

**Nothing generated is committed.** The release bundles are built only by CI, from source, and published as release assets; `bridge/` and `figma-plugin/code.js` are gitignored build output that `npm run build` writes locally. Only the hand-written `figma-plugin/manifest.json` and `figma-plugin/ui.html` are in git. A clone must be built before you import the plugin from `figma-plugin/` or run `node bridge/install.mjs` (the installer warns, and does not copy the plugin, if `code.js` is missing). Use `npm run setup` (`npm ci`), never a bare `npm install`, so your dependencies are exactly the lockfile's, as in CI.

A clone install is recorded in `~/.grip/install.json` (`{"source":"clone"}`), which is why the in-place updater leaves it alone: update with `git pull && npm run build && node bridge/install.mjs`.

Tip: if macOS shows Gatekeeper warnings about `esbuild` (or any `node_modules` binary) in a cloud-synced folder such as Dropbox or iCloud, keep your clone outside the synced folder and run npm there.

For live work, `npm --prefix src/plugin run dev` watches the plugin (it hot-reloads in Figma); the bridge picks up changes when its parent agent restarts.

### Releasing

Releases are cut by CI. Do not create tags or releases by hand.

1. Bump the version in the four lockstep places: `BRIDGE_VERSION` in `src/bridge/src/types.ts`, `PLUGIN_VERSION` in `src/plugin/code.ts`, and `version` in `src/bridge/package.json` and `src/plugin/package.json` (`npm run package` refuses to build if they differ).
2. **Check `MIN_PLUGIN_VERSION`** in `src/bridge/src/types.ts`: the oldest Figma plugin this bridge release works with. It becomes the release's `compat.json` (generated by `scripts/package-release.mjs`, never hand-edited), and the updater only signals or installs a release to people whose connected plugins are at least that version. Leave it alone unless the release needs plugin features or protocol that older plugins lack. **If you raise it, publish the new plugin in Figma BEFORE cutting the bridge release** (people can only update the plugin through Figma, and until they do the bridge update is withheld from them), and add a line to the CHANGELOG saying the plugin must be updated first.
3. Add a `## <version>` section to the top of [`CHANGELOG.md`](./CHANGELOG.md): the exact version number, a one-line bold headline, then plain bullets a designer can read. The section becomes the release notes, and the release does not publish without it. CI appends an install footer to every release body (after a `<!-- grip-install -->` marker line: "tell your agent `Install Grip from https://github.com/spendolas/grip/releases/latest`", plus a link to the README at that release's tag); update notices cut everything from that marker, so do not write one yourself.
4. Push to `main`. There is nothing to build or commit first: bundles are not in git. [`.github/workflows/release.yml`](./.github/workflows/release.yml) runs `npm ci`, builds the bundles from source (`npm run build`, which also enforces the license allowlist and writes the third-party notices), runs the hygiene check (no developer paths or secret-looking values in anything that ships), `npm audit --omit=dev --audit-level=high` (release runs only), `npm test`, packages the eight assets (`node scripts/package-release.mjs`: `grip-bridge.mjs`, `grip-plugin-*` (three files), `grip-install.zip`, `compat.json`, `THIRD-PARTY-NOTICES.txt`, `SHA256SUMS.txt`), smoke-tests the zip install, and publishes release `v<version>` with the notes. A push that does not bump the version publishes nothing. **Run workflow** (manual) is a dry run by default: it only uploads the assets as a workflow artifact.

## Licence

[PolyForm Shield 1.0.0](./LICENSE.md) — use it freely, including commercially at work; modify and share it. You may not use it to build something that competes with Grip.
