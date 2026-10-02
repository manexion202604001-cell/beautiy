#!/usr/bin/env bash
# Deploy a frontend to Cloudflare Pages.
#
#   ./scripts/deploy.sh <staff|admin|customer|karute-entry> <dev|prod>
#
# - Next.js apps are built as static exports (out/) using .env.development (dev) or .env.production (prod).
# - Pages project names default to salon-<app> (prod) / salon-<app>-dev (dev); override with
#   PAGES_PROJECT_<APP> (e.g. PAGES_PROJECT_STAFF=my-staff-app, PAGES_PROJECT_KARUTE_ENTRY=...).
# - karute-entry: set KARUTE_ENTRY_API_URL to the API origin to replace the URL hardcoded in index.html.
# - Requires `wrangler login` or CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID in the environment.
set -euo pipefail

APP="${1:-}"
ENV="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

usage() {
  echo "usage: $0 <staff|admin|customer|karute-entry> <dev|prod>" >&2
  exit 1
}

case "$APP" in staff|admin|customer|karute-entry) ;; *) usage ;; esac
case "$ENV" in dev|prod) ;; *) usage ;; esac

APP_VAR="PAGES_PROJECT_$(echo "$APP" | tr 'a-z-' 'A-Z_')"
DEFAULT_PROJECT="salon-$APP$([ "$ENV" = dev ] && echo "-dev" || true)"
PROJECT="${!APP_VAR:-$DEFAULT_PROJECT}"

wrangler() {
  pnpm --dir "$ROOT/api" exec wrangler "$@"
}

if [ "$APP" = "karute-entry" ]; then
  OUT_DIR="$(mktemp -d)"
  trap 'rm -rf "$OUT_DIR"' EXIT
  cp -R "$ROOT/karute-entry/." "$OUT_DIR/"
  if [ -n "${KARUTE_ENTRY_API_URL:-}" ]; then
    sed -i.bak "s#https://salon-api.example.workers.dev#${KARUTE_ENTRY_API_URL%/}#g" "$OUT_DIR/index.html"
    rm -f "$OUT_DIR/index.html.bak"
  else
    echo "warning: KARUTE_ENTRY_API_URL is not set; index.html keeps its placeholder API URL" >&2
  fi
else
  APP_DIR="$ROOT/$APP"
  ENV_FILE="$APP_DIR/.env.$([ "$ENV" = dev ] && echo development || echo production)"
  echo "==> Building $APP ($ENV) with $(basename "$ENV_FILE")"
  (
    cd "$APP_DIR"
    # next build always loads .env.production; export the chosen file so it takes precedence.
    # Lines are exported verbatim (no shell parsing) so JSON values keep their quotes.
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in ''|'#'*) continue ;; esac
      export "$line"
    done < "$ENV_FILE"
    rm -rf .next out
    NEXT_TELEMETRY_DISABLED=1 pnpm exec next build
  )
  OUT_DIR="$APP_DIR/out"
fi

echo "==> Deploying $OUT_DIR to Cloudflare Pages project '$PROJECT'"
wrangler pages deploy "$OUT_DIR" --project-name "$PROJECT" --branch main --commit-dirty=true
