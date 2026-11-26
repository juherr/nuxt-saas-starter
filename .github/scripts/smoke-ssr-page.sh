#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Renders an organization dashboard server-side with the session left by
# smoke-sign-in.sh and checks that the organization middleware switches
# the active organization: once with a same-origin Referer, once as a
# typed URL (no Origin, no Referer, Sec-Fetch-Site: none, the only path
# where the SSR auth client injects the configured origin), and once with
# a foreign Host / X-Forwarded-Host, which must not make the server call
# that host. Then it checks that a cross-site navigation, whose set-active
# better-auth refuses, ends at once (#147): on the active organization
# when the session has one, on /403 when it has none.
#
# Usage: smoke-ssr-page.sh <label> <user name>
#
# Reads <label>-cookies.txt and server.log, writes ssr-* files and
# foreign-host.log in the current directory.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <label> <user name>" >&2
  exit 2
fi
jar=$1-cookies.txt
welcome="Welcome back, $2!"
: "${NUXT_APP_URL:?NUXT_APP_URL must be set}"
# Neither a trusted origin (server/utils/auth.ts) nor the app port.
foreign=127.0.0.1:4999

fail() {
  echo "::error::$1"
  exit 1
}

# curl may match jar cookies against a custom Host header rather than the
# URL host, so every request sends one explicit Cookie header instead.
cookie=$(sed -e 's/^#HttpOnly_//' -e '/^#/d' -e '/^$/d' "$jar" \
  | awk -F '\t' 'NF >= 7 { printf "%s%s=%s", sep, $6, $7; sep = "; " }')
case "$cookie" in
  *better-auth.session_token=*) ;;
  *) fail "no session cookie in $jar" ;;
esac

# keepCurrentActiveOrganization: without it the new organization becomes
# the active one, and the middleware would never call set-active.
declare -A org_ids
for variant in referer typed foreign refused; do
  slug=smoke-ssr-$variant
  status=$(curl -sS --max-time 30 -o "ssr-org-$variant.json" -w '%{http_code}' \
    -X POST "$NUXT_APP_URL/api/auth/organization/create" \
    -H "Cookie: $cookie" -H "Origin: $NUXT_APP_URL" \
    -H 'Content-Type: application/json' \
    -d "{\"name\":\"$slug\",\"slug\":\"$slug\",\"keepCurrentActiveOrganization\":true}") \
    || fail "creating organization $slug failed"
  if [ "$status" != "200" ]; then
    head -c 500 "ssr-org-$variant.json"; echo
    fail "creating organization $slug answered $status"
  fi
  org_ids[$variant]=$(jq -er .id "ssr-org-$variant.json") \
    || fail "no id in ssr-org-$variant.json"
done

# Active organization of the session, empty when there is none.
active_org() {
  curl -sS --max-time 30 -H "Cookie: $cookie" \
    "$NUXT_APP_URL/api/auth/get-session?disableCookieCache=true" \
    | jq -r '.session.activeOrganizationId // empty'
}

# No -L: a refused set-active redirects to another organization, so only
# an exact 200 proves the page rendered for the requested one. With no
# active organization, the middleware can bounce between two refused
# organizations forever: --max-time turns that into a failure.
check_page() {
  local variant=$1 status active
  shift
  status=$(curl -sS --max-time 30 -o "ssr-$variant-body.txt" -D "ssr-$variant-headers.txt" \
    -w '%{http_code}' -H "Cookie: $cookie" "$@" \
    "$NUXT_APP_URL/smoke-ssr-$variant/dashboard") \
    || fail "$variant page request failed"
  echo "$variant page status: $status"
  if [ "$status" != "200" ]; then
    grep -i '^location:' "ssr-$variant-headers.txt" || true
    fail "$variant page answered $status instead of 200"
  fi
  grep -qF "$welcome" "ssr-$variant-body.txt" \
    || fail "$variant page lacks \"$welcome\""
  # Proof that set-active ran and succeeded: the session moved to this
  # organization, which was not the active one before the request.
  active=$(active_org) || fail "$variant get-session request failed"
  [ "$active" = "${org_ids[$variant]}" ] \
    || fail "after the $variant page the active organization is '$active', not ${org_ids[$variant]}"
}

check_page referer -H "Referer: $NUXT_APP_URL/"
check_page typed -H 'Sec-Fetch-Site: none'

