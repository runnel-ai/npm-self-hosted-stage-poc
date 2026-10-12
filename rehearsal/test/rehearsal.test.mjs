import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { PLATFORMS, fakeBinary, pack, parseStageList, readSettings } from '../scripts/rehearsal.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = join(ROOT, 'packages');
const require = createRequire(import.meta.url);

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('main package mirrors the production structure on the test scope', () => {
  const pkg = readJson(join(PACKAGES, 'main', 'package.json'));
  assert.equal(pkg.name, '@airport233/ocr-rehearsal');
  assert.equal(pkg.bin['ocr-rehearsal'], 'bin/ocr.js');
  assert.equal(pkg.scripts.postinstall, 'node scripts/install.js');
  for (const file of ['bin/ocr.js', 'scripts/install.js', 'scripts/update.js', 'scripts/version.js', 'scripts/platform.js']) {
    assert.ok(pkg.files.includes(file), `files must include ${file}`);
  }
  const deps = Object.entries(pkg.optionalDependencies);
  assert.equal(deps.length, 6);
  for (const [name, version] of deps) {
    assert.ok(name.startsWith('@airport233/ocr-'), `unexpected optional dependency ${name}`);
    assert.equal(version, '0.0.0', 'source placeholder version must remain 0.0.0');
  }
  assert.ok(pkg.ocrConfig.urlPattern.includes('runnel-ai/npm-self-hosted-stage-poc'));
});

test('platform packages carry matching os/cpu metadata', () => {
  for (const platform of PLATFORMS) {
    const [os, cpu] = platform.split('-');
    const pkg = readJson(join(PACKAGES, 'platforms', platform, 'package.json'));
    assert.equal(pkg.name, `@airport233/ocr-${platform}`);
    assert.deepEqual(pkg.os, [os]);
    assert.deepEqual(pkg.cpu, [cpu]);
    assert.deepEqual(pkg.files, ['bin/']);
    assert.equal(pkg.publishConfig.access, 'public');
  }
});

test('copied launcher scripts no longer reference the production scope', () => {
  for (const file of ['bin/ocr.js', 'scripts/install.js', 'scripts/platform.js', 'scripts/update.js', 'scripts/version.js']) {
    const text = readFileSync(join(PACKAGES, 'main', file), 'utf8');
    assert.ok(!text.includes('@alibaba-group'), `${file} still references @alibaba-group`);
    assert.ok(text.includes('SPDX-License-Identifier'), `${file} lost its SPDX header`);
  }
});

test('copied platform.js resolves the test-scope platform package', () => {
  const platform = require(join(PACKAGES, 'main', 'scripts', 'platform.js'));
  const name = platform.getPlatformPackageName();
  const key = `${process.platform}-${process.arch}`;
  if (PLATFORMS.includes(key)) {
    assert.equal(name, `@airport233/ocr-${key}`);
  } else {
    assert.equal(name, null);
  }
  const ocr = require(join(PACKAGES, 'main', 'bin', 'ocr.js'));
  assert.equal(typeof ocr.launcherExitCode, 'function');
});

test('fakeBinary produces an executable script except on win32', () => {
  const linux = fakeBinary('linux-x64', '0.1.0');
  assert.equal(linux.name, 'opencodereview');
  assert.equal(linux.executable, true);
  assert.ok(linux.text.startsWith('#!/bin/sh'));
  assert.ok(linux.text.includes('platform=linux-x64') && linux.text.includes('version=0.1.0'));
  const win = fakeBinary('win32-arm64', '0.1.0');
  assert.equal(win.name, 'opencodereview.exe');
  assert.equal(win.executable, false);
  assert.ok(!win.text.startsWith('#!'));
});

test('readSettings guards the production scope and validates the version', () => {
  const settings = readSettings({});
  assert.equal(settings.scope, '@airport233');
  assert.equal(settings.mainName, '@airport233/ocr-rehearsal');
  assert.equal(settings.platformNames.length, 6);
  assert.throws(() => readSettings({ POC_REHEARSAL_SCOPE: '@alibaba-group' }), /production scope/);
  assert.throws(() => readSettings({ POC_VERSION: '1.0' }), /semver/);
});

test('parseStageList finds the staged id for the exact version only', () => {
  const sample = [
    'id: 048c5e58-0d8d-4b61-a842-6c9ac1dd01e3',
    'package name: @airport233/ocr-linux-x64',
    'version: 0.1.0',
    'tag: next',
    'status: staged',
  ].join('\n');
  assert.equal(parseStageList(sample, '@airport233/ocr-linux-x64', '0.1.0'), '048c5e58-0d8d-4b61-a842-6c9ac1dd01e3');
  assert.equal(parseStageList(sample, '@airport233/ocr-linux-x64', '0.2.0'), null);
  assert.equal(parseStageList('No staged packages found.', '@airport233/ocr-linux-x64', '0.1.0'), null);
});

test('pack builds seven deterministic tarballs with the expected layout', async () => {
  const first = mkdtempSync(join(tmpdir(), 'rehearsal-pack-a-'));
  const second = mkdtempSync(join(tmpdir(), 'rehearsal-pack-b-'));
  try {
    const a = await pack(readSettings({}), first);
    const b = await pack(readSettings({}), second);
    assert.equal(a.packages.length, 7);
    const byName = Object.fromEntries(a.packages.map((entry) => [entry.name, entry]));
    for (const name of [...readSettings({}).platformNames, readSettings({}).mainName]) {
      assert.ok(byName[name], `missing ${name}`);
      assert.equal(byName[name].integrity, b.packages.find((entry) => entry.name === name).integrity, `${name} pack must be deterministic`);
    }
    for (const platform of PLATFORMS) {
      const entry = byName[`@airport233/ocr-${platform}`];
      const binaryName = platform.startsWith('win32') ? 'bin/opencodereview.exe' : 'bin/opencodereview';
      assert.deepEqual(entry.files, [binaryName, 'package.json']);
    }
    const main = byName['@airport233/ocr-rehearsal'];
    for (const file of ['bin/ocr.js', 'scripts/install.js', 'scripts/platform.js', 'scripts/update.js', 'scripts/version.js', 'package.json']) {
      assert.ok(main.files.includes(file), `main tarball must include ${file}`);
    }
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});
