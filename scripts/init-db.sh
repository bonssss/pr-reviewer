#!/usr/bin/env bash
set -e

echo "🐘 Initializing PostgreSQL database for PR Reviewer..."

PGDATA_DIR="${PGDATA_DIR:-$(pwd)/.pgdata}"
PGPORT="${PGPORT:-5433}"
PGHOST="${PGHOST:-/tmp}"
PGUSER="${PGUSER:-bonsa}"
PGDB="${PGDB:-pr_reviewer}"

if [ ! -d "$PGDATA_DIR" ]; then
  echo "📦 Initializing cluster directory at $PGDATA_DIR..."
  /usr/lib/postgresql/18/bin/initdb -D "$PGDATA_DIR" -U postgres -A trust
fi

# Check if server is already running
if /usr/lib/postgresql/18/bin/pg_isready -h "$PGHOST" -p "$PGPORT" >/dev/null 2>&1; then
  echo "✅ PostgreSQL is already running on port $PGPORT"
else
  echo "🚀 Starting PostgreSQL server on port $PGPORT..."
  /usr/lib/postgresql/18/bin/pg_ctl -D "$PGDATA_DIR" -o "-k $PGHOST -p $PGPORT" -l "$PGDATA_DIR/postgresql.log" start
fi

# Ensure user and database exist
echo "🔧 Configuring roles and databases..."
/usr/lib/postgresql/18/bin/psql -h "$PGHOST" -p "$PGPORT" -U postgres -d postgres -tc "SELECT 1 FROM pg_roles WHERE rolname='$PGUSER'" | grep -q 1 || \
  /usr/lib/postgresql/18/bin/psql -h "$PGHOST" -p "$PGPORT" -U postgres -d postgres -c "CREATE ROLE $PGUSER WITH LOGIN SUPERUSER PASSWORD 'postgres';"

/usr/lib/postgresql/18/bin/psql -h "$PGHOST" -p "$PGPORT" -U postgres -d postgres -tc "SELECT 1 FROM pg_database WHERE datname='$PGDB'" | grep -q 1 || \
  /usr/lib/postgresql/18/bin/psql -h "$PGHOST" -p "$PGPORT" -U postgres -d postgres -c "CREATE DATABASE $PGDB OWNER $PGUSER;"

echo "🎉 Database ready: postgresql://$PGUSER:postgres@localhost:$PGPORT/$PGDB?host=$PGHOST"
