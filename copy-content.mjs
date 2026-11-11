#!/usr/bin/env node
// Copy store content that the theme depends on, from SRC to DST.
// Usage: node copy-content.mjs [steps...] [--dry-run]
// Steps (default = all, in this order):
//   files metaobject-defs metafield-defs metaobjects pages shop-metafields menus
// Every step is idempotent: re-running skips/updates what already exists,
// and fills in cross-references that didn't exist yet on the previous run.
import {
  SRC, DST, DRY_RUN, log, warn, gql, paginate, chunk, userErrors, isAppOwned,
  loadState, saveState, setGid, persistGidMap, remapValue, cleanupTmp,
  FILE_FIELDS, findFilesByName, ensureFiles, purgeFailedFiles, fileInfo,
} from './lib.mjs';

const ALL_STEPS = ['files', 'metaobject-defs', 'metafield-defs', 'metaobjects', 'pages', 'shop-metafields', 'menus'];
const report = { dropped: [], errors: [] };

// ============================================================ FILES
// Only files the theme actually uses: shopify://shop_images/<name> and shopify://files/videos/<name>
// refs found in the pulled theme. Files referenced by metaobjects/pages/metafields are copied on
// demand in later steps. Set FILES_MODE=all to copy the entire Files library instead.
import fs from 'node:fs';
import path from 'node:path';

function themeFileNames(dir) {
  const names = new Set();
  // Filenames can contain spaces (e.g. "MOBILE BANNER REVISED.mov"), so read up to the closing quote.
  const RE = /shopify:\/\/(?:shop_images|files\/videos)\/([^"'\\<>?\n]+)/g;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(json|liquid)$/.test(e.name)) {
        for (const m of fs.readFileSync(p, 'utf8').matchAll(RE)) names.add(decodeURIComponent(m[1]));
      }
    }
  };
  walk(dir);
  return [...names];
}

async function stepFiles() {
  log('▶ Files');
  await purgeFailedFiles();
  if (process.env.FILES_MODE === 'all') {
    const src = await paginate(SRC, `query($after:String){ files(first:250, after:$after){
      pageInfo{ hasNextPage endCursor } nodes{ ${FILE_FIELDS} } } }`, {}, (d) => d.files);
    const r = await ensureFiles(src);
    log(`  all files: ${src.length} on source, ${r.existing} already on staging, ${DRY_RUN ? `${r.wouldUpload ?? 0} would upload` : `${r.uploaded} uploaded`}`);
    return;
  }
  const dir = process.env.THEME_DIR || './theme-export';
  if (!fs.existsSync(dir)) throw new Error(`Theme not found at ${dir} — pull it first (copy-theme.sh does this).`);
  const names = themeFileNames(dir);
  log(`  theme references ${names.length} file(s)`);
  const found = await findFilesByName(SRC, names);
  // Filename search is unreliable for names with spaces/brackets; for videos, list them all and match.
  if (names.some((n) => !found.has(n) && /\.(mp4|mov|webm|m4v)$/i.test(n))) {
    const vids = await paginate(SRC, `query($after:String){ files(first:250, after:$after, query:"media_type:VIDEO"){
      pageInfo{ hasNextPage endCursor } nodes{ ${FILE_FIELDS} } } }`, {}, (d) => d.files);
    const byName = new Map(vids.map((v) => [fileInfo(v)?.filename, v]));
    for (const n of names) if (!found.has(n) && byName.has(n)) found.set(n, byName.get(n));
    log(`  listed ${vids.length} source videos to match names with spaces`);
  }
  const missing = names.filter((n) => !found.has(n));
  if (missing.length) {
    report.dropped.push(...missing.map((n) => `theme file not found on source: ${n}`));
    warn(`${missing.length} referenced file(s) not found on source (see state/report.json)`);
  }
  const r = await ensureFiles([...found.values()]);
  log(`  ${found.size} found, ${r.existing} already on staging, ${DRY_RUN ? `${r.wouldUpload ?? 0} would upload` : `${r.uploaded} uploaded`}`);
}

