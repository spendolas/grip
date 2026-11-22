// Update policy: the download-URL prefix derived from a releases URL, and the
// override lock of a flavour.
import assert from 'node:assert/strict';
import { downloadPrefixFor, overridesAllowed } from '../dist/update-policy.js';
import { parseRelease } from '../dist/update.js';

const PFX = 'https://github.com/o/r/releases/download/';
const cases = [
  ['https://api.github.com/repos/o/r/releases/latest', PFX],
  ['https://api.github.com/repos/o/r/releases/latest/', PFX],
  ['https://example.invalid/x', null],
  ['http://127.0.0.1:1/x', null],
  ['https://api.github.com.evil.test/repos/o/r/releases/latest', null],
  ['https://api.github.com/repos/o/r/releases/latest?x=1', null],
  ['https://api.github.com/repos/o/releases/latest', null],
  ['not a url', null],
];
for (const [api, want] of cases) assert.equal(downloadPrefixFor(api), want, api);

assert.equal(overridesAllowed({ lockOverrides: true }), false);
assert.equal(overridesAllowed({ lockOverrides: false }), true);

// parseRelease drops assets outside the prefix, and keeps all of them with no prefix
const rel = (urls) => Buffer.from(JSON.stringify({
  tag_name: 'v1.0.0', assets: Object.entries(urls).map(([name, u]) => ({ name, browser_download_url: u, size: 1 })),
}));
const urls = {
  'a.bin': PFX + 'v1.0.0/a.bin',
  'b.bin': 'https://github.com/other/repo/releases/download/v1.0.0/b.bin',
  'c.bin': 'https://github.com/o/r/releases/download.evil/v1/c.bin',
  'd.bin': PFX + '../../../../evil/x/releases/download/v1/d.bin',
  'e.bin': PFX + '%2e%2e/%2e%2e/%2e%2e/%2e%2e/evil/x/releases/download/v1/e.bin',
  'f.bin': PFX + '%2E%2E/%2E%2E/%2E%2E/%2E%2E/evil/x/releases/download/v1/f.bin',
  'g.bin': PFX + '..\\..\\..\\..\\evil\\x\\releases\\download\\v1\\g.bin',
  'h.bin': 'https://[bad/releases/download/v1/h.bin',
  'i.bin': 'https://github.com:444/o/r/releases/download/v1/i.bin',
};
assert.deepEqual(Object.keys(parseRelease(rel(urls), PFX).assets), ['a.bin']);
assert.deepEqual(Object.keys(parseRelease(rel(urls), null).assets).sort(), Object.keys(urls).sort());
assert.deepEqual(Object.keys(parseRelease(rel(urls)).assets).sort(), Object.keys(urls).sort());
console.log('update-policy.mjs OK');
