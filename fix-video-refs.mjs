// Shopify strips "(" and ")" from video filenames on upload, so the staging copies are named
// e.g. "INLINE BANNERS 29.mp4" instead of "INLINE BANNERS (29).mp4". This rewrites the video
// references in ./theme-export (the staging copy only) to the names staging actually has.
import fs from 'node:fs';
import path from 'node:path';
import { DST, paginate, FILE_FIELDS, fileInfo } from './lib.mjs';

const vids = await paginate(DST, `query($after:String){ files(first:250, after:$after, query:"media_type:VIDEO"){
  pageInfo{ hasNextPage endCursor } nodes{ ${FILE_FIELDS} } } }`, {}, (d) => d.files);
const onStaging = new Set(vids.map((v) => fileInfo(v)?.filename).filter(Boolean));

const RE = /shopify:\/\/files\/videos\/([^"'\\<>?\n]+)/g;
let filesChanged = 0, refsChanged = 0;
const unresolved = new Set();
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!/\.(json|liquid)$/.test(e.name)) continue;
    const src = fs.readFileSync(p, 'utf8');
    const out = src.replace(RE, (whole, name) => {
      if (onStaging.has(name)) return whole;
      const fixed = name.replace(/[()]/g, '');
      if (onStaging.has(fixed)) { refsChanged++; return `shopify://files/videos/${fixed}`; }
      unresolved.add(name);
      return whole;
    });
    if (out !== src) { fs.writeFileSync(p, out); filesChanged++; }
  }
})('./theme-export');
console.log(`rewrote ${refsChanged} video reference(s) in ${filesChanged} file(s)`);
if (unresolved.size) console.log(`still not on staging (${unresolved.size}):\n  ` + [...unresolved].join('\n  '));
