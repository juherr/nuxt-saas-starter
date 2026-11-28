#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Checks that better-auth's rate limiter ran on the smoke requests: it is
# on only when NODE_ENV is production at run time, and keeps its buckets
# in the rate_limit table (server/utils/authStorage.ts). Run it after a
# sign-in and an SSR page load, before anything resets the database.
#
# better-auth keys a bucket `<client ip>|<path below /api/auth>` and falls
# back to `no-trusted-ip|<path>` when it cannot resolve the client IP, so
# every key must be non-empty and none may start with no-trusted-ip. At
# least one /sign-in and one /get-session bucket must exist.
#
# The SQL runs with the psql of the PostgreSQL container named in
# $POSTGRES_CONTAINER (`docker exec`), as $POSTGRES_USER on $POSTGRES_DB.
set -euo pipefail

: "${POSTGRES_CONTAINER:?POSTGRES_CONTAINER must be set}"
: "${POSTGRES_USER:?POSTGRES_USER must be set}"
: "${POSTGRES_DB:?POSTGRES_DB must be set}"

fail() {
  echo "::error::$1"
  exit 1
}

keys=$(docker exec -i "$POSTGRES_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -v ON_ERROR_STOP=1 -qtA <<'SQL'
SELECT coalesce(key, '') || ' count=' || count FROM rate_limit ORDER BY key;
SQL
)
echo "--- rate_limit keys ---"
printf '%s\n' "$keys"

[ -n "$keys" ] || fail "rate_limit is empty: the rate limiter did not run"
if printf '%s\n' "$keys" | grep -q '^ count='; then
  fail "rate_limit holds an empty key"
fi
if printf '%s\n' "$keys" | grep -q '^no-trusted-ip'; then
  fail "rate_limit holds a no-trusted-ip key: the client IP was not resolved"
fi
printf '%s\n' "$keys" | grep -q '^[^|]\{1,\}|/sign-in' \
  || fail "rate_limit holds no sign-in key"
printf '%s\n' "$keys" | grep -q '^[^|]\{1,\}|/get-session ' \
  || fail "rate_limit holds no get-session key"
echo "Rate limiter on, keyed by client IP"
