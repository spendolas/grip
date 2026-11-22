// Update policy that depends on the flavour: whether the environment may redirect
// the update source, and where release assets may be downloaded from.

// The releases URL of a GitHub repo -> the only path its assets are downloaded from.
// `https://api.github.com/repos/<O>/<R>/releases/latest` ->
// `https://github.com/<O>/<R>/releases/download/`. null for any other shape (a test
// server, a fork on another host): no pinning is applied there, which is why a flavour
// with lockOverrides must use this shape (scripts/gen-flavour.mjs isGithubReleasesApi,
// kept equal by test/flavour.mjs). update.ts compares against it case-insensitively.
export function downloadPrefixFor(releasesApi: string): string | null {
  let u: URL;
  try { u = new URL(releasesApi); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname !== 'api.github.com' || u.port !== '' || u.username || u.password || u.search || u.hash) return null;
  const m = /^\/repos\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/releases\/latest\/?$/.exec(u.pathname);
  return m ? `https://github.com/${m[1]}/${m[2]}/releases/download/` : null;
}

// A flavour that locks its overrides never lets GRIP_RELEASES_API or
// GRIP_RELEASE_PUBKEY change where updates come from or whom they are trusted from
// (not even with GRIP_TEST=1).
export function overridesAllowed(f: { lockOverrides: boolean }): boolean {
  return !f.lockOverrides;
}
