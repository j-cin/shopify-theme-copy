# Shopify theme + content copy (store → store)

Copies a theme from one store to another as a new **unpublished** theme, plus the content it depends on.
Built for vergegirl → verge-girl-staging, but every store/theme value is an env var.

## Run

```bash
npm i -g @shopify/cli@latest      # needs `shopify store auth/execute` (CLI 3.84+); Node 18+
chmod +x copy-theme.sh
./copy-theme.sh --dry-run         # reads both stores, writes nothing
./copy-theme.sh                   # full run (~45–60 min for VRG)
```

Other stores/themes:

```bash
SRC_STORE=a.myshopify.com DST_STORE=b.myshopify.com SRC_THEME_ID=123 ./copy-theme.sh
```

Re-run selected steps (skips sign-in and the theme push):

```bash
SKIP_AUTH=1 STEPS="files metaobjects" ./copy-theme.sh
```

Steps: `files metaobject-defs metafield-defs metaobjects pages shop-metafields menus`. All are idempotent.

## Order of operations

1. Pull the source theme to `./theme-export`.
2. Copy content. Content goes before the push, because Shopify drops theme settings that point at missing resources.
   - **files**: only the images/videos the theme uses (`shopify://shop_images/…`, `shopify://files/videos/…`), plus any a metaobject, page or metafield points at. Failed uploads on the destination are detected, deleted and re-uploaded. `FILES_MODE=all` copies the whole Files library.
   - **metaobject-defs / metafield-defs**: merchant-owned only. Covers product, variant, collection, page, blog, article, shop and market owners.
   - **metaobjects, pages, shop-metafields, menus**: upserted by handle, with every reference remapped to the destination's IDs.
3. Run `fix-video-refs.mjs` (see gotchas).
4. `theme push --unpublished`.

To push again to the same theme later:
`shopify theme push --store <dst> --path ./theme-export --theme <new theme id>`

## Gotchas learned on VRG (Nov 2026)

- **Overwrites by handle:** pages and menus on the destination with the same handle as a source one (e.g. `main-menu`, `footer`) are replaced with the source's content.
- **Video limit:** Shopify allows 200 video uploads per store per hour. If you hit it, wait an hour and re-run `STEPS="files"`.
- **Videos need a staged upload.** `fileCreate` won't take a video by URL, so the script downloads each one and re-uploads it.
- **Brackets in video names:** Shopify strips `(` `)` from uploaded video filenames, so `INLINE BANNERS (29).mp4` becomes `INLINE BANNERS 29.mp4`. `fix-video-refs.mjs` rewrites the theme copy to match. `check-videos.mjs` reports any video the theme uses that isn't ready on the destination.
- **Filename search:** use the unquoted full filename (`filename:hero.jpg`). Names with spaces fall back to listing all videos and matching exactly.
- **Taxonomy IDs** (`TaxonomyValue` etc.) are global, so they're kept as-is. They're needed for `shopify--*` category metaobjects.
- **App blocks** (e.g. Moast) fail on the destination if the app isn't installed. Remove the block from the template in `theme-export` before pushing.
- `reviews.rating` / `rating_count` are reserved standard definitions, and app namespaces (`app--…`) are skipped. Those errors are expected.

## Output

- `state/report.json`: errors and references that couldn't be mapped (usually collections missing on the destination).
- `state/gid-map.json`: map of source IDs to destination IDs. Delete `state/` when copying to a different destination store.
- `state/run.log`: full log.
