#!/usr/bin/env bash
# Runs the T2 pure-logic suite against the REAL compiled backend in an
# isolated container: empty scratch DB + scratch cache dirs, so the server
# module's boot side effects (harvest, cron, listen :3000) are inert.
#
# Usage (from repo root):  bash tests/run-scratch.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

docker run --rm \
  -v "${ROOT}:/work" \
  -w /work \
  -e CACHE_DIR=/scratch/cache \
  -e DATA_DIR=/scratch/data \
  -e DATABASE_URL=file:/scratch/data/scratch.db \
  node:20-bookworm bash -c '
    set -euo pipefail
    mkdir -p /scratch/cache /scratch/data
    cd /work/backend
    npx --yes prisma@6 db push --skip-generate --schema prisma/schema.prisma 2>&1 | tail -1
    npx tsc
    node /work/tests/pure-logic.test.mjs
  '
