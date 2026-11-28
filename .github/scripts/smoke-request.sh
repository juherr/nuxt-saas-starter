# shellcheck shell=bash
# SPDX-License-Identifier: MIT
#
# Sourced by the smoke scripts. Defines smoke_request, which runs one curl
# request and retries it on a transient answer only.
#
# SMOKE_RETRY_ATTEMPTS (default 1, no retry) bounds the tries and
# SMOKE_RETRY_DELAY (default 5) is the pause between two, in seconds. The
# demo worker sets them: on the Cloudflare free plan, chained requests can
# exceed the CPU budget, and the worker then answers 503 with the body
# "error code: 1102".

# smoke_redact_headers <headers file>
#
# Replaces the value of every Set-Cookie line of a file written by
# `curl -D` with [redacted], in place, and keeps the cookie name and its
# attributes: the smoke scripts still check which cookies were set, and CI
# uploads these files as artifacts of a public repository on failure. A
# missing file is left alone. The cookie jars (`curl -c`) keep the values,
# since later requests need them; they are never uploaded.
smoke_redact_headers() {
  local file=$1 cr=$'\r'
  if [ ! -f "$file" ]; then
    return 0
  fi
  sed -E "s/^([Ss][Ee][Tt]-[Cc][Oo][Oo][Kk][Ii][Ee]:[[:space:]]*[^=;[:space:]]+)=[^;$cr]*/\\1=[redacted]/" \
    "$file" > "$file.redacted"
  mv "$file.redacted" "$file"
}

# smoke_remove_body <file> <reason>
#
# Replaces the whole file with a one-line placeholder naming the reason
# and the size of what was removed.
smoke_remove_body() {
  local size
  size=$(wc -c < "$1" | tr -d ' ')
  printf '[body removed: %s, %s bytes]\n' "$2" "$size" > "$1"
}

# smoke_redact_body <JSON body file>
#
# Replaces with "[redacted]", in place, the value of every non-null field
# whose key ends in "token" (any case, any depth): better-auth's sign-in
# and sign-up answers carry the session token in their body, and CI
# uploads the body files too. The rest of the JSON is kept for
# diagnostics. Fails closed: a body jq cannot parse (truncated, invalid,
# not JSON) is replaced as a whole by a placeholder. An empty or missing
# file is left alone.
smoke_redact_body() {
  local file=$1 redacted
  if [ ! -s "$file" ]; then
    return 0
  fi
  if redacted=$(jq -c 'walk(if type == "object" then with_entries(
      if (.key | ascii_downcase | endswith("token")) and .value != null
      then .value = "[redacted]" else . end) else . end)' "$file" 2>/dev/null); then
    printf '%s\n' "$redacted" > "$file"
  else
    smoke_remove_body "$file" 'not valid JSON'
  fi
}

# smoke_redact_session_token <file> <cookie jar>
#
# Replaces every occurrence of the session token of a curl cookie jar with
# [redacted], in place, and prints how many there were: a server-rendered
# page serializes the get-session answer, token included, into its Nuxt
# payload, where no key sits next to the value. The token is the cookie
# value up to its first dot (the rest is the signature). Fails closed: a
# token that is not plain [A-Za-z0-9_-] removes the whole file. A missing
# file, or a jar without a session token, is left alone.
smoke_redact_session_token() {
  local file=$1 jar=$2 token count
  if [ ! -f "$file" ]; then
    return 0
  fi
  token=$(sed -e 's/^#HttpOnly_//' -e '/^#/d' "$jar" 2>/dev/null \
    | awk -F '\t' 'NF >= 7 && $6 ~ /better-auth\.session_token$/ { print $7; exit }') \
    || token=""
  token=${token%%.*}
  if [ -z "$token" ]; then
    return 0
  fi
  if ! [[ $token =~ ^[A-Za-z0-9_-]+$ ]]; then
    smoke_remove_body "$file" 'unexpected session token format'
    return 0
  fi
  # grep exits 1 on a page without the token: under pipefail that would
  # stop the caller.
  count=$({ grep -oF -- "$token" "$file" || true; } | wc -l | tr -d ' ')
  sed "s/$token/[redacted]/g" "$file" > "$file.redacted"
  mv "$file.redacted" "$file"
  if [ "$count" -gt 0 ]; then
    echo "${file##*/}: $count occurrence(s) of the session token redacted"
  fi
}

# smoke_request <label> <expected status> <body file> <curl args...>
#
# Sets SMOKE_STATUS to the last status (000 when curl got no answer) and
# returns 0 when it equals the expected one. Retries on 000, 503 or a body
# holding "error code: 1102"; any other unexpected answer returns 1 at
# once. Prints neither headers nor body: a response may carry a session.
# The answers are JSON. After every try, the body file goes through
# smoke_redact_body (a body that is not JSON, such as the worker's 1102
# page, is replaced: the retry reads it first) and a headers file given as
# `-D <file>` through smoke_redact_headers.
smoke_request() {
  local label=$1 expected=$2 body=$3 attempt arg headers="" transient
  local attempts=${SMOKE_RETRY_ATTEMPTS:-1} delay=${SMOKE_RETRY_DELAY:-5}
  shift 3
  local previous=
  for arg in "$@"; do
    if [ "$previous" = -D ]; then
      headers=$arg
    fi
    previous=$arg
  done
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    SMOKE_STATUS=$(curl -sS --max-time 30 -o "$body" -w '%{http_code}' "$@") \
      || SMOKE_STATUS=000
    # 000: no answer yet, e.g. right after a deploy.
    transient=
    if [ "$SMOKE_STATUS" = 000 ] || [ "$SMOKE_STATUS" = 503 ] \
      || grep -qs 'error code: 1102' "$body"; then
      transient=1
    fi
    smoke_redact_body "$body"
    if [ -n "$headers" ]; then
      smoke_redact_headers "$headers"
    fi
    echo "$label: attempt $attempt/$attempts answered $SMOKE_STATUS"
    if [ "$SMOKE_STATUS" = "$expected" ]; then
      return 0
    fi
    if [ -z "$transient" ]; then
      return 1
    fi
    if [ "$attempt" -lt "$attempts" ]; then
      sleep "$delay"
    fi
  done
  return 1
}

# smoke_error_code <label> <body file>
#
# Prints "<label> error code: <code>" when the body is a JSON object whose
# "code" is a string of capitals, digits and underscores (better-auth
# error codes such as INVALID_EMAIL_OR_PASSWORD), and nothing otherwise,
# a non-JSON or missing body included. Always returns 0. Nothing else from
# a response reaches the log: the demo's Actions logs are public, and an
# error answer is no proof that headers or body hold nothing secret.
smoke_error_code() {
  local code
  code=$(jq -r 'if type == "object" and (.code | type) == "string"
    then .code else empty end' "$2" 2>/dev/null) || return 0
  if [[ $code =~ ^[A-Z0-9_]+$ ]]; then
    echo "$1 error code: $code"
  fi
}
