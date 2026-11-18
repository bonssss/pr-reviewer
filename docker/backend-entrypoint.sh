#!/bin/sh
# Applies pending database migrations before the API starts.
#
# `prisma migrate deploy` is idempotent: it only runs migrations that are not
# yet recorded in `_prisma_migrations`. Set RUN_MIGRATIONS=false for setups
# where migrations are applied by a separate release job.
set -eu

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "[entrypoint] Applying database migrations..."
  npx prisma migrate deploy --schema=/app/backend/prisma/schema.prisma
fi

exec "$@"
