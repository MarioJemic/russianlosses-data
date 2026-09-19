import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const ORIGINS = ['https://russianlosses.pages.dev', 'https://russianlosses.mario-jemic.workers.dev'];
const MANIFEST = '/data/v1/manifest.json';
const FIRE_INDEX = '/data/v1/fires/territorial/index.json';
const MAX_BYTES = 25 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function apiPath(value) {
  assert(typeof value === 'string' && /^\/data\/v1\/(?:[a-z0-9_-]+\/)*[a-z0-9][a-z0-9_.-]*\.(?:json|geojson|csv)$/.test(value), 'Only versioned API data paths are allowed');
  assert(!value.includes('..'), 'Parent paths are not allowed');
  assert(value === MANIFEST || /^\/data\/v1\/(?:losses|territory|frontline|models|social|economy|fires|schema)\//.test(value), 'Unknown API directory');
  return value.slice(1);
}

export function descriptors(manifest, fireIndex) {
  assert(manifest.api_version === 'v1' && manifest.datasets.length > 0 && manifest.schemas.length > 0, 'Invalid API catalog');
  assert(typeof manifest.license_notice === 'string' && manifest.license_notice.length > 0, 'Missing license notice');
  const files = new Map();
  for (const file of [...manifest.datasets.flatMap(dataset => dataset.files), ...manifest.schemas, ...(fireIndex?.months.map(month => month.file) ?? [])]) {
    apiPath(file.path);
    assert(file.path !== MANIFEST, 'The manifest cannot describe itself');
    assert(Number.isSafeInteger(file.bytes) && file.bytes > 0 && file.bytes <= MAX_BYTES, 'Invalid file size');
    assert(/^[a-f0-9]{64}$/.test(file.sha256), 'Invalid SHA-256');
    assert(['application/json', 'application/geo+json', 'application/schema+json', 'text/csv'].includes(file.media_type), 'Invalid data media type');
    const normalized = { path: file.path, bytes: file.bytes, sha256: file.sha256, media_type: file.media_type };
    if (files.has(file.path)) assert.deepEqual(files.get(file.path), normalized, 'Conflicting file descriptors');
    files.set(file.path, normalized);
  }
  assert(files.size <= 2000 && [...files.values()].reduce((sum, file) => sum + file.bytes, 0) < 250 * 1024 * 1024, 'Review unexpectedly large export');
  for (const dataset of manifest.datasets) assert(files.has(dataset.schema), `Missing schema: ${dataset.id}`);
  return files;
}

export function verifyBytes(bytes, descriptor) {
  assert.equal(bytes.length, descriptor.bytes, `Size mismatch: ${descriptor.path}`);
  assert.equal(hash(bytes), descriptor.sha256, `SHA-256 mismatch: ${descriptor.path}`);
  const text = bytes.toString('utf8');
  assert(!/(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|firms\.modaps\.eosdis\.nasa\.gov\/api\/area\/csv\/[a-f0-9]{20,})/i.test(text), `Possible credential in ${descriptor.path}`);
  if (descriptor.path.endsWith('json')) JSON.parse(text);
}

async function safeFile(root, publicPath) {
  const relative = apiPath(publicPath);
  const base = path.resolve(root);
  const target = path.resolve(base, relative);
  assert(target.startsWith(`${base}${path.sep}`), 'Output must stay in mirror directory');
  let current = base;
  for (const part of ['', ...relative.split('/')]) {
    if (part) current = path.join(current, part);
    const info = await lstat(current).catch(error => { if (error.code !== 'ENOENT') throw error; });
    assert(!info?.isSymbolicLink(), 'Symlinks are not allowed in mirror paths');
  }
  return target;
}

async function readOptional(file) {
  return readFile(file).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
}

async function download(origin, publicPath, fetchImpl) {
  apiPath(publicPath);
  const response = await fetchImpl(`${origin}${publicPath}`, { redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { 'Cache-Control': 'no-cache' } });
  assert.equal(response.status, 200, `HTTP ${response.status}: ${publicPath}`);
  const type = response.headers.get('content-type')?.split(';')[0].trim();
  assert(['application/json', 'application/geo+json', 'application/schema+json', 'text/csv'].includes(type), `Not API data: ${publicPath}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert(bytes.length <= MAX_BYTES, 'Download exceeds data file limit');
  return bytes;
}

export async function syncMirror(root, { fetchImpl = fetch, now = Date.now() } = {}) {
  const manifestBytes = await download(ORIGINS[0], MANIFEST, fetchImpl);
  verifyBytes(manifestBytes, { path: MANIFEST, bytes: manifestBytes.length, sha256: hash(manifestBytes) });
  assert(manifestBytes.equals(await download(ORIGINS[1], MANIFEST, fetchImpl)), 'Published catalogs differ; wait for a completed release');
  const manifest = JSON.parse(manifestBytes);
  const time = Date.parse(manifest.generated_at);
  assert(Number.isFinite(time) && time <= now + 300_000, 'Invalid catalog generation date');
  const oldBytes = await readOptional(await safeFile(root, MANIFEST));
  const old = oldBytes ? JSON.parse(oldBytes) : null;
  assert(!old || time >= Date.parse(old.generated_at), 'Refusing to roll back the mirror');
  const files = descriptors(manifest);
  const contents = new Map();
  let downloaded = 0;
  const obtain = async descriptor => {
    const local = await readOptional(await safeFile(root, descriptor.path));
    if (local && local.length === descriptor.bytes && hash(local) === descriptor.sha256) {
      verifyBytes(local, descriptor);
      return local;
    }
    const bytes = await download(ORIGINS[0], descriptor.path, fetchImpl);
    verifyBytes(bytes, descriptor);
    const second = await download(ORIGINS[1], descriptor.path, fetchImpl);
    verifyBytes(second, descriptor);
    downloaded++;
    return bytes;
  };
  let fire;
  if (files.has(FIRE_INDEX)) {
    const bytes = await obtain(files.get(FIRE_INDEX));
    contents.set(FIRE_INDEX, bytes);
    fire = JSON.parse(bytes);
  }
  const complete = descriptors(manifest, fire);
  for (const [filePath, descriptor] of complete) {
    if (!contents.has(filePath)) contents.set(filePath, await obtain(descriptor));
  }
  const frontline = contents.get('/data/v1/frontline/index.json');
  if (frontline) {
    const index = JSON.parse(frontline);
    for (const snapshot of [...index.snapshots, index.latest]) assert(complete.has(snapshot.url), 'Unlisted map snapshot');
  }
  if (fire) for (const day of fire.days) assert(complete.has(day.shard), 'Unlisted fire shard');
  // Nothing is written until both hosts still expose the same complete release.
  for (const origin of ORIGINS) assert(manifestBytes.equals(await download(origin, MANIFEST, fetchImpl)), 'Release changed during sync; retry later');
  let oldFiles = new Map();
  if (old) {
    const oldFireDescriptor = descriptors(old).get(FIRE_INDEX);
    let oldFire;
    if (oldFireDescriptor) {
      const bytes = await readFile(await safeFile(root, FIRE_INDEX));
      verifyBytes(bytes, oldFireDescriptor);
      oldFire = JSON.parse(bytes);
    }
    oldFiles = descriptors(old, oldFire);
  }
  const obsolete = [];
  for (const [filePath, descriptor] of oldFiles) {
    if (complete.has(filePath)) continue;
    const target = await safeFile(root, filePath);
    const bytes = await readOptional(target);
    if (bytes) { verifyBytes(bytes, descriptor); obsolete.push(target); }
  }
  for (const [filePath, bytes] of [...contents, [MANIFEST, manifestBytes]]) {
    const target = await safeFile(root, filePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  for (const target of obsolete) await unlink(target);
  return { datasets: manifest.datasets.length, files: complete.size + 1, downloaded, generated_at: manifest.generated_at };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { destination: { type: 'string', default: '.' } } });
  syncMirror(path.resolve(values.destination)).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