// ============================================================ METAOBJECT DEFINITIONS
const MO_DEFS_Q = `query($after:String){ metaobjectDefinitions(first:50, after:$after){
  pageInfo{ hasNextPage endCursor }
  nodes{ id type name description displayNameKey
    access{ storefront }
    capabilities{
      publishable{ enabled } translatable{ enabled }
      renderable{ enabled data{ metaTitleKey metaDescriptionKey } }
      onlineStore{ enabled data{ urlHandle canCreateRedirects } }
    }
    fieldDefinitions{ key name description required type{ name } validations{ name value } }
  } } }`;

const DEF_REF_VALIDATIONS = ['metaobject_definition_id', 'metaobject_definition_ids'];

function capabilitiesInput(c) {
  const out = {};
  if (c.publishable?.enabled) out.publishable = { enabled: true };
  if (c.translatable?.enabled) out.translatable = { enabled: true };
  if (c.renderable?.enabled) out.renderable = { enabled: true, data: c.renderable.data || undefined };
  if (c.onlineStore?.enabled) {
    out.onlineStore = { enabled: true, data: { urlHandle: c.onlineStore.data?.urlHandle, createRedirects: !!c.onlineStore.data?.canCreateRedirects } };
  }
  return out;
}

async function stepMetaobjectDefs() {
  log('▶ Metaobject definitions');
  const src = (await paginate(SRC, MO_DEFS_Q, {}, (d) => d.metaobjectDefinitions)).filter((d) => !isAppOwned(d.type));
  const dst = await paginate(DST, MO_DEFS_Q, {}, (d) => d.metaobjectDefinitions);
  const dstByType = new Map(dst.map((d) => [d.type, d]));
  const srcIdToType = Object.fromEntries(src.map((d) => [d.id, d.type]));
  saveState('metaobject-types', src.map((d) => d.type));

  const mapDefValidation = (v) => {
    if (!DEF_REF_VALIDATIONS.includes(v.name)) return v;
    if (v.name === 'metaobject_definition_id') {
      const t = dstByType.get(srcIdToType[v.value]); return t ? { name: v.name, value: t.id } : null;
    }
    const ids = JSON.parse(v.value).map((id) => dstByType.get(srcIdToType[id])?.id);
    return ids.every(Boolean) ? { name: v.name, value: JSON.stringify(ids) } : null;
  };
  const fieldInput = (f) => ({
    key: f.key, name: f.name, description: f.description, required: f.required, type: f.type.name,
    validations: f.validations.map(mapDefValidation),
  });
  const resolvable = (f) => fieldInput(f).validations.every(Boolean);

  // Pass 1: create missing definitions, holding back fields that point at definitions not created yet.
  const deferred = [];
  for (const d of src) {
    if (dstByType.has(d.type)) { setGid(d.id, dstByType.get(d.type).id); continue; }
    if (d.type.startsWith('shopify--')) {
      const r = await gql(DST, `mutation($t:String!){ standardMetaobjectDefinitionEnable(type:$t){
        metaobjectDefinition{ id type } userErrors{ message } } }`, { t: d.type }, { mutate: true });
      const def = r?.standardMetaobjectDefinitionEnable?.metaobjectDefinition;
      if (def) { dstByType.set(d.type, def); setGid(d.id, def.id); log(`  enabled standard ${d.type}`); }
      else if (r) warn(`could not enable standard ${d.type}`, userErrors(r));
      continue;
    }
    const now = d.fieldDefinitions.filter(resolvable);
    const later = d.fieldDefinitions.filter((f) => !resolvable(f));
    const displayOk = !d.displayNameKey || now.some((f) => f.key === d.displayNameKey);
    const definition = {
      type: d.type, name: d.name, description: d.description,
      displayNameKey: displayOk ? d.displayNameKey : undefined,
      access: { storefront: d.access.storefront },
      capabilities: capabilitiesInput(d.capabilities),
      fieldDefinitions: now.map(fieldInput),
    };
    const r = await gql(DST, `mutation($definition:MetaobjectDefinitionCreateInput!){
      metaobjectDefinitionCreate(definition:$definition){ metaobjectDefinition{ id type } userErrors{ field message } } }`,
      { definition }, { mutate: true });
    if (!r) continue;
    const errs = userErrors(r);
    if (errs.length) { report.errors.push(`metaobjectDefinitionCreate ${d.type}: ${JSON.stringify(errs)}`); warn(d.type, errs); continue; }
    const created = r.metaobjectDefinitionCreate.metaobjectDefinition;
    dstByType.set(d.type, created); setGid(d.id, created.id);
    log(`  created ${d.type}${later.length ? ` (${later.length} reference field(s) deferred)` : ''}`);
    if (later.length || !displayOk) deferred.push({ d, later });
  }

  // Pass 2: add the deferred reference fields now that every definition exists.
  for (const { d, later } of deferred) {
    const inputs = later.map(fieldInput);
    if (inputs.some((f) => f.validations.some((v) => !v))) { warn(`${d.type}: some reference fields still unresolved`); }
    const definition = {
      fieldDefinitions: inputs.filter((f) => f.validations.every(Boolean)).map((f) => ({ create: f })),
      displayNameKey: d.displayNameKey || undefined,
    };
    const r = await gql(DST, `mutation($id:ID!, $definition:MetaobjectDefinitionUpdateInput!){
      metaobjectDefinitionUpdate(id:$id, definition:$definition){ metaobjectDefinition{ id } userErrors{ field message } } }`,
      { id: dstByType.get(d.type).id, definition }, { mutate: true });
    const errs = userErrors(r);
    if (errs.length) { report.errors.push(`metaobjectDefinitionUpdate ${d.type}: ${JSON.stringify(errs)}`); warn(d.type, errs); }
    else if (r) log(`  added deferred fields to ${d.type}`);
  }
  persistGidMap();
}

