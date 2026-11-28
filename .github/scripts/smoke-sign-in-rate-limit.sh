#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Checks that better-auth's rate limiter refuses sign-ins once the quota of
# its window is spent, then waits for the window to end. It is on only
# when NODE_ENV is production at run time. Its default rule for paths
# starting with /sign-in allows 3 requests per 10 s per client IP and
# path; the next one answers 429 with an X-Retry-After header, in
# seconds, counted from the last allowed request.
#
# Usage: smoke-sign-in-rate-limit.sh <email>
#
# Sends at most 4 POST $NUXT_APP_URL/api/auth/sign-in/email with a wrong
# password, so no session is ever created. Each one must answer 401 until
# one answers 429: the attempt at which it comes is not asserted, since
# the steps before this one may have spent part of the quota. The 429 must
# carry an X-Retry-After between 1 and 10; the script then sleeps that
# long plus one second, so the next sign-in opens a fresh window.
#
# Prints only the statuses and the X-Retry-After value. The responses go
# to a temporary directory, removed on exit.
set -euo pipefail

# shellcheck source-path=SCRIPTDIR source=smoke-request.sh
. "$(dirname "$0")/smoke-request.sh"

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <email>" >&2
  exit 2
fi
email=$1
: "${NUXT_APP_URL:?NUXT_APP_URL must be set}"

max_attempts=4
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

fail() {
  echo "::error::$1"
  exit 1
}

body=$(jq -nc --arg email "$email" \
  '{email: $email, password: "smoke-wrong-password"}')

refused=
for ((attempt = 1; attempt <= max_attempts; attempt++)); do
  label="rate-limited sign-in $attempt/$max_attempts"
  # smoke_request returns 1 on any status but the expected one: the
  # status is read from SMOKE_STATUS instead.
  smoke_request "$label" 429 "$work/body.txt" \
    -D "$work/headers.txt" \
    -X POST "$NUXT_APP_URL/api/auth/sign-in/email" \
    -H 'Content-Type: application/json' \
    -H "Origin: $NUXT_APP_URL" \
    -d "$body" || true
  case $SMOKE_STATUS in
    429)
      refused=$attempt
      break
      ;;
    401) ;;
    000) fail "$label: request failed" ;;
    *)
      smoke_error_code "$label" "$work/body.txt"
      fail "$label answered $SMOKE_STATUS instead of 401 or 429"
      ;;
  esac
done

[ -n "$refused" ] \
  || fail "no 429 after $max_attempts sign-ins: the rate limiter does not refuse"

retry_after=$(sed -n 's/^[Xx]-[Rr]etry-[Aa]fter:[[:space:]]*\([^[:space:]]*\).*$/\1/p' \
  "$work/headers.txt" | head -n 1)
echo "X-Retry-After: ${retry_after:-<missing>}"
[ -n "$retry_after" ] || fail "the 429 carries no X-Retry-After header"
if ! [[ $retry_after =~ ^[0-9]+$ ]] || [ "$retry_after" -lt 1 ] \
  || [ "$retry_after" -gt 10 ]; then
  fail "X-Retry-After is not an integer between 1 and 10"
fi

echo "Refused at attempt $refused; waiting $((retry_after + 1)) s for the window to end"
sleep "$((retry_after + 1))"
