#!/usr/bin/env bash
# Canonical production deployment for the Platinum Labs Homelab Homepage.
#
# Usage:
#   scripts/deploy-production.sh [ref-or-sha]
#   npm run deploy -- [ref-or-sha]
#
# Deploys the given remote branch/tag (default: finish-v1) or an exact 40-char
# commit SHA to the production server. Only code that exists on the GitHub
# remote can be deployed — local, uncommitted, or unpushed work is never
# shipped.
#
# What it does, in order:
#   1. resolve the ref to an exact SHA on the remote
#   2. on the server: refuse if the production checkout has local modifications
#   3. back up the SQLite DB (WAL checkpoint + schema metadata + /data copy),
#      labelled with the previous deployed SHA and a timestamp
#   4. fetch and check out the exact target SHA (detached, reproducible)
#   5. rebuild + restart through the server's existing Compose stack
#   6. wait for /api/health, then run lightweight smoke checks
#   7. print previous SHA, new SHA, backup path, container state
#
# Configuration (env vars, all with working defaults for the current server):
#   DEPLOY_HOST   ssh target                (default ofhd@100.99.6.59)
#   DEPLOY_DIR    server compose directory  (default /mnt/NVME/docker/compose/platinum-homepage)
#   DEPLOY_REPO   git remote URL            (default https://github.com/oliverdougherC/Platinum-Labs.git)
#   DEPLOY_REF    default ref               (default finish-v1)
#   DEPLOY_PORT   published dashboard port  (default 30190)
#
# The server's .env stays authoritative for runtime configuration; this script
# never reads, prints, or transfers secrets.
set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-ofhd@100.99.6.59}"
DEPLOY_DIR="${DEPLOY_DIR:-/mnt/NVME/docker/compose/platinum-homepage}"
DEPLOY_REPO="${DEPLOY_REPO:-https://github.com/oliverdougherC/Platinum-Labs.git}"
DEPLOY_REF="${1:-${DEPLOY_REF:-finish-v1}}"
DEPLOY_PORT="${DEPLOY_PORT:-30190}"

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'deploy: ERROR: %s\n' "$*" >&2; exit 1; }

# --- 1. Resolve the ref to an exact SHA on the remote ------------------------
say "Resolving '${DEPLOY_REF}' on ${DEPLOY_REPO}"
TARGET_SHA=""
if [[ "$DEPLOY_REF" =~ ^[0-9a-f]{40}$ ]]; then
  # Exact SHA requested (e.g. rollback). Existence is verified server-side
  # after fetch, since ls-remote cannot look up arbitrary SHAs.
  TARGET_SHA="$DEPLOY_REF"
else
  TARGET_SHA=$(git ls-remote "$DEPLOY_REPO" "refs/heads/${DEPLOY_REF}" "refs/tags/${DEPLOY_REF}" | awk 'NR==1 {print $1}')
  [ -n "$TARGET_SHA" ] || die "ref '${DEPLOY_REF}' not found on remote (expected a branch, tag, or full 40-char SHA)"
fi
echo "target: ${DEPLOY_REF} -> ${TARGET_SHA}"

# --- 2..7 run on the server --------------------------------------------------
# The remote script is a single quoted heredoc: nothing local expands inside
# it; parameters travel as positional args.
say "Deploying on ${DEPLOY_HOST}"
ssh -o BatchMode=yes "$DEPLOY_HOST" bash -s -- "$TARGET_SHA" "$DEPLOY_DIR" "$DEPLOY_PORT" <<'REMOTE'
set -euo pipefail
TARGET_SHA="$1"; DEPLOY_DIR="$2"; PORT="$3"
SRC="$DEPLOY_DIR/src"

die() { printf 'deploy(server): ERROR: %s\n' "$*" >&2; exit 1; }

[ -d "$DEPLOY_DIR" ] || die "compose dir $DEPLOY_DIR not found"
[ -f "$DEPLOY_DIR/compose.yaml" ] || die "$DEPLOY_DIR/compose.yaml not found"
[ -f "$DEPLOY_DIR/.env" ] || die "$DEPLOY_DIR/.env not found (runtime config lives on the server)"
git -C "$SRC" rev-parse --git-dir >/dev/null 2>&1 \
  || die "$SRC is not a git checkout — see docs/DEPLOYMENT.md 'Server layout' for the one-time bootstrap"