// ============================================================ METAFIELD DEFINITIONS
const OWNER_TYPES = ['PRODUCT', 'PRODUCTVARIANT', 'COLLECTION', 'PAGE', 'BLOG', 'ARTICLE', 'SHOP', 'MARKET'];
const MF_DEFS_Q = `query($ownerType:MetafieldOwnerType!, $after:String){
  metafieldDefinitions(ownerType:$ownerType, first:100, after:$after){
    pageInfo{ hasNextPage endCursor }
    nodes{ name namespace key description type{ name } pinnedPosition
      validations{ name value } access{ storefront }
      capabilities{ smartCollectionCondition{ enabled } adminFilterable{ enabled } }
    } } }`;

async function stepMetafieldDefs() {
  log('▶ Metafield definitions');
  for (const ownerType of OWNER_TYPES) {
    const src = (await paginate(SRC, MF_DEFS_Q, { ownerType }, (d) => d.metafieldDefinitions)).filter((d) => !isAppOwned(d.namespace));
    const dst = await paginate(DST, MF_DEFS_Q, { ownerType }, (d) => d.metafieldDefinitions);
    const have = new Set(dst.map((d) => `${d.namespace}.${d.key}`));
    let created = 0;
    for (const d of src) {
      if (have.has(`${d.namespace}.${d.key}`)) continue;
      if (d.namespace === 'shopify') {
        const r = await gql(DST, `mutation($o:MetafieldOwnerType!, $ns:String!, $k:String!){
          standardMetafieldDefinitionEnable(ownerType:$o, namespace:$ns, key:$k){ createdDefinition{ id } userErrors{ message } } }`,
        { o: ownerType, ns: d.namespace, k: d.key }, { mutate: true });
        if (userErrors(r).length) warn(`standard ${ownerType} ${d.namespace}.${d.key}`, userErrors(r)); else created++;
        continue;
      }
      const validations = [];
      let ok = true;
      for (const v of d.validations) {
        if (DEF_REF_VALIDATIONS.includes(v.name)) {
          const { value, dropped } = await remapValue(v.value);
          if (!value || dropped.length) { ok = false; break; }
          validations.push({ name: v.name, value });
        } else validations.push(v);
      }
      if (!ok) { warn(`${ownerType} ${d.namespace}.${d.key}: referenced metaobject definition missing on staging`); continue; }
      const definition = {
        ownerType, name: d.name, namespace: d.namespace, key: d.key, description: d.description,
        type: d.type.name, validations, pin: d.pinnedPosition != null,
        access: { storefront: d.access.storefront },
        capabilities: {
          ...(d.capabilities.smartCollectionCondition?.enabled ? { smartCollectionCondition: { enabled: true } } : {}),
          ...(d.capabilities.adminFilterable?.enabled ? { adminFilterable: { enabled: true } } : {}),
        },
      };
      const r = await gql(DST, `mutation($definition:MetafieldDefinitionInput!){
        metafieldDefinitionCreate(definition:$definition){ createdDefinition{ id } userErrors{ field message code } } }`,
      { definition }, { mutate: true });
      const errs = userErrors(r).filter((e) => e.code !== 'TAKEN');
      if (errs.length) { report.errors.push(`metafieldDefinitionCreate ${ownerType} ${d.namespace}.${d.key}: ${JSON.stringify(errs)}`); warn(errs); }
      else if (r) created++;
    }
    log(`  ${ownerType}: ${src.length} on source, ${created} created`);
  }
}

