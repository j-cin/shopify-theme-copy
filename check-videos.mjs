// Compare every video the theme references with what's actually on staging.
import fs from 'node:fs';
import path from 'node:path';
import { DST, paginate, FILE_FIELDS, fileInfo } from './lib.mjs';

const RE = /shopify:\/\/files\/videos\/([^"'\\<>?\n]+)/g;
const names = new Set();
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(json|liquid)$/.test(e.name)) for (const m of fs.readFileSync(p, 'utf8').matchAll(RE)) names.add(m[1]);
  }
})('./theme-export');

const vids = await paginate(DST, `query($after:String){ files(first:250, after:$after, query:"media_type:VIDEO"){
  pageInfo{ hasNextPage endCursor } nodes{ ${FILE_FIELDS} createdAt } } }`, {}, (d) => d.files);
const byName = new Map();
for (const v of vids) { const n = fileInfo(v)?.filename || v.filename; if (n) byName.set(n, v); }
const norm = (s) => s.toLowerCase().replace(/_[0-9a-f-]{36}/, '').replace(/[^a-z0-9]/g, '');

const counts = {};
const rows = [];
for (const n of [...names].sort()) {
  const v = byName.get(n);
  let status = v ? v.fileStatus : 'MISSING';
  let note = '';
  if (!v) {
    const near = [...byName.keys()].filter((k) => norm(k) === norm(n));
    if (near.length) { status = 'NAME_DIFFERS'; note = near.join(' | '); }
  }
  counts[status] = (counts[status] || 0) + 1;
  if (status !== 'READY') rows.push(`${status.padEnd(13)} ${n}${note ? `  →  on staging as: ${note}` : ''}`);
}
console.log(`staging has ${vids.length} videos; theme references ${names.size}`);
console.log(counts);
console.log(rows.join('\n'));
fs.writeFileSync('state/video-check.txt', rows.join('\n'));
