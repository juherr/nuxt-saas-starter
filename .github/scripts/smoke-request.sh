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

# smoke_request <label> <expected status> <body file> <curl args...>
#
# Sets SMOKE_STATUS to the last status (000 when curl got no answer) and
# returns 0 when it equals the expected one. Retries on 000, 503 or a body
# holding "error code: 1102"; any other unexpected answer returns 1 at
# once. Prints neither headers nor body: a response may carry a session.
smoke_request() {
  local label=$1 expected=$2 body=$3 attempt
  local attempts=${SMOKE_RETRY_ATTEMPTS:-1} delay=${SMOKE_RETRY_DELAY:-5}
  shift 3
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    SMOKE_STATUS=$(curl -sS --max-time 30 -o "$body" -w '%{http_code}' "$@") \
      || SMOKE_STATUS=000
    echo "$label: attempt $attempt/$attempts answered $SMOKE_STATUS"
    if [ "$SMOKE_STATUS" = "$expected" ]; then
      return 0
    fi
    # 000: no answer yet, e.g. right after a deploy.
    if [ "$SMOKE_STATUS" != 000 ] && [ "$SMOKE_STATUS" != 503 ] \
      && ! grep -qs 'error code: 1102' "$body"; then
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