// ============================================================ METAOBJECT ENTRIES
const MO_Q = `query($type:String!, $after:String){ metaobjects(type:$type, first:100, after:$after){
  pageInfo{ hasNextPage endCursor }
  nodes{ id handle
    capabilities{ publishable{ status } onlineStore{ templateSuffix } }
    fields{ key value }
  } } }`;

async function remapFields(fields, label, sink = report.dropped) {
  const out = []; let incomplete = false;
  for (const f of fields) {
    if (f.value == null) continue;
    const { value, dropped } = await remapValue(f.value);
    if (dropped.length) { incomplete = true; sink.push(`${label}.${f.key}: ${dropped.join(', ')}`); }
    if (value != null) out.push({ key: f.key, value });
  }
  return { fields: out, incomplete };
}

async function upsertBatch(items) {
  const decl = []; const parts = []; const vars = {};
  items.forEach((it, i) => {
    decl.push(`$h${i}:MetaobjectHandleInput!`, `$m${i}:MetaobjectUpsertInput!`);
    vars[`h${i}`] = it.handle; vars[`m${i}`] = it.metaobject;
    parts.push(`u${i}: metaobjectUpsert(handle:$h${i}, metaobject:$m${i}){ metaobject{ id } userErrors{ field message } }`);
  });
  return gql(DST, `mutation(${decl.join(',')}){ ${parts.join('\n')} }`, vars, { mutate: true });
}

async function stepMetaobjects() {
  log('▶ Metaobject entries');
  let types = loadState('metaobject-types', null);
  if (!types) {
    types = (await paginate(SRC, MO_DEFS_Q, {}, (d) => d.metaobjectDefinitions)).map((d) => d.type).filter((t) => !isAppOwned(t));
  }
  const all = [];
  for (const type of types) {
    const entries = await paginate(SRC, MO_Q, { type }, (d) => d.metaobjects);
    entries.forEach((e) => all.push({ type, e }));
    log(`  ${type}: ${entries.length}`);
  }

  const build = async ({ type, e }, sink) => {
    const { fields, incomplete } = await remapFields(e.fields, `${type}/${e.handle}`, sink);
    const capabilities = {};
    if (e.capabilities?.publishable) capabilities.publishable = { status: e.capabilities.publishable.status };
    if (e.capabilities?.onlineStore) capabilities.onlineStore = { templateSuffix: e.capabilities.onlineStore.templateSuffix || '' };
    return { src: e, incomplete, handle: { type, handle: e.handle }, metaobject: { fields, capabilities } };
  };

  // Two passes: entries referencing other entries that didn't exist yet get retried.
  let queue = all;
  for (let pass = 1; pass <= 2 && queue.length; pass++) {
    const retry = [];
    const sink = pass === 2 ? report.dropped : []; // only report refs still unresolved after the retry
    for (const batch of chunk(queue, 10)) {
      const items = [];
      for (const x of batch) items.push(await build(x, sink));
      const r = await upsertBatch(items);
      items.forEach((it, i) => {
        const res = r?.[`u${i}`];
        if (res?.metaobject) setGid(it.src.id, res.metaobject.id);
        if (res?.userErrors?.length) {
          if (pass === 2) report.errors.push(`metaobjectUpsert ${it.handle.type}/${it.handle.handle}: ${JSON.stringify(res.userErrors)}`);
          retry.push(batch[i]);
        } else if (it.incomplete && pass === 1) retry.push(batch[i]);
      });
      persistGidMap();
    }
    log(`  pass ${pass}: ${queue.length} upserted, ${retry.length} need another pass`);
    queue = retry;
  }
  persistGidMap();
}

