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

## Confirming the file: the amber handshake

A pasted figma.com link is the most natural way a user says "work on this" — and
on a public build it fails today, because the key in the URL matches no session.
The URL still carries the file name as a slug, which is the way in:

```
figma.com/design/tc5ASMCGihXdPgtaMxub8t/Plugin-Dev?node-id=570-4100
                 |___ real key ____|    |__ name __|
```

Match the slug against connected sessions' `root.name` to find candidates. But a
name match is an inference, not proof — so ask.

**The strip turns amber and slowly blinks in the file Grip believes it is in.**
Clicking confirms. This is correct by construction: the signal appears in a
specific file, so a wrong guess shows up somewhere the user did not mean and
simply never gets clicked. Nothing can be confirmed by accident.

On confirmation the plugin writes the real key from the URL into the document, so
the cost is paid once and every later session resolves silently — with working
deep links, since it is Figma's own key.

### Why this beats asking for a paste

No key literacy, no URL typing, no settings panel. A file key is not something a
human can verify by looking at it; "is this the file you meant?" is. The question
is asked in the one place where the answer is obvious.

### Multi-candidate resolution

When several sessions match — same file name, or an ambiguous slug — blink amber
in **all** of them and let whichever is clicked win. This turns
`ambiguous_active_file`, currently a hard error, into a one-click resolution, with
the human supplying context the bridge cannot have.

Worth considering on the org build too, not just public: it is a better answer to
ambiguity than an error message in either case.

### The signal

Amber is currently dead. Its only trigger in `ui.html` is a WebSocket close with
code `1000` and reason `"duplicate"`, and the bridge never sends that — grep finds
it nowhere in `src/bridge/src`. It is a colour, a CSS class and a branch that has
never fired, left behind when the bridge stopped rejecting second connections.

Retire that branch as part of this work, so amber has exactly one meaning.

Blink spec: a slow breath, around a 2s cycle, easing down to roughly 0.45 opacity
and back. Two requirements:

- **Clearly slower than the 900ms busy pulse.** Colour differs, but motion is what
  the eye catches first; at similar timings the two states are indistinguishable.
- **A deeper dip than the busy pulse's 0.55.** This has to be noticed peripherally
  by someone looking at the canvas, not at a 120x32 strip. Static amber is far too
  easy to miss for something that is asking the user to act.

Amber persists until clicked or timed out, so it needs no minimum display time.

### While we are in here: the green busy pulse never completes

Separate bug, same strip. The busy pulse is a 900ms cycle, but real tool calls are
far shorter than that. Measured in one session against a live file:

```
rescale 183 stars      211 ms
rescale 183 stars      226 ms
recolour 200 stars     238 ms
create 205 stars       767 ms
clone 200 icons       1255 ms
```

Most calls finish in a quarter to a half of one cycle. The class is removed
part-way through, so the strip dims slightly, snaps back, and the user sees
nothing. The indicator is calibrated for operations far longer than the ones that
actually happen — it is clearly visible on an artificial 8-second call and almost
never in real use.

The fix is **not** a minimum display time. Two rules:

1. **Never stop mid-cycle.** When busy reaches zero, do not remove the class
   immediately — mark it to stop and remove it on the next `animationiteration`,
   so the strip always lands back at full opacity on a cycle boundary.
2. **Coalesce, do not restart.** If `busy: true` arrives during that wind-down,
   cancel the pending stop and let the *same* animation continue. Removing and
   re-adding the class restarts the CSS animation, which makes a burst of quick
   calls stutter — each one visibly jumping back to the start. Continuing the
   existing animation makes a burst read as one uninterrupted breath.

`animationiteration` is the primitive for both: it fires at each cycle boundary,
which is the only safe moment to stop.

### Failure path

If nobody clicks, time out and say so plainly — "couldn't confirm which file you
meant, nothing was changed" — rather than hanging or quietly picking one.

### Limitation

It requires the user to look at Figma. Fine for a once-per-file handshake, wrong
for anything more frequent.

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
