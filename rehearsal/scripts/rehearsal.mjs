import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REGISTRY = 'https://registry.npmjs.org';
export const DIST_TAG = 'next';
export const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64'];
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = join(ROOT, 'packages');
const OUTPUT = join(ROOT, 'out');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function readSettings(env = process.env) {
  const scope = env.POC_REHEARSAL_SCOPE || '@airport233';
  assert(/^@[a-z0-9][a-z0-9-]*$/.test(scope), 'POC_REHEARSAL_SCOPE must be a lowercase npm scope such as @airport233.');
  assert(scope !== '@alibaba-group', 'Refusing the production scope. The rehearsal only runs on a test scope.');
  const version = (env.POC_VERSION || '0.1.0').replace(/^v/, '');
  assert(/^\d+\.\d+\.\d+$/.test(version), 'POC_VERSION must be a plain semver such as 0.1.0 (a leading v from a git tag is stripped).');
  const platformVersion = env.POC_PLATFORM_VERSION || version;
  assert(/^\d+\.\d+\.\d+$/.test(platformVersion), 'POC_PLATFORM_VERSION must be a plain semver. It defaults to POC_VERSION; set it to reuse already-public platform packages.');
  return {
    scope,
    version,
    platformVersion,
    mainName: `${scope}/ocr-rehearsal`,
    platformNames: PLATFORMS.map((p) => `${scope}/ocr-${p}`),
  };
}

export function integrityOf(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

export function fakeBinary(platformKey, version) {
  if (platformKey.startsWith('win32')) {
    return { name: 'opencodereview.exe', executable: false, text: `ocr-rehearsal fake binary platform=${platformKey} version=${version} (placeholder, not executable)\n` };
  }
  return { name: 'opencodereview', executable: true, text: `#!/bin/sh\necho "ocr-rehearsal fake binary platform=${platformKey} version=${version}"\n` };
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
  const temporary = mkdtempSync(join(tmpdir(), 'ocr-rehearsal-'));
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
      // Fast-fail only suits the tiny rehearsal tarballs (~300 B). Do not copy these
      // values to production-sized packages (tens of MB): raise the timeout or use npm defaults.
      NPM_CONFIG_FETCH_RETRIES: '0',
      NPM_CONFIG_FETCH_TIMEOUT: '30000',
    });
    if (token) env.NPM_STAGE_TOKEN = token;
    const run = (args, cwd = temporary) => spawnSync('npm', args, {
      cwd, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
    });
    const npm = (args, cwd = temporary) => {
      const result = run(args, cwd);
      if (result.error || result.status !== 0) {
        const code = result.stderr?.match(/(?:npm (?:error|ERR!) code)\s+([A-Z0-9_]+)/)?.[1];
        throw new Error(`npm ${args.slice(0, 2).join(' ')} failed (${code || result.error?.code || `exit ${result.status}`}). No automatic retry was made.`);
      }
      return result.stdout.trim();
    };
    return await fn({ npm, run, temporary });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function sourceContext() {
  return {
    repository: process.env.GITHUB_REPOSITORY || null,
    commit: process.env.GITHUB_SHA || null,
    runId: process.env.GITHUB_RUN_ID || null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
    image: process.env.POC_NODE_IMAGE || null,
  };
}

async function packOne(npm, pkgDir, name, version, prepare, outDir) {
  prepare(pkgDir);
  const [result] = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--offline'], pkgDir));
  assert(result.name === name && result.version === version, `Unexpected packed identity for ${name}.`);
  const source = join(pkgDir, result.filename);
  const integrity = integrityOf(readFileSync(source));
  assert(integrity === result.integrity, `npm pack returned an unexpected integrity value for ${name}.`);
  mkdirSync(outDir, { recursive: true });
  copyFileSync(source, join(outDir, result.filename));
  return {
    name,
    version,
    tarball: `tarballs/${result.filename}`,
    integrity,
    shasum: result.shasum,
    files: result.files.map((file) => file.path).sort(),
  };
}

