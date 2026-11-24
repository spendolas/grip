// Run: node --test scripts/workflow-paths.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => readFileSync(join(root, '.github', 'workflows', name), 'utf8');

test('release.yml triggers on flavour/** and not the generated figma-plugin/**', () => {
  const yml = read('release.yml');
  const paths = yml.slice(yml.indexOf('paths:'), yml.indexOf('workflow_dispatch:'));
  assert.ok(paths.includes("'flavour/**'"), 'paths must list flavour/**');
  assert.ok(!paths.includes('figma-plugin/**'), 'paths must not list figma-plugin/**');
});

test('release.yml smoke test does not hard-code the home directory', () => {
  assert.ok(!read('release.yml').includes('home/.grip'));
});

test('test.yml runs on all three OS runners and the Windows subset', () => {
  const yml = read('test.yml');
  for (const os of ['ubuntu-latest', 'macos-latest', 'windows-latest']) assert.ok(yml.includes(os), os);
  assert.ok(yml.includes('test:win'));
});

test('test.yml runs the foreign guard tests (test:cross) on every OS', () => {
  const yml = read('test.yml');
  assert.ok(yml.includes('test:cross'));
  // the step has no OS condition: it runs on all three runners
  const step = yml.slice(yml.indexOf('- name: Foreign guard tests'));
  assert.ok(!step.slice(0, step.indexOf('- name: Full test suite')).includes('if:'));
});
