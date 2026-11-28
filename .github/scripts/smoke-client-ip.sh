#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Checks the client IP the server resolved for the latest successful
# email sign-in: the ip_address of its audit_log row must equal the
# expected IP. Run it after a smoke-sign-in.sh call that sent a client IP
# header (SMOKE_SIGN_IN_HEADER) with a value only that header can produce.
#
# Usage: smoke-client-ip.sh <expected ip>
#
# The SQL runs with the psql of the PostgreSQL container named in
# $POSTGRES_CONTAINER (`docker exec`), as $POSTGRES_USER on $POSTGRES_DB.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <expected ip>" >&2
  exit 2
fi
expected=$1
: "${POSTGRES_CONTAINER:?POSTGRES_CONTAINER must be set}"
: "${POSTGRES_USER:?POSTGRES_USER must be set}"
: "${POSTGRES_DB:?POSTGRES_DB must be set}"

# An empty answer means no such row; a NULL ip_address reads as empty too,
# so both fail the comparison below.
actual=$(docker exec -i "$POSTGRES_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -v ON_ERROR_STOP=1 -qtA <<'SQL'
SELECT ip_address FROM audit_log
WHERE action = '/sign-in/email' AND status = 'success'
ORDER BY id DESC LIMIT 1;
SQL
)
echo "latest sign-in audit ip_address: ${actual:-<none>}"
if [ "$actual" != "$expected" ]; then
  echo "::error::the sign-in was recorded from '${actual:-<none>}' instead of $expected"
  exit 1
fi
echo "Client IP resolved as $expected"
