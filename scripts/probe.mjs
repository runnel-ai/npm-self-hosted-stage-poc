import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REGISTRY = 'https://registry.npmjs.org';
export const DIST_TAG = 'next';
export const PROBE_TEXT = 'self-hosted staging probe\n';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = join(ROOT, 'out');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function readSettings(env = process.env) {
  const packageName = env.POC_PACKAGE_NAME || '@example/ocr-stage-poc-example';
  const version = env.POC_VERSION || '0.0.1';
  assert(/^@[a-z0-9][a-z0-9-]*\/ocr-stage-poc-[a-z0-9][a-z0-9-]*$/.test(packageName),
    'POC_PACKAGE_NAME must be @scope/ocr-stage-poc-<test-name>. Production package names are not accepted.');
  assert(packageName.length <= 214, 'The package name is too long.');
  assert(/^0\.0\.(0|[1-9][0-9]{0,8})$/.test(version), 'POC_VERSION must be a test version such as 0.0.1 or 0.0.2.');
  return { packageName, version };
}

export function integrityOf(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

export function checkIntegrity(value) {
  assert(typeof value === 'string' && /^sha512-[A-Za-z0-9+/]{86}==$/.test(value),
    'Expected a SHA-512 SRI value (sha512-...), copied from the original stage manifest.');
  return value;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function summarize(lines) {
  const text = `${lines.join('\n')}\n`;
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
}

async function withNpm(fn, token) {
  const temporary = mkdtempSync(join(tmpdir(), 'ocr-stage-poc-'));
  try {
    const config = join(temporary, 'user.npmrc');
    const globalConfig = join(temporary, 'global.npmrc');
    writeFileSync(config, `registry=${REGISTRY}/\n${token ? '//registry.npmjs.org/:_authToken=${NPM_STAGE_TOKEN}\n' : ''}`, { mode: 0o600 });
    writeFileSync(globalConfig, '', { mode: 0o600 });
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(npm_config_|npm_token$|node_auth_token$|npm_stage_token$|node_options$)/i.test(key)));
    Object.assign(env, {
      NPM_CONFIG_USERCONFIG: config,
      NPM_CONFIG_GLOBALCONFIG: globalConfig,
      NPM_CONFIG_CACHE: join(temporary, 'cache'),
      NPM_CONFIG_UPDATE_NOTIFIER: 'false',
      NPM_CONFIG_AUDIT: 'false',
      NPM_CONFIG_FUND: 'false',
      // Fast-fail only suits the tiny probe tarball (~300 B). Do not copy these
      // values to production-sized packages (tens of MB): raise the timeout or use npm defaults.
      NPM_CONFIG_FETCH_RETRIES: '0',
      NPM_CONFIG_FETCH_TIMEOUT: '30000',
    });
    if (token) env.NPM_STAGE_TOKEN = token;
    const npm = (args, cwd = temporary) => {
      const result = spawnSync('npm', args, {
        cwd, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
      });
      if (result.error || result.status !== 0) {
        // Do not persist npm's raw diagnostics, which may include authentication data.
        const code = result.stderr?.match(/(?:npm (?:error|ERR!) code)\s+([A-Z0-9_]+)/)?.[1];
        throw new Error(`npm ${args.slice(0, 2).join(' ')} failed (${code || result.error?.code || `exit ${result.status}`}). Check tool support, registry access and test-package permissions. No automatic retry was made.`);
      }
      return result.stdout.trim();
    };
    return await fn({ npm, temporary });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export async function pack(settings, output = OUTPUT) {
  assert(!existsSync(join(output, 'manifest.json')), 'out/manifest.json already exists. Save its evidence, then remove out/ before preparing another package.');
  return withNpm(async ({ npm, temporary }) => {
    const fixture = join(temporary, 'fixture');
    mkdirSync(fixture);
    writeJson(join(fixture, 'package.json'), {
      name: settings.packageName,
      version: settings.version,
      description: 'Harmless self-hosted npm staging probe',
      files: ['probe.txt'],
      license: 'UNLICENSED',
      publishConfig: { access: 'public' },
    });
    writeFileSync(join(fixture, 'probe.txt'), PROBE_TEXT);
    const [result] = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--offline'], fixture));
    assert(result.name === settings.packageName && result.version === settings.version, 'Unexpected packed package identity.');
    const files = result.files.map((file) => file.path).sort();
    assert(JSON.stringify(files) === JSON.stringify(['package.json', 'probe.txt']), 'The probe must contain exactly package.json and probe.txt.');
    const source = join(fixture, result.filename);
    const integrity = integrityOf(readFileSync(source));
    assert(integrity === result.integrity, 'npm pack returned an unexpected integrity value.');
    mkdirSync(output, { recursive: true });
    copyFileSync(source, join(output, 'package.tgz'));
    const manifest = {
      schemaVersion: 1,
      ...settings,
      registry: REGISTRY,
      distTag: DIST_TAG,
      tarball: 'package.tgz',
      integrity,
      shasum: result.shasum,
      files,
      toolchain: { node: process.version, npm: npm(['--version']) },
      source: {
        repository: process.env.GITHUB_REPOSITORY || null,
        commit: process.env.GITHUB_SHA || null,
        runId: process.env.GITHUB_RUN_ID || null,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
        image: process.env.POC_NODE_IMAGE || null,
      },
      phase: 'packed',
    };
    writeJson(join(output, 'manifest.json'), manifest);
    if (output === OUTPUT) summarize([
      `Packed ${settings.packageName}@${settings.version}; no registry write.`,
      `Toolchain: Node ${manifest.toolchain.node}, npm ${manifest.toolchain.npm}.`,
      `Integrity: \`${integrity}\``,
      'Files: package.json, probe.txt. Evidence: out/package.tgz and out/manifest.json.',
    ]);
    return manifest;
  });
}

export function readRegistryResponse(status, body, allowMissing = false) {
  assert((status >= 200 && status < 300) || (allowMissing && status === 404), `Public registry query returned HTTP ${status}; this is not proof that a version is absent.`);
  if (status === 404) {
    const message = typeof body === 'string' ? body : body?.error;
    assert(typeof message === 'string' && /not found/i.test(message), 'The registry returned an unexpected 404 response.');
    return null;
  }
  return body;
}

async function registryJson(path, allowMissing = false) {
  const response = await fetch(`${REGISTRY}${path}`, {
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  return readRegistryResponse(response.status, await response.json(), allowMissing);
}

function versionPath(settings) {
  return `/${encodeURIComponent(settings.packageName)}/${encodeURIComponent(settings.version)}`;
}

export function readStageResult(raw, manifest) {
  const result = raw?.[manifest.packageName];
  assert(result && result.name === manifest.packageName && result.version === manifest.version, 'Unexpected stage JSON package identity. Inspect staged packages manually before retrying.');
  assert(typeof result.stageId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(result.stageId), 'The stage response has no valid UUID. Inspect staged packages manually before retrying.');
  assert(result.integrity === manifest.integrity, 'The staged tarball integrity differs from the prepared tarball. Do not approve.');
  return { packageName: result.name, version: result.version, stageId: result.stageId, integrity: result.integrity };
}

async function stage(settings, output = OUTPUT) {
  const token = process.env.NPM_STAGE_TOKEN;
  assert(token, 'NPM_STAGE_TOKEN is required only for stage.');
  assert(!settings.packageName.startsWith('@example/'), 'Configure your authorized test package before staging.');
  const manifestPath = join(output, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert(manifest.packageName === settings.packageName && manifest.version === settings.version && manifest.registry === REGISTRY && manifest.distTag === DIST_TAG,
    'The manifest does not match the requested test package.');
  assert(manifest.phase === 'packed', 'This manifest already records a stage attempt. Inspect the original stage before doing anything else.');
  const tarball = join(output, 'package.tgz');
  assert(integrityOf(readFileSync(tarball)) === manifest.integrity, 'The prepared tarball has changed. Do not upload.');
  await registryJson('/-/ping');
  assert(await registryJson(versionPath(settings), true) === null, 'This version is already public. Use a new test version.');
  return withNpm(async ({ npm }) => {
    npm(['stage', '--help']);
    manifest.phase = 'stage-attempted';
    writeJson(manifestPath, manifest);
    summarize([`Attempting stage for ${settings.packageName}@${settings.version}. If the upload result is unclear, inspect npm stage list on a trusted terminal before retrying.`]);
    const raw = JSON.parse(npm(['stage', 'publish', tarball, '--registry', REGISTRY, '--access', 'public', '--tag', DIST_TAG, '--ignore-scripts', '--json']));
    const result = readStageResult(raw, manifest);
    writeJson(join(output, 'stage-result.json'), result);
    Object.assign(manifest, { phase: 'staged', stageId: result.stageId, stagedAt: new Date().toISOString() });
    writeJson(manifestPath, manifest);
    summarize([
      `Stage UUID: \`${result.stageId}\``,
      `Original integrity: \`${manifest.integrity}\``,
      'Uploaded for review. This is not approval or a completed publication.',
    ]);
    const view = JSON.parse(npm(['stage', 'view', result.stageId, '--json']));
    assert(view.id === result.stageId && view.packageName === settings.packageName && view.version === settings.version && view.tag === DIST_TAG,
      'The staged record could not be matched to this upload. Inspect it on a trusted terminal before approving.');
    writeJson(join(output, 'stage-view.json'), {
      id: view.id, packageName: view.packageName, version: view.version, tag: view.tag, shasum: view.shasum, status: view.status,
    });
    const absent = await registryJson(versionPath(settings), true) === null;
    manifest.publicBeforeApproval = !absent;
    const publicPackage = await registryJson(`/${encodeURIComponent(settings.packageName)}`, true);
    manifest.packageNamePublicBeforeApproval = publicPackage !== null;
    writeJson(manifestPath, manifest);
    assert(absent, 'The test version is already publicly visible. The expected pre-approval state was not observed.');
    summarize(['Anonymous registry query confirmed the exact test version is not public yet. Review the saved tarball and staged content on a trusted terminal before approving.']);
    return manifest;
  }, token);
}

export function checkPublished(metadata, settings, expectedIntegrity) {
  assert(metadata?.name === settings.packageName && metadata.version === settings.version, 'The public package identity does not match the requested version.');
  assert(metadata.dist?.integrity === expectedIntegrity, 'The public package integrity differs from the original stage manifest.');
  for (const field of ['dependencies', 'optionalDependencies', 'devDependencies', 'peerDependencies', 'scripts']) {
    assert(Object.keys(metadata[field] || {}).length === 0, `The public probe unexpectedly contains ${field}.`);
  }
}

async function verify(settings, output = OUTPUT) {
  const expectedIntegrity = checkIntegrity(process.env.POC_EXPECTED_INTEGRITY);
  await registryJson('/-/ping');
  const metadata = await registryJson(versionPath(settings));
  checkPublished(metadata, settings, expectedIntegrity);
  const tags = await registryJson(`/-/package/${encodeURIComponent(settings.packageName)}/dist-tags`);
  assert(tags[DIST_TAG] === settings.version, `The ${DIST_TAG} dist-tag does not point to this test version.`);
  return withNpm(async ({ npm, temporary }) => {
    const consumer = join(temporary, 'consumer');
    mkdirSync(consumer);
    writeJson(join(consumer, 'package.json'), { name: 'ocr-stage-poc-consumer', version: '0.0.0', private: true });
    npm(['install', `${settings.packageName}@${settings.version}`, '--registry', REGISTRY, '--ignore-scripts', '--no-audit', '--no-fund'], consumer);
    const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8'));
    const installedKey = `node_modules/${settings.packageName}`;
    assert(Object.keys(lock.packages).filter((key) => key !== '').length === 1, 'The install unexpectedly resolved additional packages.');
    assert(lock.packages[installedKey]?.integrity === expectedIntegrity, 'The installed tarball integrity differs from the original stage manifest.');
    const installed = join(consumer, installedKey);
    const pkg = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
    checkPublished({ ...pkg, dist: { integrity: lock.packages[installedKey].integrity } }, settings, expectedIntegrity);
    assert(readFileSync(join(installed, 'probe.txt'), 'utf8') === PROBE_TEXT, 'Installed probe.txt has unexpected content.');
    const result = {
      ...settings,
      registry: REGISTRY,
      integrity: expectedIntegrity,
      distTags: tags,
      toolchain: { node: process.version, npm: npm(['--version']) },
      verifiedAt: new Date().toISOString(),
      installedWithoutCredentials: true,
      probeTextMatches: true,
    };
    mkdirSync(output, { recursive: true });
    writeJson(join(output, 'verification.json'), result);
    summarize([`Verified anonymous installation of ${settings.packageName}@${settings.version}.`, `Toolchain: Node ${result.toolchain.node}, npm ${result.toolchain.npm}.`, 'Original tarball integrity, installed package, probe.txt and next all match. Evidence: out/verification.json.']);
    return result;
  });
}

export async function main(mode = process.argv[2]) {
  const settings = readSettings();
  if (mode === 'pack') return pack(settings);
  if (mode === 'stage') return stage(settings);
  if (mode === 'verify') return verify(settings);
  throw new Error('Usage: node scripts/probe.mjs pack|stage|verify');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`Probe failed: ${error.message}`);
    process.exitCode = 1;
  });
}