// ============================================================ PAGES
const PAGES_Q = `query($after:String){ pages(first:100, after:$after){
  pageInfo{ hasNextPage endCursor }
  nodes{ id title handle body isPublished templateSuffix
    metafields(first:100){ nodes{ namespace key type value } } } } }`;

async function remapMetafields(nodes, label) {
  const out = [];
  for (const m of nodes) {
    if (isAppOwned(m.namespace)) continue;
    const { value, dropped } = await remapValue(m.value);
    if (dropped.length) report.dropped.push(`${label} ${m.namespace}.${m.key}: ${dropped.join(', ')}`);
    if (value != null) out.push({ namespace: m.namespace, key: m.key, type: m.type, value });
  }
  return out;
}

async function stepPages() {
  log('▶ Pages');
  const src = await paginate(SRC, PAGES_Q, {}, (d) => d.pages);
  const dst = await paginate(DST, `query($after:String){ pages(first:250, after:$after){
    pageInfo{ hasNextPage endCursor } nodes{ id handle } } }`, {}, (d) => d.pages);
  const dstByHandle = new Map(dst.map((p) => [p.handle, p.id]));
  let created = 0, updated = 0;
  for (const p of src) {
    const page = {
      title: p.title, handle: p.handle, body: p.body, isPublished: p.isPublished,
      templateSuffix: p.templateSuffix || '',
      metafields: await remapMetafields(p.metafields.nodes, `page/${p.handle}`),
    };
    const existing = dstByHandle.get(p.handle);
    const r = existing
      ? await gql(DST, `mutation($id:ID!, $page:PageUpdateInput!){ pageUpdate(id:$id, page:$page){ page{ id } userErrors{ field message } } }`,
        { id: existing, page }, { mutate: true })
      : await gql(DST, `mutation($page:PageCreateInput!){ pageCreate(page:$page){ page{ id } userErrors{ field message } } }`,
        { page }, { mutate: true });
    const errs = userErrors(r);
    if (errs.length) { report.errors.push(`page ${p.handle}: ${JSON.stringify(errs)}`); warn(p.handle, errs); continue; }
    const id = existing || r?.pageCreate?.page?.id;
    setGid(p.id, id);
    existing ? updated++ : created++;
  }
  persistGidMap();
  log(`  ${src.length} pages: ${created} created, ${updated} updated`);
}

// ============================================================ SHOP METAFIELDS
async function stepShopMetafields() {
  log('▶ Shop metafields');
  const src = await paginate(SRC, `query($after:String){ shop{ metafields(first:250, after:$after){
    pageInfo{ hasNextPage endCursor } nodes{ namespace key type value } } } }`, {}, (d) => d.shop.metafields);
  const { shop } = await gql(DST, 'query{ shop{ id } }');
  const mfs = (await remapMetafields(src, 'shop')).map((m) => ({ ...m, ownerId: shop.id }));
  for (const batch of chunk(mfs, 25)) {
    const r = await gql(DST, `mutation($m:[MetafieldsSetInput!]!){ metafieldsSet(metafields:$m){
      metafields{ id } userErrors{ field message } } }`, { m: batch }, { mutate: true });
    const errs = userErrors(r);
    if (errs.length) { report.errors.push(`metafieldsSet shop: ${JSON.stringify(errs)}`); warn(errs); }
  }
  log(`  ${mfs.length} shop metafields set`);
}

