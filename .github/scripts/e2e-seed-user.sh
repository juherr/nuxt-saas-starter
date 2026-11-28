#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Seeds the regular (non-admin) user the e2e suite signs in with
# (NUXT_TEST_EMAIL / NUXT_TEST_PASSWORD): signs it up through the running
# app at $NUXT_APP_URL, then marks its email verified, since sign-in
# answers 403 EMAIL_NOT_VERIFIED otherwise and no mail is delivered.
#
# The SQL runs with the psql of the PostgreSQL container named in
# $POSTGRES_CONTAINER (`docker exec`), as $POSTGRES_USER on $POSTGRES_DB.
set -euo pipefail

# shellcheck source-path=SCRIPTDIR source=smoke-request.sh
. "$(dirname "$0")/smoke-request.sh"

: "${NUXT_APP_URL:?NUXT_APP_URL must be set}"
: "${NUXT_TEST_EMAIL:?NUXT_TEST_EMAIL must be set}"
: "${NUXT_TEST_PASSWORD:?NUXT_TEST_PASSWORD must be set}"
: "${POSTGRES_CONTAINER:?POSTGRES_CONTAINER must be set}"
: "${POSTGRES_USER:?POSTGRES_USER must be set}"
: "${POSTGRES_DB:?POSTGRES_DB must be set}"

body=$(jq -nc --arg email "$NUXT_TEST_EMAIL" --arg password "$NUXT_TEST_PASSWORD" \
  '{name: "E2E User", email: $email, password: $password}')

status=$(curl -sS --max-time 30 -o sign-up-body.txt -w '%{http_code}' \
  -X POST "$NUXT_APP_URL/api/auth/sign-up/email" \
  -H 'Content-Type: application/json' \
  -H "Origin: $NUXT_APP_URL" \
  -d "$body") || {
  echo "::error::sign-up request failed"
  exit 1
}
echo "sign-up status: $status"
if [ "$status" != "200" ]; then
  echo "::error::sign-up answered $status instead of 200"
  # The job log is public, and an error answer is no proof that the body
  # holds nothing secret: only the better-auth error code is printed.
  smoke_error_code sign-up sign-up-body.txt
  exit 1
fi
# By id: better-auth stores the email lowercased, so NUXT_TEST_EMAIL
# itself may match no row.
user_id=$(jq -er .user.id sign-up-body.txt) || {
  echo "::error::no user id in the sign-up response"
  exit 1
}

# The statement goes through stdin, since psql interpolates :'user_id'
# there and not in -c. psql exits 0 on an UPDATE that matches nothing, so
# the returned rows are counted: exactly the user just signed up.
updated=$(docker exec -i "$POSTGRES_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -v ON_ERROR_STOP=1 -v user_id="$user_id" -qtA <<'SQL' | wc -l
UPDATE "user" SET email_verified = true WHERE id = :'user_id' RETURNING id;
SQL
)
if [ "$updated" -ne 1 ]; then
  echo "::error::expected to verify 1 user, verified $updated"
  exit 1
fi
echo "verified $NUXT_TEST_EMAIL"
