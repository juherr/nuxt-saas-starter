#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Checks that the session of a smoke-sign-in.sh run against `wrangler dev`
# landed in the local emulation of the KV binding: better-auth stores a
# session in its secondary storage under the token, the part of the
# better-auth.session_token cookie before the signature.
#
# Usage: smoke-kv-cloudflare.sh <label>
#
# Reads <label>-cookies.txt and lists the KV binding of the wrangler config
# under .output (the one `wrangler dev --cwd .output` serves).
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <label>" >&2
  exit 2
fi
jar=$1-cookies.txt

fail() {
  echo "::error::$1"
  exit 1
}

# Netscape jar: the name is field 6, the value field 7.
cookie=$(awk -F '\t' '$6 == "better-auth.session_token" { print $7 }' "$jar")
[ -n "$cookie" ] || fail "no session token in $jar"
token=${cookie%%.*}

keys=$(pnpm exec wrangler kv key list --binding KV --local --cwd .output | jq -r '.[].name')
echo "--- local KV keys (session token masked) ---"
printf '%s\n' "$keys" | sed "s/$token/<session token>/"

printf '%s\n' "$keys" | grep -qxF "$token" \
  || fail "the session is not in the KV binding"
printf '%s\n' "$keys" | grep -q '^active-sessions-' \
  || fail "the active-sessions list is not in the KV binding"
echo "Session in the KV binding"
