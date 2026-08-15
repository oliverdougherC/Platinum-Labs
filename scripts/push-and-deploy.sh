#!/usr/bin/env bash
# Push the current committed branch and deploy that exact pushed SHA.
#
# Usage:
#   scripts/push-and-deploy.sh [--any-branch]
#
# Intentional-commit workflow: this script never stages or commits anything.
# It requires a clean working tree, pushes the branch you are on, and hands the
# exact pushed SHA to scripts/deploy-production.sh.
#
# By default it refuses to deploy from any branch other than the production
# ref (finish-v1, or $DEPLOY_REF). Pass --any-branch to deliberately deploy a
# feature branch build to production.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

PRODUCTION_REF="${DEPLOY_REF:-finish-v1}"
ALLOW_ANY_BRANCH=0
if [ "${1:-}" = "--any-branch" ]; then ALLOW_ANY_BRANCH=1; fi

BRANCH=$(git rev-parse --abbrev-ref HEAD)
[ "$BRANCH" != "HEAD" ] || { echo "push-and-deploy: ERROR: detached HEAD — check out a branch first" >&2; exit 1; }

DIRTY=$(git status --porcelain)
if [ -n "$DIRTY" ]; then
  echo "push-and-deploy: ERROR: working tree is not clean. Commit (or stash) intentionally first:" >&2
  echo "$DIRTY" >&2
  exit 1
fi

if [ "$BRANCH" != "$PRODUCTION_REF" ] && [ "$ALLOW_ANY_BRANCH" != "1" ]; then
  echo "push-and-deploy: ERROR: on '$BRANCH' but production ref is '$PRODUCTION_REF'." >&2
  echo "  Merge into $PRODUCTION_REF (via PR) and deploy that, or pass --any-branch to override." >&2
  exit 1
fi

SHA=$(git rev-parse HEAD)
echo "==> pushing $BRANCH ($SHA)"
git push origin "$BRANCH"

echo "==> deploying exact pushed SHA $SHA"
exec "$(dirname "$0")/deploy-production.sh" "$SHA"
