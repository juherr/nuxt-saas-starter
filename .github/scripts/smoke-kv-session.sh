#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Checks that the session of a smoke-sign-in.sh run landed in Redis and
# not in the fs-lite KV directory: better-auth stores a session in its
# secondary storage under the token, the part of the
# better-auth.session_token cookie before the signature.
#
# Usage: smoke-kv-session.sh <label>
#
# Reads <label>-cookies.txt. REDIS_CLI is the command that runs redis-cli
# against the server's Redis (e.g. `docker exec <container> redis-cli`);
# KV_DIR is the fs-lite directory, .data/kv by default.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <label>" >&2
  exit 2
fi
jar=$1-cookies.txt
: "${REDIS_CLI:?REDIS_CLI must be set}"
kv_dir=${KV_DIR:-.data/kv}

fail() {
  echo "::error::$1"
  exit 1
}

# Netscape jar: the name is field 6, the value field 7.
cookie=$(awk -F '\t' '$6 == "better-auth.session_token" { print $7 }' "$jar")
[ -n "$cookie" ] || fail "no session token in $jar"
token=${cookie%%.*}

# Word splitting is wanted: REDIS_CLI is a command with its arguments.
# shellcheck disable=SC2086
keys=$($REDIS_CLI --scan)
echo "--- redis-cli --scan (session token masked) ---"
printf '%s\n' "$keys" | sed "s/$token/<session token>/"

printf '%s\n' "$keys" | grep -qxF "$token" \
  || fail "the session is not in Redis"
printf '%s\n' "$keys" | grep -q '^active-sessions-' \
  || fail "the active-sessions list is not in Redis"

if [ -d "$kv_dir" ] && [ -n "$(find "$kv_dir" -type f -print -quit)" ]; then
  find "$kv_dir" -type f
  fail "$kv_dir holds KV entries: the sessions went to fs-lite"
fi
echo "Session in Redis, none in $kv_dir"
