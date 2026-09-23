#!/bin/sh
set -e

# AR-16: the application runs as a least-privilege role that cannot perform DDL, so schema
# migrations use a separate, privileged connection string when one is supplied. Falls back to
# DATABASE_URL so existing installs keep working unchanged.
if [ -n "$MIGRATE_DATABASE_URL" ]; then
  echo "Running migrations with MIGRATE_DATABASE_URL (privileged account)"
  DATABASE_URL="$MIGRATE_DATABASE_URL" npx prisma migrate deploy
else
  echo "Running migrations with DATABASE_URL"
  npx prisma migrate deploy
fi

exec node dist/main.js
