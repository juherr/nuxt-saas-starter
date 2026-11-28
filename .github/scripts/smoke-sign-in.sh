#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Signs in with email and password against $NUXT_APP_URL and checks that
# better-auth answers 200 with a session cookie. Transient answers are
# retried as smoke-request.sh describes (SMOKE_RETRY_ATTEMPTS, default 1).
#
# Usage: smoke-sign-in.sh <label> <email> <password>
#
# Writes <label>-headers.txt, <label>-body.txt and the cookie jar
# <label>-cookies.txt in the current directory, so a later step can reuse
# the session.
set -euo pipefail

# shellcheck source-path=SCRIPTDIR source=smoke-request.sh
. "$(dirname "$0")/smoke-request.sh"

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <label> <email> <password>" >&2
  exit 2
fi
label=$1
email=$2
password=$3
: "${NUXT_APP_URL:?NUXT_APP_URL must be set}"

body=$(jq -nc --arg email "$email" --arg password "$password" \
  '{email: $email, password: $password}')

# better-auth checks Origin against its base URL, so it must equal
# NUXT_APP_URL.
if ! smoke_request "$label" 200 "$label-body.txt" \
  -D "$label-headers.txt" -c "$label-cookies.txt" \
  -X POST "$NUXT_APP_URL/api/auth/sign-in/email" \
  -H 'Content-Type: application/json' \
  -H "Origin: $NUXT_APP_URL" \
  -d "$body"; then
  if [ "$SMOKE_STATUS" = 000 ]; then
    echo "::error::$label sign-in request failed"
    exit 1
  fi
  echo "::error::$label answered $SMOKE_STATUS instead of 200"
  # A non-200 is no proof that the headers and body hold nothing secret,
  # and the demo's Actions logs are public: only the status and the
  # better-auth error code are printed. The files stay on disk.
  smoke_error_code "$label" "$label-body.txt"
  exit 1
fi
# Over HTTPS better-auth adds the __Secure- prefix to the cookie name.
# A 200 carries a live session: never print its headers or body.
if ! grep -Eqi '^set-cookie: (__Secure-)?better-auth\.session_token=' "$label-headers.txt"; then
  echo "::error::no better-auth session cookie in the $label response"
  exit 1
fi
