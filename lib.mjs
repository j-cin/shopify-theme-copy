// Shared helpers: CLI-backed GraphQL, pagination, state, and GID remapping.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const SRC = process.env.SRC_STORE || 'vergegirl.myshopify.com';
export const DST = process.env.DST_STORE || 'verge-girl-staging.myshopify.com';
export const API_VERSION = process.env.API_VERSION || '2026-10';
export const DRY_RUN = process.argv.includes('--dry-run');
export const STATE_DIR = path.resolve(process.env.STATE_DIR || './state');
const SHOPIFY_BIN = process.env.SHOPIFY_BIN || 'shopify';

fs.mkdirSync(STATE_DIR, { recursive: true });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vrg-gql-'));
let tmpN = 0;

// ---------- logging ----------
const LOG_FILE = path.join(STATE_DIR, 'run.log');
export function log(...a) {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  console.log(line);
  fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
}
export function warn(...a) { log('  ⚠', ...a); }

// ---------- state ----------
export function loadState(name, fallback = {}) {
  const f = path.join(STATE_DIR, `${name}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : fallback;
}
export function saveState(name, data) {
  fs.writeFileSync(path.join(STATE_DIR, `${name}.json`), JSON.stringify(data, null, 2));
}

// ---------- GraphQL via `shopify store execute` ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function gql(store, query, variables = {}, { mutate = false } = {}) {
  if (mutate && DRY_RUN) {
    log(`  [dry-run] would run mutation on ${store} (${Object.keys(variables).length} vars)`);
    return null;
  }
  const id = ++tmpN;
  const qf = path.join(TMP, `${id}.graphql`);
  const vf = path.join(TMP, `${id}.vars.json`);
  const of = path.join(TMP, `${id}.out.json`);
  fs.writeFileSync(qf, query);
  fs.writeFileSync(vf, JSON.stringify(variables));
  const args = ['store', 'execute', '--store', store, '--version', API_VERSION,
    '--query-file', qf, '--variable-file', vf, '--output-file', of];
  if (mutate) args.push('--allow-mutations');

  for (let attempt = 1; ; attempt++) {
    try {
      if (fs.existsSync(of)) fs.unlinkSync(of);
      execFileSync(SHOPIFY_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
      const raw = JSON.parse(fs.readFileSync(of, 'utf8'));
      if (raw && raw.errors) throw new Error(JSON.stringify(raw.errors));
      return raw && raw.data !== undefined ? raw.data : raw;
    } catch (e) {
      const msg = String(e.stderr || e.message || e);
      const retryable = /throttl|429|5\d\d|timeout|ECONNRESET|ETIMEDOUT/i.test(msg);
      if (retryable && attempt < 5) { await sleep(2000 * attempt); continue; }
      throw new Error(`GraphQL failed on ${store}: ${msg.slice(0, 2000)}`);
    }
  }
}

// Paginate a connection. `pick(data)` returns the connection ({nodes, pageInfo}).
export async function paginate(store, query, variables, pick) {
  const out = [];
  let after = null;
  do {
    const data = await gql(store, query, { ...variables, after });
    const conn = pick(data);
    out.push(...conn.nodes);
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after);
  return out;
}

export function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export function userErrors(result) {
  if (!result) return [];
  return Object.values(result).flatMap((r) => (r && r.userErrors) || []);
}

// Skip app-owned and reserved namespaces/types — they belong to apps, not the merchant.
export const isAppOwned = (s) => /^(\$app|app--)/.test(s || '');

// ---------- GID remapping (source store ID -> destination store ID) ----------
// Positive results are cached in state/gid-map.json. Misses are not cached,
// so re-running the script fills in references created later in the run.
const gidMap = loadState('gid-map', {});
export function setGid(src, dst) { if (src && dst) gidMap[src] = dst; }
export function persistGidMap() { saveState('gid-map', gidMap); }

const GID_RE = /gid:\/\/shopify\/([A-Za-z]+)\/\d+/g;
const typeOf = (gid) => gid.split('/')[3];

// ---------- Files (copied on demand, matched by filename) ----------
const FILE_TYPES = ['MediaImage', 'GenericFile', 'Video'];
const GLOBAL_TYPES = ['TaxonomyValue', 'TaxonomyCategory', 'TaxonomyAttribute'];
const LOOKUP_TYPES = ['Metaobject', 'Product', 'Collection', 'Page', 'Blog', 'Article', 'ProductVariant'];
export const FILE_FIELDS = `id __typename ... on File { alt fileStatus }
  ... on MediaImage { image { url } originalSource { url } }
  ... on GenericFile { url }
  ... on Video { filename originalSource { url } }`;

const baseName = (url) => decodeURIComponent(new URL(url).pathname.split('/').pop());
export function fileInfo(n) {
  if (!n) return null;
  if (n.__typename === 'MediaImage') {
    const shown = n.image?.url || n.originalSource?.url;
    if (!shown) return null;
    return { filename: baseName(shown), src: shown.split('?')[0], contentType: 'IMAGE' };
  }
  if (n.__typename === 'GenericFile' && n.url) return { filename: baseName(n.url), src: n.url, contentType: 'FILE' };
  if (n.__typename === 'Video' && n.originalSource?.url) {
    return { filename: n.filename || baseName(n.originalSource.url), src: n.originalSource.url, contentType: 'VIDEO' };
  }
  return null;
}

// Look files up by exact filename (one aliased query per 25 names). Returns Map filename -> node.
export async function findFilesByName(store, names) {
  const found = new Map();
  for (const batch of chunk([...new Set(names)], 25)) {
    const decl = []; const parts = []; const vars = {};
    batch.forEach((name, i) => {
      // Unquoted full filename is what Shopify's file search matches (quoted stems return nothing).
      // Names with spaces/special chars: free-text search on the longest plain token, then exact-match below.
      const token = name.split(/[\s:()"']+/).sort((a, b) => b.length - a.length)[0];
      const q = /[\s:()"']/.test(name) ? token : `filename:${name}`;
      decl.push(`$q${i}:String!`); vars[`q${i}`] = q;
      parts.push(`f${i}: files(first:50, query:$q${i}){ nodes{ ${FILE_FIELDS} } }`);
    });
    const d = await gql(store, `query(${decl.join(',')}){ ${parts.join('\n')} }`, vars);
    batch.forEach((name, i) => {
      const hit = (d[`f${i}`]?.nodes || []).find((n) => fileInfo(n)?.filename === name);
      if (hit) found.set(name, hit);
    });
  }
  return found;
}

// Make sure each source file node exists on DST (by filename); uploads what's missing.
export async function ensureFiles(srcNodes) {
  const items = srcNodes.map((n) => ({ n, f: fileInfo(n) }))
    .filter(({ n, f }) => { if (!f || n.fileStatus === 'FAILED') { warn(`skip file ${n.id} (${n.__typename}, ${n.fileStatus})`); return false; } return true; })
    .filter(({ n }) => !gidMap[n.id]);
  if (!items.length) return { existing: 0, uploaded: 0 };
  const onDst = await findFilesByName(DST, items.map((x) => x.f.filename));
  const todo = [];
  const failedDst = [];
  for (const x of items) {
    const hit = onDst.get(x.f.filename);
    if (hit && hit.fileStatus === 'FAILED') { failedDst.push(hit.id); todo.push(x); }
    else if (hit) setGid(x.n.id, hit.id); else todo.push(x);
  }
  await deleteDstFiles(failedDst);
  let uploaded = 0;
  if (!DRY_RUN) {
    for (const x of todo.filter((t) => t.f.contentType === 'VIDEO')) {
      try { x.f.src = await stageVideo(x.f); }
      catch (e) { warn(`video ${x.f.filename}: ${e.message.slice(0, 200)}`); x.skip = true; }
    }
  }
  for (const batch of chunk(todo.filter((t) => !t.skip), 25)) {
    const files = batch.map(({ n, f }) => ({ originalSource: f.src, filename: f.filename, alt: n.alt || '', contentType: f.contentType }));
    const res = await gql(DST, `mutation($files:[FileCreateInput!]!){ fileCreate(files:$files){
      files{ id } userErrors{ field message } } }`, { files }, { mutate: true });
    if (!res) continue;
    if (res.fileCreate.userErrors.length) warn('fileCreate', res.fileCreate.userErrors);
    (res.fileCreate.files || []).forEach((c, j) => { if (c) { setGid(batch[j].n.id, c.id); uploaded++; } });
    persistGidMap();
  }
  persistGidMap();
  return { existing: items.length - todo.length, uploaded, wouldUpload: todo.length };
}

async function deleteDstFiles(ids) {
  for (const batch of chunk([...new Set(ids)], 50)) {
    const r = await gql(DST, `mutation($ids:[ID!]!){ fileDelete(fileIds:$ids){ deletedFileIds userErrors{ message } } }`,
      { ids: batch }, { mutate: true });
    if (r) log(`  deleted ${r.fileDelete.deletedFileIds?.length || 0} failed file(s) on staging`);
  }
}

// Check every file already copied; any that failed processing on staging is deleted and un-mapped
// so this run uploads it again.
export async function purgeFailedFiles() {
  const mapped = Object.entries(gidMap).filter(([src]) => FILE_TYPES.includes(typeOf(src)));
  const failed = [];
  for (const batch of chunk(mapped, 250)) {
    const d = await gql(DST, `query($ids:[ID!]!){ nodes(ids:$ids){ id ... on File { fileStatus } } }`,
      { ids: batch.map(([, dst]) => dst) });
    const status = new Map((d.nodes || []).filter(Boolean).map((n) => [n.id, n.fileStatus]));
    for (const [src, dst] of batch) {
      const st = status.get(dst);
      if (st === 'FAILED' || st === undefined) { failed.push(dst); delete gidMap[src]; }
    }
  }
  log(`  ${mapped.length} previously copied file(s) checked, ${failed.length} failed/missing — re-uploading those`);
  await deleteDstFiles(failed);
  persistGidMap();
}

async function stageVideo(f) {
  const resp = await fetch(f.src);
  if (!resp.ok) throw new Error(`download ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  const mimeType = (resp.headers.get('content-type') || 'video/mp4').split(';')[0];
  const d = await gql(DST, `mutation($input:[StagedUploadInput!]!){ stagedUploadsCreate(input:$input){
    stagedTargets{ url resourceUrl parameters{ name value } } userErrors{ field message } } }`,
  { input: [{ filename: f.filename, mimeType, resource: 'VIDEO', fileSize: String(buf.length), httpMethod: 'POST' }] }, { mutate: true });
  const errs = d.stagedUploadsCreate.userErrors;
  if (errs.length) throw new Error(JSON.stringify(errs));
  const t = d.stagedUploadsCreate.stagedTargets[0];
  const form = new FormData();
  for (const p of t.parameters) form.append(p.name, p.value);
  form.append('file', new Blob([buf], { type: mimeType }), f.filename);
  const up = await fetch(t.url, { method: 'POST', body: form });
  if (!up.ok) throw new Error(`upload ${up.status}: ${(await up.text()).slice(0, 200)}`);
  log(`  staged video ${f.filename} (${(buf.length / 1e6).toFixed(1)} MB)`);
  return t.resourceUrl;
}

async function resolveGids(gids) {
  const todo = [...new Set(gids)].filter((g) => !gidMap[g]);
  if (!todo.length) return;
  // Files referenced by metaobjects/pages/metafields are copied on demand.
  const fileGids = todo.filter((g) => FILE_TYPES.includes(typeOf(g)));
  for (const batch of chunk(fileGids, 50)) {
    const d = await gql(SRC, `query($ids:[ID!]!){ nodes(ids:$ids){ ${FILE_FIELDS} } }`, { ids: batch });
    await ensureFiles((d.nodes || []).filter(Boolean));
  }
  // Shopify's product taxonomy IDs are global, identical on every store.
  for (const g of todo) if (GLOBAL_TYPES.includes(typeOf(g))) setGid(g, g);
  // Only look up types we know how to match; anything else (Market, Location, …) stays unresolved.
  const lookups = todo.filter((g) => LOOKUP_TYPES.includes(typeOf(g)) && !gidMap[g]);
  for (const batch of chunk(lookups, 50)) {
    const src = await gql(SRC, `query($ids:[ID!]!){ nodes(ids:$ids){ id __typename
      ... on Metaobject { type handle }
      ... on Product { handle }
      ... on Collection { handle }
      ... on Page { handle }
      ... on Blog { handle }
      ... on Article { handle }
      ... on ProductVariant { sku product { handle } }
    } }`, { ids: batch });
    const nodes = (src.nodes || []).filter(Boolean);
    if (!nodes.length) continue;

    // One aliased query against the destination for the whole batch.
    const parts = []; const vars = {}; const decl = [];
    nodes.forEach((n, i) => {
      const a = `a${i}`;
      switch (n.__typename) {
        case 'Metaobject':
          decl.push(`$${a}:MetaobjectHandleInput!`); vars[a] = { type: n.type, handle: n.handle };
          parts.push(`${a}: metaobjectByHandle(handle:$${a}){ id }`); break;
        case 'Product':
          decl.push(`$${a}:ProductIdentifierInput!`); vars[a] = { handle: n.handle };
          parts.push(`${a}: productByIdentifier(identifier:$${a}){ id }`); break;
        case 'Collection':
          decl.push(`$${a}:CollectionIdentifierInput!`); vars[a] = { handle: n.handle };
          parts.push(`${a}: collectionByIdentifier(identifier:$${a}){ id }`); break;
        case 'Page':
          decl.push(`$${a}:String!`); vars[a] = `handle:'${n.handle}'`;
          parts.push(`${a}: pages(first:1, query:$${a}){ nodes { id } }`); break;
        case 'Blog':
          decl.push(`$${a}:String!`); vars[a] = `handle:'${n.handle}'`;
          parts.push(`${a}: blogs(first:1, query:$${a}){ nodes { id } }`); break;
        case 'Article':
          decl.push(`$${a}:String!`); vars[a] = `handle:'${n.handle}'`;
          parts.push(`${a}: articles(first:1, query:$${a}){ nodes { id } }`); break;
        case 'ProductVariant':
          decl.push(`$${a}:ProductIdentifierInput!`); vars[a] = { handle: n.product.handle };
          parts.push(`${a}: productByIdentifier(identifier:$${a}){ variants(first:250){ nodes { id sku } } }`); break;
        default: return;
      }
    });
    if (!parts.length) continue;
    const dst = await gql(DST, `query(${decl.join(',')}){ ${parts.join('\n')} }`, vars);
    nodes.forEach((n, i) => {
      const r = dst[`a${i}`];
      if (!r) return;
      if (r.id) setGid(n.id, r.id);
      else if (n.__typename === 'ProductVariant') {
        const v = (r.variants?.nodes || []).find((x) => x.sku && x.sku === n.sku);
        if (v) setGid(n.id, v.id);
      } else if (r.nodes?.[0]) setGid(n.id, r.nodes[0].id);
    });
  }
  persistGidMap();
}

// Remap every GID inside a metafield/metaobject value.
// Returns { value, dropped[] }; value is null if a single-reference value couldn't be mapped.
export async function remapValue(value) {
  if (typeof value !== 'string' || !value.includes('gid://shopify/')) return { value, dropped: [] };
  const gids = value.match(GID_RE) || [];
  await resolveGids(gids);
  const dropped = gids.filter((g) => !gidMap[g]);
  const trimmed = value.trim();

  if (/^gid:\/\/shopify\/[A-Za-z]+\/\d+$/.test(trimmed)) {
    return { value: gidMap[trimmed] || null, dropped };
  }
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr) && arr.every((x) => typeof x === 'string')) {
        const mapped = arr.map((g) => gidMap[g] || (g.startsWith('gid://') ? null : g)).filter(Boolean);
        return { value: JSON.stringify(mapped), dropped };
      }
    } catch { /* fall through */ }
  }
  // Rich text / JSON: replace what we can, leave the rest.
  return { value: value.replace(GID_RE, (g) => gidMap[g] || g), dropped };
}

export function cleanupTmp() { fs.rmSync(TMP, { recursive: true, force: true }); }
