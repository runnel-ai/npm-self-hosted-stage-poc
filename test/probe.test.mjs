import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import { checkIntegrity, checkPublished, integrityOf, pack, PROBE_TEXT, readRegistryResponse, readSettings, readStageResult } from '../scripts/probe.mjs';

test('rejects production package names, option injection and non-test versions', () => {
  for (const packageName of ['@alibaba-group/open-code-review', 'plain-package', '--help', '@scope/ocr-stage-poc-../../x']) {
    assert.throws(() => readSettings({ POC_PACKAGE_NAME: packageName }));
  }
  for (const version of ['1.0.0', '0.0.01', '0.0.1; echo bad', '../x']) {
    assert.throws(() => readSettings({ POC_VERSION: version }));
  }
  assert.equal(readSettings({}).version, '0.0.1');
});

test('reads keyed npm stage JSON and rejects a different package or tarball', () => {
  const manifest = { packageName: '@test/ocr-stage-poc-test', version: '0.0.1', integrity: integrityOf('test') };
  const value = { name: manifest.packageName, version: manifest.version, integrity: manifest.integrity, stageId: '00000000-0000-4000-8000-000000000001' };
  assert.equal(readStageResult({ [manifest.packageName]: value }, manifest).stageId, value.stageId);
  assert.throws(() => readStageResult(value, manifest));
  assert.throws(() => readStageResult({ [manifest.packageName]: { ...value, integrity: integrityOf('changed') } }, manifest));
  assert.throws(() => readStageResult({ [manifest.packageName]: { ...value, stageId: 'bad-id' } }, manifest));
});

test('verification requires the original integrity and a dependency-free package', () => {
  const settings = readSettings();
  const integrity = integrityOf('expected');
  assert.equal(checkIntegrity(integrity), integrity);
  assert.throws(() => checkIntegrity('sha512-invalid'));
  const metadata = { name: settings.packageName, version: settings.version, dist: { integrity } };
  checkPublished(metadata, settings, integrity);
  assert.throws(() => checkPublished(metadata, settings, integrityOf('different')));
  assert.throws(() => checkPublished({ ...metadata, dependencies: { extra: '1.0.0' } }, settings, integrity));
  assert.throws(() => checkPublished({ ...metadata, scripts: { postinstall: 'anything' } }, settings, integrity));
});

test('registry string and object 404 responses are distinct from access and network failures', () => {
  for (const body of ['Not Found', 'version not found: 0.0.1', { error: 'Not found' }]) {
    assert.equal(readRegistryResponse(404, body, true), null);
  }
  for (const status of [401, 403, 429, 500, 503]) {
    assert.throws(() => readRegistryResponse(status, { error: 'Not found' }, true));
  }
  assert.throws(() => readRegistryResponse(404, 'Not Found'));
  assert.throws(() => readRegistryResponse(404, '<html>proxy error</html>', true));
  assert.deepEqual(readRegistryResponse(200, { version: '0.0.1' }), { version: '0.0.1' });
});

test('real offline npm pack contains exactly the harmless files and recorded digest', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'ocr-stage-poc-test-'));
  try {
    const manifest = await pack(readSettings(), temporary);
    const tarball = readFileSync(join(temporary, 'package.tgz'));
    assert.equal(integrityOf(tarball), manifest.integrity);
    const tar = gunzipSync(tarball);
    const entries = new Map();
    for (let offset = 0; offset + 512 <= tar.length;) {
      const header = tar.subarray(offset, offset + 512);
      const name = header.subarray(0, 100).toString().replace(/\0.*$/s, '');
      if (!name) break;
      const size = Number.parseInt(header.subarray(124, 136).toString().replace(/\0.*$/s, '').trim(), 8) || 0;
      entries.set(name, tar.subarray(offset + 512, offset + 512 + size).toString());
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    assert.deepEqual([...entries.keys()].sort(), ['package/package.json', 'package/probe.txt']);
    assert.equal(entries.get('package/probe.txt'), PROBE_TEXT);
    const pkg = JSON.parse(entries.get('package/package.json'));
    assert.equal(pkg.name, manifest.packageName);
    assert.equal(pkg.version, manifest.version);
    assert.equal(pkg.dependencies, undefined);
    assert.equal(pkg.scripts, undefined);
    await assert.rejects(pack(readSettings(), temporary), /already exists/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