cd "$DEPLOY_DIR"
PREV_SHA=$(git -C "$SRC" rev-parse HEAD)
echo "previous deployed SHA: $PREV_SHA"

# Refuse local modifications: production must only ever run pushed code.
DIRTY=$(git -C "$SRC" status --porcelain)
[ -z "$DIRTY" ] || die "production checkout has local modifications — resolve them first:
$DIRTY"

# Fetch first so an exact-SHA target can be verified before we touch anything.
git -C "$SRC" fetch --quiet origin
git -C "$SRC" cat-file -e "${TARGET_SHA}^{commit}" 2>/dev/null \
  || die "commit $TARGET_SHA not found after fetch — is it pushed to origin?"

if [ "$PREV_SHA" = "$TARGET_SHA" ]; then
  echo "note: target SHA equals currently checked-out SHA; rebuilding anyway (idempotent)."
fi

# --- Backup before anything changes ---
STAMP=$(date +%Y%m%dT%H%M%S)
BACKUP_DIR="$DEPLOY_DIR/backups/${PREV_SHA:0:7}-${STAMP}"
echo "backing up to $BACKUP_DIR"
mkdir -p "$BACKUP_DIR"
docker compose exec -T dashboard node -e '
  const Database = require("better-sqlite3");
  const db = new Database(process.env.HOMELAB_DB_PATH);
  const checkpoint = db.pragma("wal_checkpoint(TRUNCATE)");
  const migrations = db.prepare("SELECT id, name, applied_at FROM schema_migrations ORDER BY id").all();
  console.log(JSON.stringify({ dbPath: process.env.HOMELAB_DB_PATH, checkpoint, migrations }, null, 2));
  db.close();
' > "$BACKUP_DIR/schema.json" || die "WAL checkpoint failed — is the dashboard container running? (backup is mandatory)"
docker compose cp dashboard:/data/. "$BACKUP_DIR/data" || die "copying /data for backup failed"
[ -s "$BACKUP_DIR/data/homelab.db" ] || die "backup produced no homelab.db"
echo "backup ok: $(du -sh "$BACKUP_DIR" | cut -f1)"

# --- Update the checkout to the exact target SHA (detached = unambiguous) ---
git -C "$SRC" checkout --quiet --detach "$TARGET_SHA"
echo "checked out $(git -C "$SRC" rev-parse HEAD)"

# --- Rebuild + restart through the existing Compose stack ---
GIT_SHA="$TARGET_SHA" docker compose up -d --build

# --- Wait for health ---
echo "waiting for /api/health on :$PORT"
HEALTH=""
for i in $(seq 1 60); do
  if HEALTH=$(curl -fsS --max-time 3 "http://localhost:${PORT}/api/health" 2>/dev/null); then
    break
  fi
  sleep 2
done
[ -n "$HEALTH" ] || { docker compose ps; docker compose logs --tail 50 dashboard; die "health endpoint did not come up within 120s"; }
echo "health: $HEALTH"
echo "$HEALTH" | grep -q '"status":"ok"' || die "health endpoint responded but status is not ok"

# --- Lightweight smoke checks ---
DASH_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "http://localhost:${PORT}/api/dashboard")
[ "$DASH_CODE" = "200" ] || die "/api/dashboard returned HTTP $DASH_CODE"
ROOT_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "http://localhost:${PORT}/")
[ "$ROOT_CODE" = "200" ] || die "/ returned HTTP $ROOT_CODE"
echo "smoke: / and /api/dashboard both 200"

echo
echo "=== deployment summary ==="
echo "previous SHA : $PREV_SHA"
echo "deployed SHA : $(git -C "$SRC" rev-parse HEAD)"
echo "backup       : $BACKUP_DIR"
docker compose ps
echo "=== deployment OK ==="
REMOTE

say "Deployment of ${TARGET_SHA} succeeded."
