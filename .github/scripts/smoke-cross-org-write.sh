#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Checks tenant isolation on writes with the sessions left by
# smoke-sign-in.sh. A user who is not a member of the organization tries
# to rename it through better-auth (POST /api/auth/organization/update)
# and to sync its Stripe customer name (POST
# /api/stripe/sync-customer-name): better-auth must answer 400
# USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION and the app route 403, and the
# organization's row, members and invitations must be unchanged in the
# database.
#
# Positive control: the organization's owner must get past the guard of
# sync-customer-name (any status but 403), or the 403 above would prove
# nothing.
#
# Usage: smoke-cross-org-write.sh <non-member label> <owner label> <org id>
#
# Reads <label>-cookies.txt, writes cross-org-write-* files in the current
# directory. The SQL runs with the psql of the PostgreSQL container named
# in $POSTGRES_CONTAINER (`docker exec`), as $POSTGRES_USER on
# $POSTGRES_DB.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <non-member label> <owner label> <org id>" >&2
  exit 2
fi
intruder_jar=$1-cookies.txt
owner_jar=$2-cookies.txt
org_id=$3
: "${NUXT_APP_URL:?NUXT_APP_URL must be set}"
: "${POSTGRES_CONTAINER:?POSTGRES_CONTAINER must be set}"
: "${POSTGRES_USER:?POSTGRES_USER must be set}"
: "${POSTGRES_DB:?POSTGRES_DB must be set}"
[[ $org_id =~ ^[0-9a-f-]+$ ]] || { echo "::error::not an organization id: $org_id"; exit 2; }

fail() {
  echo "::error::$1"
  exit 1
}

for jar in "$intruder_jar" "$owner_jar"; do
  grep -q 'better-auth\.session_token' "$jar" || fail "no session cookie in $jar"
done

# The organization row, its members and its invitations, one line each.
snapshot() {
  docker exec -i "$POSTGRES_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -v ON_ERROR_STOP=1 -qtA <<SQL
SELECT 'organization ' || row_to_json(o)::text FROM organization o WHERE id = '$org_id';
SELECT 'member ' || row_to_json(m)::text FROM member m
  WHERE organization_id = '$org_id' ORDER BY id;
SELECT 'invitation ' || row_to_json(i)::text FROM invitation i
  WHERE organization_id = '$org_id' ORDER BY id;
SQL
}

# post <label> <jar> <path> <JSON body>: prints the status, keeps the body
# in cross-org-write-<label>.json. better-auth checks Origin on a POST.
post() {
  curl -sS --max-time 30 -o "cross-org-write-$1.json" -w '%{http_code}' \
    -b "$2" -X POST "$NUXT_APP_URL$3" \
    -H 'Content-Type: application/json' -H "Origin: $NUXT_APP_URL" -d "$4"
}

summary() {
  printf '%s\n' "$1" | awk '{ print $1 }' | sort | uniq -c | tr '\n' ' '
}

before=$(snapshot) || fail "the snapshot query failed before the writes"
grep -q '^organization ' <<<"$before" \
  || fail "organization $org_id not found: the check would prove nothing"
grep -q '^member ' <<<"$before" \
  || fail "organization $org_id has no member: the check would prove nothing"
echo "before: $(summary "$before")"

rename=$(jq -nc --arg id "$org_id" '{organizationId: $id, data: {name: "Taken over"}}')
status=$(post update "$intruder_jar" /api/auth/organization/update "$rename") \
  || fail "the organization update request failed"
code=$(jq -r '.code // empty' cross-org-write-update.json 2>/dev/null || true)
echo "non-member organization update status: $status, code: $code"
[ "$status" = 400 ] && [ "$code" = USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION ] \
  || fail "the non-member organization update answered $status $code instead of 400 USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION"

sync=$(jq -nc --arg id "$org_id" '{organizationId: $id, name: "Taken over"}')
status=$(post sync-intruder "$intruder_jar" /api/stripe/sync-customer-name "$sync") \
  || fail "the non-member sync-customer-name request failed"
echo "non-member sync-customer-name status: $status"
[ "$status" = 403 ] || fail "the non-member sync-customer-name answered $status instead of 403"

after=$(snapshot) || fail "the snapshot query failed after the writes"
echo "after: $(summary "$after")"
if [ "$after" != "$before" ]; then
  diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") || true
  fail "organization $org_id changed after the non-member writes"
fi

# Stripe is not configured: the owner may get any answer once past the
# guard, only a 403 would mean the guard refuses everyone.
status=$(post sync-owner "$owner_jar" /api/stripe/sync-customer-name "$sync") \
  || fail "the owner sync-customer-name request failed"
echo "owner sync-customer-name status: $status"
[ "$status" != 403 ] || fail "the owner sync-customer-name answered 403: the guard refuses its owner too"

echo "A non-member could not write to organization $org_id"
