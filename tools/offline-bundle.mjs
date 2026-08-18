#!/usr/bin/env node
/**
 * offline-bundle — build a self-contained tarball that installs kuncen on an
 * air-gapped box.
 *
 * Run this on a machine WITH internet (development here is Windows; this is
 * plain Node with no dependencies, so it runs anywhere). It collects the three
 * things the target cannot fetch for itself:
 *
 *   1. a Node runtime for the target's platform — the Spark may have no node, or
 *      the wrong one, and we are not going to argue with its package manager;
 *   2. every npm tarball named by package-lock.json, primed into an npm cache
 *      that `npm ci --offline` on the target reads directly. Optional deps are
 *      resolved for the TARGET platform (`--os`/`--cpu`), not this one, which is
 *      the whole trick: a Windows host otherwise caches @esbuild/win32-x64 and
 *      the target install fails with nothing to fall back on;
 *   3. the better-sqlite3 prebuilt binary. Its install script downloads this and
 *      falls back to compiling with node-gyp — both are off the table offline, so
 *      the target installs with --ignore-scripts and we drop the .node in by hand.
 *
 * The prebuild is keyed by Node's ABI (process.versions.modules), NOT by the
 * Node version, which is why --node-version and the prebuild cannot be chosen
 * independently. Node 22 is ABI 127.
 *
 * With --docker it also stages a container deployment: the Dockerfile, the
 * compose file, and the base image as a `docker load`able tarball. The image
 * itself is built on the target, which keeps this side free of arm64 emulation —
 * `docker pull --platform linux/arm64` never executes an arm64 instruction, and
 * the build on the Spark is then native.
 *
 * Usage:
 *   node tools/offline-bundle.mjs [--node-version v22.23.2] [--arch arm64]
 *                                 [--out dist] [--docker] [--keep-staging]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');

/** Node major -> ABI. Only what better-sqlite3 publishes prebuilds for. */
const NODE_ABI = { 20: '115', 22: '127', 24: '137' };

/**
 * Node's arch names are not Docker's. This coincides for arm64 and differs for
 * x64/amd64, which is the perfect shape for a bug that only ever appears on the
 * platform you did not test on.
 */
const DOCKER_ARCH = { x64: 'amd64', arm64: 'arm64' };

/** Source that goes to the target. Everything else is host-side or generated. */
const APP_INCLUDE = [
  'packages',
  'services',
  'tools',
  'deploy',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  '.env.example',
  'README.md',
  'PLAN.md',
  'CLAUDE.md',
];

/** Never ships: installed trees, local state, secrets, the marketing site. */
const APP_EXCLUDE = new Set(['node_modules', 'data', '.env', '.git', 'site', 'dist']);

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

const log = (...m) => console.log(...m);
const step = (m) => console.log(`\n\x1b[1m==>\x1b[0m ${m}`);

function fail(msg) {
  console.error(`\x1b[31merror:\x1b[0m ${msg}`);
  process.exit(1);
}

