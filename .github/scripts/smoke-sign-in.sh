#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Signs in with email and password against $NUXT_APP_URL and checks that
# better-auth answers 200 with a session cookie.
#
# Usage: smoke-sign-in.sh <label> <email> <password>
#
# Writes <label>-headers.txt, <label>-body.txt and the cookie jar
# <label>-cookies.txt in the current directory, so a later step can reuse
# the session.
set -euo pipefail

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

status=$(curl -sS -o "$label-body.txt" -D "$label-headers.txt" \
  -c "$label-cookies.txt" -w '%{http_code}' \
  -X POST "$NUXT_APP_URL/api/auth/sign-in/email" \
  -H 'Content-Type: application/json' \
  -H "Origin: $NUXT_APP_URL" \
  -d "$body")
echo "$label status: $status"

# On failure no session exists, so the headers and body hold nothing
# secret and are printed as they are.
show_response() {
  echo "--- $label response headers ---"
  cat "$label-headers.txt"
  echo "--- $label response body ---"
  cat "$label-body.txt"
  echo
}

if [ "$status" != "200" ]; then
  echo "::error::$label answered $status instead of 200"
  show_response
  exit 1
fi
# Without HTTPS, better-auth names the cookie without the __Secure- prefix.
if ! grep -qi '^set-cookie: better-auth\.session_token=' "$label-headers.txt"; then
  echo "::error::no better-auth session cookie in the $label response"
  show_response
  exit 1
fi
