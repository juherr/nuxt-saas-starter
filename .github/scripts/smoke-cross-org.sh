#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Checks tenant isolation with the session left by smoke-sign-in.sh, for a
# user who is not a member of the given organization: its dashboard,
# rendered server-side, must redirect elsewhere without showing its data
# or making it the session's active organization, and an org-scoped API
# route must answer 403 for it.
#
# Usage: smoke-cross-org.sh <label> <org slug> <org id> <org name>
#
# Reads <label>-cookies.txt, writes cross-org-* files in the current
# directory.
set -euo pipefail

# shellcheck source-path=SCRIPTDIR source=smoke-request.sh
. "$(dirname "$0")/smoke-request.sh"

if [ "$#" -ne 4 ]; then
  echo "usage: $0 <label> <org slug> <org id> <org name>" >&2
  exit 2
fi
jar=$1-cookies.txt
slug=$2
org_id=$3
org_name=$4
: "${NUXT_APP_URL:?NUXT_APP_URL must be set}"
[[ $NUXT_APP_URL =~ ^https?://[^/]+ ]] \
  || { echo "::error::NUXT_APP_URL is not an http(s) URL: $NUXT_APP_URL"; exit 2; }
app_origin=${BASH_REMATCH[0]}

fail() {
  echo "::error::$1"
  exit 1
}

# Same Cookie header as smoke-ssr-page.sh builds from the jar.
cookie=$(sed -e 's/^#HttpOnly_//' -e '/^#/d' -e '/^$/d' "$jar" \
  | awk -F '\t' 'NF >= 7 { printf "%s%s=%s", sep, $6, $7; sep = "; " }')
case "$cookie" in
  *better-auth.session_token=*) ;;
  *) fail "no session cookie in $jar" ;;
esac

# Active organization of the session, empty when there is none. Fails on
# an HTTP error and on a body without a session.
active_org() {
  curl -fsS --max-time 30 -H "Cookie: $cookie" \
    "$NUXT_APP_URL/api/auth/get-session?disableCookieCache=true" \
    | jq -er 'if (.session | type) == "object"
      then .session.activeOrganizationId // ""
      else error("get-session returned no session") end'
}

# A body that names the organization or carries its id leaks its data.
check_no_org_data() {
  local file=$1
  if grep -qF -e "$org_name" -e "$org_id" "$file"; then
    grep -oF -e "$org_name" -e "$org_id" "$file" | sort | uniq -c
    fail "$file shows data of $slug"
  fi
}

before=$(active_org) || fail "get-session request failed before the page"
[ "$before" != "$org_id" ] \
  || fail "$slug is already the active organization: the check would prove nothing"

# No -L: only the first answer of the middleware matters, and a redirect
# loop must fail within --max-time.
status=$(curl -sS --max-time 30 -o cross-org-page-body.txt -D cross-org-page-headers.txt \
  -w '%{http_code}' -H "Cookie: $cookie" -H "Referer: $NUXT_APP_URL/" \
  "$NUXT_APP_URL/$slug/dashboard") \
  || status=000
smoke_redact_headers cross-org-page-headers.txt
smoke_redact_session_token cross-org-page-body.txt "$jar"
[ "$status" != 000 ] || fail "the $slug page request failed or ran past 30 seconds"
location=$(sed -n 's/^[Ll]ocation: *//p' cross-org-page-headers.txt | tr -d '\r')
echo "$slug page status: $status, location: $location"
case "$status" in
  301 | 302 | 303 | 307 | 308) ;;
  *) fail "the $slug page answered $status instead of a redirect" ;;
esac
case "$location" in
  //*) fail "the $slug page redirected off the app origin, to '$location'" ;;
  /*) path=$location ;;
  "$app_origin"/*) path=${location#"$app_origin"} ;;
  *) fail "the $slug page redirected off the app origin $app_origin, to '$location'" ;;
esac
case "$path" in
  "/$slug" | "/$slug/"* | "/$slug?"*) fail "the $slug page redirected to $slug itself: '$path'" ;;
esac
check_no_org_data cross-org-page-body.txt

after=$(active_org) || fail "get-session request failed after the page"
[ "$after" = "$before" ] \
  || fail "after the $slug page the active organization is '$after', not '$before'"
echo "active organization unchanged: '$after'"

status=$(curl -sS --max-time 30 -o cross-org-api-body.txt -w '%{http_code}' \
  -H "Cookie: $cookie" \
  "$NUXT_APP_URL/api/organization/api-keys?organizationId=$org_id") \
  || fail "the api-keys request failed"
smoke_redact_session_token cross-org-api-body.txt "$jar"
echo "api-keys of $slug status: $status"
[ "$status" = "403" ] || fail "api-keys of $slug answered $status instead of 403"
# The error body echoes the request URL, which carries the id: drop it.
jq -e 'del(.url)' cross-org-api-body.txt > cross-org-api-data.txt \
  || fail "the api-keys answer is not JSON"
check_no_org_data cross-org-api-data.txt

echo "A non-member of $slug was redirected away from it and refused its API keys"