function human(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) fail(`${res.status} ${res.statusText} fetching ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  const { size } = await stat(dest);
  log(`   ${basename(dest)}  ${human(size)}`);
  return dest;
}

async function fetchText(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) fail(`${res.status} ${res.statusText} fetching ${url}`);
  return res.text();
}

async function sha256(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** Every file under `dir`, relative to `base`, POSIX-separated and sorted. */
async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path, base)));
    else out.push(path.slice(base.length + 1).split('\\').join('/'));
  }
  return out.sort();
}

/**
 * npm's own entry script, so we can run it as `node npm-cli.js …`.
 *
 * Node 22 refuses to spawnSync a .cmd shim without shell:true, and turning the
 * shell on would put every path we pass through cmd.exe quoting rules. This is
 * the boring way out.
 */
function resolveNpmCli() {
  const dir = dirname(process.execPath);
  for (const candidate of [
    join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), // Windows layout
    join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), // POSIX layout
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return fail(`could not find npm-cli.js alongside ${process.execPath}`);
}

async function resolveLatestNode22() {
  const index = JSON.parse(await fetchText('https://nodejs.org/dist/index.json'));
  const release = index.find((r) => r.version.startsWith('v22.') && r.lts);
  if (!release) fail('no Node 22 LTS release found on nodejs.org');
  return release.version;
}

// ---------------------------------------------------------------------------

const arch = arg('arch', 'arm64');
if (!['arm64', 'x64'].includes(arch)) fail(`unsupported --arch ${arch} (arm64 or x64)`);

step('Resolving versions');
const nodeVersion = arg('node-version') ?? (await resolveLatestNode22());
const nodeMajor = Number(nodeVersion.replace(/^v/, '').split('.')[0]);
const abi = NODE_ABI[nodeMajor];
if (!abi) fail(`no known ABI for Node ${nodeMajor}; add it to NODE_ABI`);
if (nodeMajor < 22) fail('kuncen requires Node >= 22 (package.json engines)');

const lock = JSON.parse(await readFile(join(ROOT, 'package-lock.json'), 'utf8'));
const sqliteVersion = lock.packages?.['node_modules/better-sqlite3']?.version;
if (!sqliteVersion) fail('better-sqlite3 not found in package-lock.json');
const pkgVersion = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')).version;

log(`   kuncen         ${pkgVersion}`);
log(`   node           ${nodeVersion} (ABI ${abi}) linux-${arch}`);
log(`   better-sqlite3 ${sqliteVersion}`);

const outDir = resolve(ROOT, arg('out', 'dist'));
const bundleName = `kuncen-offline-${pkgVersion}-linux-${arch}`;
const staging = join(outDir, bundleName);
await rm(staging, { recursive: true, force: true });
await mkdir(join(staging, 'runtime'), { recursive: true });
await mkdir(join(staging, 'vendor'), { recursive: true });

// --- 1. application source --------------------------------------------------
step('Staging application source');
for (const entry of APP_INCLUDE) {
  const src = join(ROOT, entry);
  try {
    await stat(src);
  } catch {
    log(`   skip ${entry} (absent)`);
    continue;
  }
  await cp(src, join(staging, 'app', entry), {
    recursive: true,
    filter: (s) => !APP_EXCLUDE.has(basename(s)),
  });
}
log(`   ${(await walk(join(staging, 'app'))).length} files`);

// --- 2. Node runtime --------------------------------------------------------
step(`Downloading Node ${nodeVersion} for linux-${arch}`);
const nodeTar = `node-${nodeVersion}-linux-${arch}.tar.xz`;
const nodePath = join(staging, 'runtime', nodeTar);
await download(`https://nodejs.org/dist/${nodeVersion}/${nodeTar}`, nodePath);

log('   verifying against SHASUMS256.txt');
const shasums = await fetchText(`https://nodejs.org/dist/${nodeVersion}/SHASUMS256.txt`);
const want = shasums
  .split('\n')
  .map((line) => line.trim().split(/\s+/))
  .find(([, name]) => name === nodeTar)?.[0];
if (!want) fail(`${nodeTar} not listed in SHASUMS256.txt`);
const got = await sha256(nodePath);
if (got !== want) fail(`checksum mismatch for ${nodeTar}\n  expected ${want}\n  got      ${got}`);
log('   checksum ok');

// --- 3. npm cache, resolved for the TARGET platform -------------------------
step(`Priming npm cache for linux/${arch}`);
const cacheDir = join(staging, 'npm-cache');
const primeDir = await mkdtemp(join(tmpdir(), 'kuncen-prime-'));
try {
  // Only the manifests: npm ci needs every workspace package.json to build the
  // tree and nothing else. Installing here keeps the staged app/ pristine.
  await cp(join(ROOT, 'package.json'), join(primeDir, 'package.json'));
  await cp(join(ROOT, 'package-lock.json'), join(primeDir, 'package-lock.json'));
  for (const ws of ['packages/core', 'services/proxy', 'services/web']) {
    await mkdir(join(primeDir, ws), { recursive: true });
    await cp(join(ROOT, ws, 'package.json'), join(primeDir, ws, 'package.json'));
  }
  execFileSync(
    process.execPath,
    [
      resolveNpmCli(),
      'ci',
      '--cache', cacheDir,
      '--os', 'linux',
      '--cpu', arch,
      '--libc', 'glibc',
      // Dev dependencies are NOT optional here: both services are started with
      // `tsx`, which lives in devDependencies. An --omit=dev install produces a
      // tree that cannot boot.
      '--include', 'dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ],
    { cwd: primeDir, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const esbuilds = await readdir(join(primeDir, 'node_modules', '@esbuild')).catch(() => []);
  if (!esbuilds.includes(`linux-${arch}`)) {
    fail(
      `npm resolved @esbuild/${esbuilds.join(', ') || 'nothing'} instead of linux-${arch}. ` +
        'npm >= 9.7 is required for --os/--cpu.',
    );
  }
  log(`   @esbuild/${esbuilds.join(', ')} resolved for the target`);
  log(`   ${(await walk(cacheDir)).length} cache files`);
} finally {
  await rm(primeDir, { recursive: true, force: true });
}

// --- 4. better-sqlite3 prebuild ---------------------------------------------
step(`Downloading better-sqlite3 ${sqliteVersion} prebuild (node-v${abi}-linux-${arch})`);
const prebuildName = `better-sqlite3-v${sqliteVersion}-node-v${abi}-linux-${arch}.tar.gz`;
const prebuildPath = join(staging, 'vendor', prebuildName);
await download(
  `https://github.com/WiseLibs/better-sqlite3/releases/download/v${sqliteVersion}/${prebuildName}`,
  prebuildPath,
);
// Check the contents here rather than on the target: an error page saved under a
// .tar.gz name is much cheaper to notice on the machine that can just retry.
// Paths are relative and `cwd` carries the location: GNU tar reads a leading
// `C:` as a remote host, and this script builds bundles from Windows.
const listing = execFileSync('tar', ['-tzf', prebuildName], {
  cwd: join(staging, 'vendor'),
  encoding: 'utf8',
});
if (!listing.includes('better_sqlite3.node')) {
  fail(`${prebuildName} does not contain better_sqlite3.node — got:\n${listing}`);
}
log('   contains build/Release/better_sqlite3.node');

// --- 5. container assets (optional) -----------------------------------------
const wantDocker = hasFlag('docker');
let dockerInfo = {};
if (wantDocker) {
  step('Staging container assets');
  const docker = (args, opts = {}) =>
    execFileSync('docker', args, { encoding: 'utf8', ...opts });

  try {
    docker(['info'], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    fail(
      'cannot talk to the docker daemon.\n' +
        '  --docker needs it only to pull and save the base image; no arm64 code is run.\n' +
        '  Start Docker Desktop and try again, or drop --docker for a systemd-only bundle.',
    );
  }

  // Tied to the bundle's Node major, not chosen separately: the better-sqlite3
  // prebuild is keyed by ABI, so the image's Node and the prebuild must agree.
  const baseImage = arg('docker-base', `node:${nodeMajor}-bookworm-slim`);
  const dockerArch = DOCKER_ARCH[arch];
  log(`   pulling ${baseImage} for linux/${dockerArch}`);
  docker(['pull', '--platform', `linux/${dockerArch}`, baseImage], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  // With the containerd image store a tag holds every platform that was ever
  // pulled, and a bare `inspect` answers for the host's — which on this amd64
  // machine is the wrong one. Ask for the platform explicitly, and fall back for
  // the legacy store, where the pull replaced the tag and the flag does not
  // exist.
  const platform = `linux/${dockerArch}`;
  let baseArch;
  try {
    baseArch = docker([
      'image', 'inspect', '--platform', platform, '--format', '{{.Architecture}}', baseImage,
    ], { stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    baseArch = docker(['image', 'inspect', '--format', '{{.Architecture}}', baseImage]).trim();
  }
  if (baseArch !== dockerArch) fail(`pulled ${baseImage} is ${baseArch}, not ${dockerArch}`);
  const baseDigest = docker([
    'image', 'inspect', '--format', '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}', baseImage,
  ]).trim();
  const baseId = docker(['image', 'inspect', '--format', '{{.Id}}', baseImage]).trim();
  log(`   ${baseArch}  ${baseDigest || baseId}`);

  await mkdir(join(staging, 'docker'), { recursive: true });
  for (const [src, dest] of [
    ['deploy/docker/Dockerfile', 'docker/Dockerfile'],
    ['deploy/docker/compose.yml.tmpl', 'docker/compose.yml.tmpl'],
    ['deploy/docker/dockerignore', '.dockerignore'],
    ['deploy/install-docker.sh', 'install-docker.sh'],
  ]) {
    await cp(join(ROOT, src), join(staging, dest));
  }

  // `docker save` writes an uncompressed tar — roughly 200 MB for a slim Node
  // image. Gzip it: `docker load` decompresses transparently, and this is the
  // artifact somebody has to carry to an air-gapped room.
  const rawTar = join(staging, 'docker', 'base-image.tar');
  const gzTar = `${rawTar}.gz`;
  log('   saving base image');
  // Single-platform, for the same reason: the target must not have to pick.
  try {
    docker(['save', '--platform', platform, '-o', rawTar, baseImage], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    docker(['save', '-o', rawTar, baseImage], { stdio: ['ignore', 'pipe', 'inherit'] });
  }
  const { createGzip } = await import('node:zlib');
  await pipeline(createReadStream(rawTar), createGzip({ level: 6 }), createWriteStream(gzTar));
  await rm(rawTar);
  log(`   base-image.tar.gz  ${human((await stat(gzTar)).size)}`);

  dockerInfo = {
    dockerBase: baseImage,
    dockerBaseDigest: baseDigest,
    dockerBaseArch: baseArch,
    dockerBaseTarball: 'base-image.tar.gz',
  };
}

// --- 6. installer + manifest ------------------------------------------------
step('Writing installer and manifest');
for (const script of ['install.sh', 'uninstall.sh']) {
  await cp(join(ROOT, 'deploy', script), join(staging, script));
}

await writeFile(
  join(staging, 'BUNDLE.json'),
  JSON.stringify(
    {
      // Deliberately flat: install.sh reads this with sed, because an
      // air-gapped box is not guaranteed to have jq.
      kuncen: pkgVersion,
      builtAt: new Date().toISOString(),
      ...dockerInfo,
      targetOs: 'linux',
      targetArch: arch,
      targetLibc: 'glibc',
      nodeVersion,
      nodeAbi: abi,
      nodeTarball: nodeTar,
      betterSqlite3Version: sqliteVersion,
      betterSqlite3Prebuild: prebuildName,
    },
    null,
    2,
  ) + '\n',
);

// Whoever unpacks this on the Spark may have nothing but the tarball.
await writeFile(
  join(staging, 'README.txt'),
  [
    `kuncen ${pkgVersion} — offline install bundle`,
    `built ${new Date().toISOString()} for linux-${arch}`,
    '',
    'Install (needs root, does not touch the network). Pick ONE — both bind',
    ':8080 and :3000:',
    '',
    '    sudo ./install.sh          systemd units, Node unpacked from this bundle',
    ...(wantDocker
      ? ['    sudo ./install-docker.sh   docker compose, image built here on the box']
      : []),
    '',
    'If the executable bit did not survive the copy, prefix with `bash`.',
    '',
    'Options: --prefix DIR (default /opt/kuncen), --user NAME (default kuncen),',
    '--no-start, --no-verify. Re-run to upgrade; .env and data/ are preserved.',
    './uninstall.sh removes either mode and keeps the database unless --purge.',
    '',
    'Contents:',
    '  app/         the source, installed to the prefix',
    `  runtime/     Node ${nodeVersion} for linux-${arch} (systemd mode)`,
    '  npm-cache/   every dependency in package-lock.json, for offline npm ci',
    '  vendor/      the prebuilt better-sqlite3 binary (ABI ' + abi + ')',
    ...(wantDocker
      ? [`  docker/      Dockerfile, compose template, ${dockerInfo.dockerBase} as a tarball`]
      : []),
    '',
    'Full documentation is in app/README.md.',
    '',
  ].join('\n'),
);

const files = (await walk(staging)).filter((f) => f !== 'MANIFEST.sha256');
const lines = [];
for (const file of files) lines.push(`${await sha256(join(staging, file))}  ${file}`);
await writeFile(join(staging, 'MANIFEST.sha256'), lines.join('\n') + '\n');
log(`   ${files.length} files checksummed`);

// --- 7. tar -----------------------------------------------------------------
step('Creating tarball');
const tarball = join(outDir, `${bundleName}.tar.gz`);
await rm(tarball, { force: true });
execFileSync('tar', ['-czf', `${bundleName}.tar.gz`, bundleName], {
  cwd: outDir,
  stdio: 'inherit',
});
if (!hasFlag('keep-staging')) await rm(staging, { recursive: true, force: true });

const { size } = await stat(tarball);
log(`\n\x1b[32mBundle ready\x1b[0m  ${tarball}`);
log(`   ${human(size)}   sha256 ${await sha256(tarball)}`);
log('\nCopy it to the Spark, then:');
log(`   tar -xzf ${bundleName}.tar.gz`);
log(`   cd ${bundleName} && sudo ./install.sh`);
