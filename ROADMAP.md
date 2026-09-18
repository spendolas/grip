# Roadmap — a public build

Grip is published **privately to an organization**. This document is the plan for
reaching a wider audience, and the constraint that shapes it.

Status: design, not implementation. Facts marked *verified* were checked against
the shipped typings or observed live; the rest is reasoning and should be
prototyped before anyone bets on it.

## The constraint

`figma.fileKey` is the single value Grip's file routing depends on. It is gated:

> The file key of the current file is only available to private plugins and
> Figma-owned resources. To enable this behavior, you need to specify
> `enablePrivatePluginApi` in your `manifest.json`.

And that flag cannot be used publicly — *"You can't set enablePrivatePluginApi to
true on a public plugin. File key is not accessible to public plugins as it would
be a security concern."*

*Verified:* the typings declare `readonly fileKey: string | undefined` with that
requirement in its doc comment, and there is **no** other API returning a link or
identifier for the current file. `DocumentNode` exposes only `type`, `children`
and `documentColorProfile`. There is no file creation date, author, or modified
time to fall back on. Every URL-shaped property in the API belongs to something
else (dev resources, embeds, user avatars).

*Verified:* a **development import** keeps private API regardless of org — Grip
returned a real `fileKey` in a file belonging to another organization. So this
constraint applies only to a publicly published build.

## What breaks without a file key

The plugin falls back to `figma.root.id`, which is the constant `"0:0"` in every
file. All files then look identical, which takes out:

- `set_active_file` by fileKey or figma.com URL
- `GRIP_FILE` launch binding by key or URL
- `get_deep_link` (already returns `available:false` when the key is `"0:0"`)
- sticky re-binding after a plugin reconnect, which resolves by fileKey

Binding by **file name** and by **sessionId** survives, because `root.name` is not
gated. All 150 tools, every read and write, and single-file use are unaffected.
This is a targeting regression, not a functional one.

## The plan: a self-seeded file id

Rather than ask users to paste a file URL — the common workaround, and a poor one,
since most implementations make people re-paste on every file switch — Grip mints
its own identifier.

On first run in a file, generate a UUID and write it to the document with the file
name beside it:

```js
figma.root.setPluginData('grip.fileId', uuid)
figma.root.setPluginData('grip.fileName', figma.root.name)
```

*Verified:* `DocumentNode extends BaseNodeMixin`, so plugin data on the root is
available. It lives in the document, so it persists forever and every teammate who
opens the file gets the same id without ever seeing a prompt.

Subsequent runs read it back and send it in the `hello` as the file's identity.
Routing then works exactly as it does today, with our id in place of Figma's.

### Duplication, and why it is survivable here

Duplicating a file copies its plugin data, so a copy would claim its parent's id.
This is the known flaw of document-stored identifiers and it is why the same trick
fails for a *pasted* fileKey — a wrong real key cannot be corrected, because
nothing can derive the right one.

An id we mint can simply be re-minted. Two mechanisms:

**Copy opened alone.** Compare the stored name against `figma.root.name`. Figma
names duplicates "(Copy)", so a mismatch means copy-or-rename — re-seed. A
legitimate rename costs one new id and one rebind.

**Copy opened alongside its original.** The bridge sees every session at once. Two
sessions presenting the same id is a definitive collision; the bridge tells one to
re-seed. Self-healing rather than merely detected, and consistent with Grip's
existing refusal to guess between files.

### What this does not solve

Deep links. A figma.com URL needs Figma's real key, and ours is meaningless to
figma.com. `get_deep_link` stays unavailable on public builds.

This composes with the paste workaround rather than competing: auto-seeding
handles routing invisibly, and an optional one-time URL paste can add the real key
purely to light up deep links. The common path stays frictionless; the extra step
exists only for the feature that genuinely requires it.

### Caveats

- Seeding needs edit access. View-only files fall back to name and session id.
- It writes to the document. Invisible, but a write, and some users will object.

## Capability tiering

The `hello` already carries capabilities. Whether a real `fileKey` arrives is
itself the signal — present means org or dev install, absent means public build —
so the bridge tiers behaviour off what it is handed. One codebase, two manifests,
no divergent code paths.

This is a genuine tier rather than a crippled build:

| | Public (Community) | Org-private / dev import |
|---|---|---|
| All 150 tools | yes | yes |
| Multi-file routing | by name, session id, seeded id | plus fileKey and URL |
| Deep links | no (unless a URL is pasted) | yes |

## Sequencing

**Signed installer before Community listing.**

The barrier to a wide audience is not the plugin. It is asking people to run
developer tooling: today the bridge is installed with `node bridge/install.mjs`
from a cloned repo — an unsigned script that writes to the user's home directory
and edits their agent config.

Overlord is the useful comparison: same architecture (Figma plugin plus a local
desktop app over a local connection), published publicly, and not a hard sell —
because it ships a signed, notarised application with a real installer. Same
architecture, completely different ask.

Closing that gap means:

1. A self-contained binary with the runtime embedded. The esbuild bundle removed
   npm and `node_modules`, but Node is still a prerequisite, and "install Node
   first" loses most people.
2. Signing and notarisation — Apple Developer on macOS, a code-signing certificate
   on Windows. Without them Gatekeeper and SmartScreen actively warn users off,
   which is worse than shipping no installer at all.
3. A normal per-platform installer, and ideally auto-update, since a bridge that
   silently goes stale against a newer plugin is its own support burden.

Publishing before this exists spends the first impression on the weakest part of
the experience. The plugin work is small and will not rot; a bad launch does not
undo as easily.

## Open questions

- Is a document write acceptable by default, or should seeding be opt-in?
- Should a public build refuse multi-file work outright, or allow name-based
  binding across several files? Name binding works, but "current file only" is a
  simpler promise to make and to explain.
- Does the annual cost of certificates justify a Community listing at all, given
  the dev-import path already serves anyone technical enough to want Grip?

## References

- [figma.fileKey is private-plugin only](https://forum.figma.com/ask-the-community-7/how-to-use-figma-filekey-45224)
- [enablePrivatePluginApi cannot be set on a public plugin](https://forum.figma.com/t/setting-enableprivatepluginapi-to-true-on-a-community-published-plugin/1699)
- [Document-stored ids duplicate with the file](https://forum.figma.com/archive-21/unique-file-identifier-34128)
- [Private plugins are scoped to their organization](https://help.figma.com/hc/en-us/articles/4404228629655-Create-private-organization-plugins)
- [Overlord](https://battleaxe.co/overlord) — same architecture, public, signed installer
