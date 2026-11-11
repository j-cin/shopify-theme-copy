#!/usr/bin/env bash
# Copy theme 192988315691 + the content it depends on from vergegirl → verge-girl-staging.
#
#   ./copy-theme.sh            # full run: auth, content, theme pull, theme push (unpublished)
#   ./copy-theme.sh --dry-run  # read everything, show what would be written, change nothing
#   SKIP_AUTH=1 ./copy-theme.sh            # reuse the store tokens from a previous run
#   STEPS="menus pages" ./copy-theme.sh    # re-run selected content steps only (no theme push)
#
# Needs: Shopify CLI 3.84+ (for `shopify store auth/execute`), Node 18+.
set -euo pipefail
cd "$(dirname "$0")"

export SRC_STORE="${SRC_STORE:-vergegirl.myshopify.com}"
export DST_STORE="${DST_STORE:-verge-girl-staging.myshopify.com}"
SRC_THEME_ID="${SRC_THEME_ID:-192988315691}"
THEME_DIR="${THEME_DIR:-./theme-export}"
DRY=""; [[ "${1:-}" == "--dry-run" ]] && DRY="--dry-run"

command -v shopify >/dev/null || { echo "Shopify CLI not found: npm i -g @shopify/cli@latest"; exit 1; }
command -v node >/dev/null    || { echo "Node not found"; exit 1; }

SRC_SCOPES="read_themes,read_files,read_metaobjects,read_metaobject_definitions,read_products,read_content,read_online_store_pages,read_online_store_navigation,read_markets"
DST_SCOPES="write_files,write_metaobjects,write_metaobject_definitions,write_products,write_content,write_online_store_pages,write_online_store_navigation,read_markets,write_markets"

if [[ -z "${SKIP_AUTH:-}" ]]; then
  echo "▶ Authorising source (read-only) — approve in your browser"
  shopify store auth --store "$SRC_STORE" --scopes "$SRC_SCOPES"
  echo "▶ Authorising staging (write) — approve in your browser"
  shopify store auth --store "$DST_STORE" --scopes "$DST_SCOPES"
fi

# 1) Pull the source theme (also tells us which files it uses).
if [[ -z "${STEPS:-}" || ! -d "$THEME_DIR" ]]; then
  echo "▶ Pulling theme $SRC_THEME_ID from $SRC_STORE"
  rm -rf "$THEME_DIR" && mkdir -p "$THEME_DIR"
  shopify theme pull --store "$SRC_STORE" --theme "$SRC_THEME_ID" --path "$THEME_DIR"
fi
export THEME_DIR

# 2) Content next, so the theme's references (images, metaobjects, menus, pages) resolve on push.
#    Shopify silently drops setting values that point at things that don't exist.
node copy-content.mjs ${STEPS:-} $DRY

[[ -n "${STEPS:-}" ]] && exit 0

if [[ -n "$DRY" ]]; then
  echo "▶ [dry-run] skipping theme push."
  exit 0
fi

# Files upload asynchronously — give Shopify a moment before the push validates image refs.
echo "▶ Waiting 60s for uploaded files to finish processing on staging…"
sleep 60

# Shopify strips "(" ")" from uploaded video filenames — point the theme at the names staging has.
node fix-video-refs.mjs

# 3) Push to staging as a NEW unpublished theme (never touches the live staging theme).
NAME="VRG copy of ${SRC_THEME_ID} $(date +%Y-%m-%d)"
echo "▶ Pushing to $DST_STORE as unpublished theme \"$NAME\""
shopify theme push --store "$DST_STORE" --path "$THEME_DIR" --unpublished --theme "$NAME"

echo
echo "✔ Done. Check state/report.json for any references that couldn't be mapped,"
echo "  then open the theme in the staging editor: https://admin.shopify.com/store/verge-girl-staging/themes"