# A reachable listener on the foreign host: a call to an unresolvable
# name would fail, be swallowed and leave the page rendering, while here
# any outbound request is logged.
python3 -m http.server "${foreign#*:}" --bind "${foreign%:*}" > foreign-host.log 2>&1 &
listener=$!
trap 'kill "$listener" 2>/dev/null || true' EXIT
curl -sS -o /dev/null --retry 10 --retry-connrefused --retry-delay 1 \
  "http://$foreign/liveness" || fail "the foreign-host listener did not start"
before=$(grep -c 'HTTP/' foreign-host.log || true)
[ "$before" -ge 1 ] || fail "the foreign-host listener logged no liveness request"
check_page foreign -H "Referer: $NUXT_APP_URL/" \
  -H "Host: $foreign" -H "X-Forwarded-Host: $foreign"
# Let a fire-and-forget outbound request reach the listener before counting.
sleep 1
after=$(grep -c 'HTTP/' foreign-host.log || true)
if [ "$after" != "$before" ]; then
  cat foreign-host.log
  fail "the foreign-host page made $((after - before)) request(s) to $foreign"
fi

# Codes of better-auth's origin check (api/middlewares/origin-check.mjs).
# grep exits 2 on a missing file, which `if` would read as "no match".
[ -s server.log ] || fail "server.log is missing or empty"
if grep -E 'setActive failed|MISSING_OR_NULL_ORIGIN|INVALID_ORIGIN' server.log; then
  fail "server.log shows a refused set-active"
fi
echo "SSR pages rendered for referer, typed and foreign without a refused set-active"

# A cross-site navigation sends no Origin and no Referer, and the SSR auth
# client adds the configured origin only for Sec-Fetch-Site none or
# same-origin, so better-auth refuses the set-active of the refused
# organization. The middleware must answer with one redirect, without -L
# and within --max-time, and leave the session where it was.
#
# Only the session token is sent: $cookie still holds the session_data
# cache cookie of the sign-in, with no active organization, which a
# browser would have replaced with the one each page sets. Without it,
# better-auth reads the session from the database, for the pages and for
# the set-active that unsets the organization (which, reading the cached
# session, would see none to unset and change nothing).
token_cookie=$(printf '%s' "$cookie" | tr ';' '\n' | sed 's/^ *//' \
  | grep '^better-auth\.session_token=') || fail "no session token in $jar"
check_refused() {
  local variant=$1 expected=$2 before=$3 status location active
  status=$(curl -sS --max-time 30 -o "ssr-$variant-body.txt" -D "ssr-$variant-headers.txt" \
    -w '%{http_code}' -H "Cookie: $token_cookie" -H 'Sec-Fetch-Site: cross-site' \
    "$NUXT_APP_URL/smoke-ssr-refused/dashboard") \
    || fail "$variant page request failed or ran past 30 seconds"
  location=$(sed -n 's/^[Ll]ocation: *//p' "ssr-$variant-headers.txt" \
    | tr -d '\r' | sed -E 's|^https?://[^/]+||')
  echo "$variant page status: $status, location: $location"
  [ "$status" = "302" ] || fail "$variant page answered $status instead of 302"
  [ "$location" = "$expected" ] \
    || fail "$variant page redirected to '$location', not $expected"
  active=$(active_org) || fail "$variant get-session request failed"
  [ "$active" = "$before" ] \
    || fail "after the $variant page the active organization is '$active', not '$before'"
}

# The foreign page left smoke-ssr-foreign active.
check_refused refused-active /smoke-ssr-foreign/dashboard "${org_ids[foreign]}"

status=$(curl -sS --max-time 30 -o ssr-unset-active.json -w '%{http_code}' \
  -X POST "$NUXT_APP_URL/api/auth/organization/set-active" \
  -H "Cookie: $token_cookie" -H "Origin: $NUXT_APP_URL" \
  -H 'Content-Type: application/json' -d '{"organizationId":null}') \
  || fail "unsetting the active organization failed"
[ "$status" = "200" ] || fail "unsetting the active organization answered $status"
active=$(active_org) || fail "get-session request failed"
[ -z "$active" ] || fail "the active organization is still '$active' after unsetting it"
check_refused refused-none /403 ""

# One refused set-active per page: a loop would log more.
refusals=$(grep -c 'setActive failed' server.log || true)
[ "$refusals" = "2" ] \
  || fail "server.log shows $refusals refused set-active, not 1 per refused page"
echo "Refused set-active pages redirected once, to the active organization and to /403"
