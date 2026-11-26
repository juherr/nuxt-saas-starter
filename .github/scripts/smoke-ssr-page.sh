#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Renders an organization dashboard server-side with the session left by
# smoke-sign-in.sh and checks that the organization middleware switches
# the active organization: once with a same-origin Referer, once as a
# typed URL (no Origin, no Referer, Sec-Fetch-Site: none, the only path
# where the SSR auth client injects the configured origin), and once with
# a foreign Host / X-Forwarded-Host, which must not make the server call
# that host.
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
for variant in referer typed foreign; do
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
  org_ids[$variant]=$(jq -er .id "ssr-org-$variant.json")
done

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
  active=$(curl -sS --max-time 30 -H "Cookie: $cookie" \
    "$NUXT_APP_URL/api/auth/get-session?disableCookieCache=true" \
    | jq -r '.session.activeOrganizationId // empty') \
    || fail "$variant get-session request failed"
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
after=$(grep -c 'HTTP/' foreign-host.log || true)
if [ "$after" != "$before" ]; then
  cat foreign-host.log
  fail "the foreign-host page made $((after - before)) request(s) to $foreign"
fi

# Codes of better-auth's origin check (api/middlewares/origin-check.mjs).
if grep -E 'setActive failed|MISSING_OR_NULL_ORIGIN|INVALID_ORIGIN' server.log; then
  fail "server.log shows a refused set-active"
fi
echo "SSR pages rendered for ${!org_ids[*]} without a refused set-active"