// ============================================================ MENUS
const ITEM = 'title type url resourceId tags';
const MENUS_Q = `query($after:String){ menus(first:50, after:$after){
  pageInfo{ hasNextPage endCursor }
  nodes{ id handle title items{ ${ITEM} items{ ${ITEM} items{ ${ITEM} } } } } } }`;

async function stepMenus() {
  log('▶ Menus');
  const { shop: srcShop } = await gql(SRC, 'query{ shop{ myshopifyDomain primaryDomain{ host } } }');
  const srcHosts = new Set([srcShop.myshopifyDomain, srcShop.primaryDomain.host]);
  const relative = (url) => {
    try { const u = new URL(url); return srcHosts.has(u.host) ? u.pathname + u.search + u.hash : url; } catch { return url; }
  };

  const mapItem = async (it, label) => {
    const out = { title: it.title, type: it.type, tags: it.tags || [] };
    if (it.resourceId) {
      const { value } = await remapValue(it.resourceId);
      if (value) out.resourceId = value;
      else {
        report.dropped.push(`menu ${label} "${it.title}": ${it.resourceId} → kept as plain link ${relative(it.url)}`);
        out.type = 'HTTP'; out.url = relative(it.url);
      }
    } else out.url = relative(it.url);
    out.items = [];
    for (const c of it.items || []) out.items.push(await mapItem(c, label));
    return out;
  };

  const src = await paginate(SRC, MENUS_Q, {}, (d) => d.menus);
  const dst = await paginate(DST, MENUS_Q, {}, (d) => d.menus);
  const dstByHandle = new Map(dst.map((m) => [m.handle, m.id]));
  for (const m of src) {
    const items = [];
    for (const it of m.items) items.push(await mapItem(it, m.handle));
    const existing = dstByHandle.get(m.handle);
    const r = existing
      ? await gql(DST, `mutation($id:ID!, $title:String!, $handle:String, $items:[MenuItemUpdateInput!]!){
          menuUpdate(id:$id, title:$title, handle:$handle, items:$items){ menu{ id } userErrors{ field message } } }`,
        { id: existing, title: m.title, handle: m.handle, items }, { mutate: true })
      : await gql(DST, `mutation($title:String!, $handle:String!, $items:[MenuItemCreateInput!]!){
          menuCreate(title:$title, handle:$handle, items:$items){ menu{ id } userErrors{ field message } } }`,
        { title: m.title, handle: m.handle, items }, { mutate: true });
    const errs = userErrors(r);
    if (errs.length) { report.errors.push(`menu ${m.handle}: ${JSON.stringify(errs)}`); warn(m.handle, errs); }
    else log(`  ${existing ? 'updated' : 'created'} ${m.handle}`);
  }
}

// ============================================================ MAIN
const STEP_FNS = {
  files: stepFiles, 'metaobject-defs': stepMetaobjectDefs, 'metafield-defs': stepMetafieldDefs,
  metaobjects: stepMetaobjects, pages: stepPages, 'shop-metafields': stepShopMetafields, menus: stepMenus,
};
const requested = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const steps = requested.length ? requested : ALL_STEPS;
for (const s of steps) if (!STEP_FNS[s]) { console.error(`Unknown step "${s}". Valid: ${ALL_STEPS.join(', ')}`); process.exit(1); }

log(`=== ${SRC} → ${DST}${DRY_RUN ? ' (DRY RUN)' : ''} — steps: ${steps.join(', ')}`);
try {
  for (const s of steps) await STEP_FNS[s]();
} finally {
  saveState('report', report);
  log(`\n=== Done. ${report.errors.length} error(s), ${report.dropped.length} unresolved reference(s).`);
  if (report.dropped.length) log('  Unresolved refs usually mean the product/collection/etc. does not exist on staging. Details: state/report.json');
  if (report.errors.length) log('  Errors: state/report.json');
  cleanupTmp();
}