export async function pack(settings, output = OUTPUT) {
  assert(!existsSync(join(output, 'rehearsal-manifest.json')), 'out/rehearsal-manifest.json already exists. Save its evidence, then remove out/ before packing again.');
  return withNpm(async ({ npm, temporary }) => {
    const packages = [];
    for (const [index, platformKey] of PLATFORMS.entries()) {
      const name = settings.platformNames[index];
      const src = JSON.parse(readFileSync(join(PACKAGES, 'platforms', platformKey, 'package.json'), 'utf8'));
      const binary = fakeBinary(platformKey, settings.platformVersion);
      const entry = await packOne(npm, join(temporary, `platform-${platformKey}`), name, settings.platformVersion, (dir) => {
        mkdirSync(join(dir, 'bin'), { recursive: true });
        writeJson(join(dir, 'package.json'), { ...src, version: settings.platformVersion });
        const target = join(dir, 'bin', binary.name);
        writeFileSync(target, binary.text);
        if (binary.executable) chmodSync(target, 0o755);
      }, join(output, 'tarballs'));
      packages.push({ ...entry, platform: platformKey });
    }
    const mainEntry = await packOne(npm, join(temporary, 'main'), settings.mainName, settings.version, (dir) => {
      mkdirSync(dir, { recursive: true });
      cpSync(join(PACKAGES, 'main'), dir, { recursive: true });
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      pkg.version = settings.version;
      pkg.optionalDependencies = Object.fromEntries(Object.keys(pkg.optionalDependencies).map((key) => [key, settings.platformVersion]));
      writeJson(join(dir, 'package.json'), pkg);
    }, join(output, 'tarballs'));
    assert(mainEntry.files.includes('bin/ocr.js') && mainEntry.files.includes('scripts/install.js') && mainEntry.files.includes('scripts/platform.js'), 'The main package must ship the launcher and install scripts.');
    packages.push({ ...mainEntry, platform: null });
    const manifest = {
      schemaVersion: 1,
      ...settings,
      registry: REGISTRY,
      distTag: DIST_TAG,
      packages,
      toolchain: { node: process.version, npm: npm(['--version']) },
      source: sourceContext(),
      phase: 'packed',
    };
    writeJson(join(output, 'rehearsal-manifest.json'), manifest);
    if (output === OUTPUT) summarize([
      `Packed 7 rehearsal packages (${settings.scope}, version ${settings.version}); no registry write.`,
      `Toolchain: Node ${manifest.toolchain.node}, npm ${manifest.toolchain.npm}.`,
      `Main integrity: \`${mainEntry.integrity}\``,
      'Evidence: out/tarballs/*.tgz and out/rehearsal-manifest.json.',
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

function versionPath(name, version) {
  return `/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
}

function readStagePublish(raw, name, version, expectedIntegrity) {
  const result = raw?.[name];
  assert(result && result.name === name && result.version === version, `Unexpected stage JSON identity for ${name}. Inspect staged packages manually before retrying.`);
  assert(typeof result.stageId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(result.stageId), `The stage response for ${name} has no valid UUID.`);
  assert(result.integrity === expectedIntegrity, `The staged tarball integrity for ${name} differs from the prepared tarball. Do not approve.`);
  return { stageId: result.stageId, integrity: result.integrity };
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseStageList(text, name, version) {
  const nameRe = new RegExp(`^package name:\\s*${escapeRegExp(name)}\\s*$`);
  const versionRe = new RegExp(`^version:\\s*${escapeRegExp(version)}\\s*$`);
  let current = null;
  for (const line of text.split('\n')) {
    const idMatch = line.match(/^id:\s*([0-9a-f-]{36})\s*$/i);
    if (idMatch) current = { id: idMatch[1] };
    if (current && nameRe.test(line)) current.name = name;
    if (current && versionRe.test(line)) return current.id;
  }
  return null;
}

async function stage(settings, output = OUTPUT) {
  const token = process.env.NPM_STAGE_TOKEN;
  assert(token, 'NPM_STAGE_TOKEN is required only for stage.');
  const manifestPath = join(output, 'rehearsal-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert(manifest.scope === settings.scope && manifest.version === settings.version && manifest.platformVersion === settings.platformVersion, 'The manifest does not match the requested rehearsal.');
  assert(['packed', 'platforms-staged'].includes(manifest.phase), `Manifest phase ${manifest.phase} does not allow a stage run. Inspect existing stages before doing anything else.`);
  for (const entry of manifest.packages) {
    assert(integrityOf(readFileSync(join(output, entry.tarball))) === entry.integrity, `The prepared tarball for ${entry.name} has changed. Do not upload.`);
  }
  await registryJson('/-/ping');
  const publicStates = {};
  for (const entry of manifest.packages) {
    publicStates[entry.name] = (await registryJson(versionPath(entry.name, entry.version), true)) !== null;
  }
  assert(!publicStates[settings.mainName], 'The main package version is already public. Use a new rehearsal version.');
  return withNpm(async ({ npm, run }) => {
    npm(['stage', '--help']);
    const record = { platforms: {}, main: null, probe: null, probeRetry: null };
    const tarballOf = (name) => join(output, manifest.packages.find((entry) => entry.name === name).tarball);
    const integrityOfName = (name) => manifest.packages.find((entry) => entry.name === name).integrity;
    const versionOf = (name) => manifest.packages.find((entry) => entry.name === name).version;
    const publish = (name) => {
      const result = run(['stage', 'publish', tarballOf(name), '--registry', REGISTRY, '--access', 'public', '--tag', DIST_TAG, '--ignore-scripts', '--json']);
      if (result.error || result.status !== 0) {
        const code = result.stderr?.match(/(?:npm (?:error|ERR!) code)\s+([A-Z0-9_]+)/)?.[1];
        const detail = result.stderr?.split('\n').find((line) => /error(?! code)/i.test(line))?.replace(/npm (?:error|ERR!)\s*/i, '').slice(0, 300);
        return { ok: false, code: code || `exit ${result.status}`, detail: detail || null };
      }
      return { ok: true, ...readStagePublish(JSON.parse(result.stdout), name, versionOf(name), integrityOfName(name)) };
    };
    if (manifest.phase === 'packed') {
      summarize([`Probe: staging the MAIN package ${settings.mainName} first, while no platform package is public. A rejection is a valid experimental answer.`]);
      const attempt = publish(settings.mainName);
      record.probe = attempt.ok
        ? { result: 'accepted-without-public-deps', stageId: attempt.stageId }
        : { result: 'rejected', code: attempt.code, detail: attempt.detail };
      summarize([attempt.ok
        ? `Probe answer: npm ACCEPTED the main package with unpublished deps (stageId ${attempt.stageId}).`
        : `Probe answer: npm REJECTED the main package with unpublished deps (${attempt.code}${attempt.detail ? `: ${attempt.detail}` : ''}).`]);
      if (attempt.ok) record.main = { stageId: attempt.stageId, status: 'staged' };
    }
    for (const name of settings.platformNames) {
      if (publicStates[name]) {
        record.platforms[name] = { status: 'already-public' };
        continue;
      }
      const existing = parseStageList(npm(['stage', 'list', name]), name, versionOf(name));
      if (existing) {
        record.platforms[name] = { status: 'already-staged', stageId: existing };
        continue;
      }
      const attempt = publish(name);
      assert(attempt.ok, `Staging platform package ${name} failed (${attempt.code}). Inspect before retrying.`);
      record.platforms[name] = { status: 'staged', stageId: attempt.stageId };
    }
    if (!record.main) {
      const retry = publish(settings.mainName);
      record.probeRetry = retry.ok
        ? { result: 'accepted', stageId: retry.stageId }
        : { result: 'rejected', code: retry.code, detail: retry.detail };
      summarize([retry.ok
        ? `Main package stage retry after platform stages: ACCEPTED (stageId ${retry.stageId}).`
        : `Main package stage retry after platform stages: still REJECTED (${retry.code}${retry.detail ? `: ${retry.detail}` : ''}).${manifest.phase === 'packed' ? ' Platform packages likely must be PUBLIC (approved) first: approve the six platforms, then rerun mode=stage.' : ''}`]);
      if (retry.ok) record.main = { stageId: retry.stageId, status: 'staged' };
      else if (manifest.phase === 'platforms-staged') {
        throw new Error(`Main package still cannot be staged although platforms were expected public (${retry.code}). Inspect manually.`);
      }
    }
    const allStaged = record.main !== null && settings.platformNames.every((name) => record.platforms[name].stageId || record.platforms[name].status === 'already-public');
    manifest.phase = allStaged ? 'staged' : 'platforms-staged';
    manifest.stagedAt = new Date().toISOString();
    writeJson(manifestPath, manifest);
    writeJson(join(output, 'rehearsal-stage.json'), record);
    summarize([
      `Phase: ${manifest.phase}.`,
      `Platform stages: ${settings.platformNames.map((name) => `${name.split('/')[1]}=${record.platforms[name].stageId || record.platforms[name].status}`).join(', ')}`,
      record.main ? `Main stage: ${record.main.stageId}` : 'Main stage: pending (waiting for platform approvals).',
      'Uploaded for review. This is not approval or a completed publication.',
    ]);
    return record;
  }, token);
}

async function verify(settings, output = OUTPUT) {
  const expectedInput = process.env.POC_EXPECTED_MAIN_INTEGRITY || null;
  if (expectedInput) {
    assert(/^sha512-[A-Za-z0-9+/]{86}==$/.test(expectedInput), 'POC_EXPECTED_MAIN_INTEGRITY must be the sha512-... value from the original stage manifest.');
  }
  await registryJson('/-/ping');
  return withNpm(async ({ npm, temporary }) => {
    const repackOut = join(temporary, 'repack');
    const repacked = await pack(settings, repackOut);
    const expected = Object.fromEntries(repacked.packages.map((entry) => [entry.name, entry.integrity]));
    if (expectedInput) {
      assert(expected[settings.mainName] === expectedInput, 'The deterministic repack integrity differs from the stage manifest value you supplied. Investigate before trusting this verification.');
    }
    const distTags = {};
    for (const entry of repacked.packages) {
      const metadata = await registryJson(versionPath(entry.name, entry.version));
      assert(metadata.dist?.integrity === expected[entry.name], `Public integrity of ${entry.name} differs from the prepared tarball.`);
      const tags = await registryJson(`/-/package/${encodeURIComponent(entry.name)}/dist-tags`);
      assert(tags[DIST_TAG] === entry.version, `The ${DIST_TAG} dist-tag of ${entry.name} does not point to the rehearsal version.`);
      distTags[entry.name] = tags;
    }
    const consumer = join(temporary, 'consumer');
    mkdirSync(consumer);
    writeJson(join(consumer, 'package.json'), { name: 'ocr-rehearsal-consumer', version: '0.0.0', private: true });
    // --foreground-scripts: npm hides successful lifecycle output by default,
    // and the postinstall skip message is the evidence under test.
    const install = npm(['install', `${settings.mainName}@${settings.version}`, '--registry', REGISTRY, '--no-audit', '--no-fund', '--foreground-scripts'], consumer);
    console.log(install);
    assert(/Binary provided by platform package, skipping download/i.test(install), `postinstall did not resolve the binary from the platform package. Install output:\n${install.slice(0, 1500)}`);
    const platformKey = `${process.platform}-${process.arch}`;
    const expectedPkg = `${settings.scope}/ocr-${platformKey}`;
    // The lockfile records the full optional set; os/cpu filtering only shows on disk.
    const installedNames = readdirSync(join(consumer, 'node_modules', settings.scope))
      .filter((entry) => !entry.startsWith('.'))
      .map((entry) => `${settings.scope}/${entry}`)
      .sort();
    assert(JSON.stringify(installedNames) === JSON.stringify([settings.mainName, expectedPkg].sort()), `Unexpected installed set: ${installedNames.join(', ')}. os/cpu filtering must skip the other platform packages.`);
    const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8'));
    assert(lock.packages[`node_modules/${settings.mainName}`]?.integrity === expected[settings.mainName], 'Installed main integrity differs from the prepared tarball.');
    assert(lock.packages[`node_modules/${expectedPkg}`]?.integrity === expected[expectedPkg], 'Installed platform integrity differs from the prepared tarball.');
    const binRun = spawnSync(join(consumer, 'node_modules', '.bin', 'ocr-rehearsal'), [], {
      env: { ...process.env, OCR_NO_UPDATE: '1' }, encoding: 'utf8', timeout: 30_000,
    });
    assert(binRun.status === 0, `The installed launcher exited with ${binRun.status}: ${binRun.stderr?.slice(0, 300)}`);
    assert(binRun.stdout.includes(`platform=${platformKey}`) && binRun.stdout.includes(`version=${settings.platformVersion}`), `Unexpected launcher output: ${binRun.stdout.trim()}`);
    const result = {
      scope: settings.scope,
      version: settings.version,
      platformVersion: settings.platformVersion,
      registry: REGISTRY,
      integrities: expected,
      distTags,
      toolchain: { node: process.version, npm: npm(['--version']) },
      verifiedAt: new Date().toISOString(),
      installedWithoutCredentials: true,
      postinstallUsedPlatformPackage: true,
      launcherOutput: binRun.stdout.trim(),
      installedPackages: installedNames,
    };
    mkdirSync(output, { recursive: true });
    writeJson(join(output, 'rehearsal-verification.json'), result);
    summarize([
      `Verified anonymous install of ${settings.mainName}@${settings.version} with platform resolution.`,
      `Installed set: ${installedNames.join(', ')}. Launcher output: ${binRun.stdout.trim()}`,
      'All public integrities and next dist-tags match the prepared tarballs. Evidence: out/rehearsal-verification.json.',
    ]);
    return result;
  });
}

export async function main(mode = process.argv[2]) {
  const settings = readSettings();
  if (mode === 'pack') return pack(settings);
  if (mode === 'stage') return stage(settings);
  if (mode === 'verify') return verify(settings);
  throw new Error('Usage: node rehearsal/scripts/rehearsal.mjs pack|stage|verify');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`Rehearsal failed: ${error.message}`);
    process.exitCode = 1;
  });
}
