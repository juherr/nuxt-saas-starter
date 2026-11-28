#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Checks that demo mode reached the app: with the session left by
# smoke-sign-in.sh, a password change must be refused with 403
# DEMO_MODE_RESTRICTED. The current password sent is wrong on purpose:
# without demo mode the request still changes nothing. Transient answers
# are retried as smoke-request.sh describes.
#
# Usage: smoke-demo-restricted.sh <label>
#
# Reads <label>-cookies.txt, writes <label>-change-password-body.txt in the
# current directory.
set -euo pipefail

# shellcheck source-path=SCRIPTDIR source=smoke-request.sh
. "$(dirname "$0")/smoke-request.sh"

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <label>" >&2
  exit 2
fi
jar=$1-cookies.txt
body=$1-change-password-body.txt
: "${NUXT_APP_URL:?NUXT_APP_URL must be set}"
[ -s "$jar" ] || { echo "::error::$jar is missing or empty"; exit 1; }

if ! smoke_request "$1 change-password" 403 "$body" \
  -b "$jar" \
  -X POST "$NUXT_APP_URL/api/auth/change-password" \
  -H 'Content-Type: application/json' \
  -H "Origin: $NUXT_APP_URL" \
  -d '{"currentPassword":"not-the-demo-password","newPassword":"demo-smoke-new-password"}' \
  || ! grep -q 'DEMO_MODE_RESTRICTED' "$body"; then
  echo "::error::change-password answered $SMOKE_STATUS, not 403 DEMO_MODE_RESTRICTED: demo mode is off"
  cat "$body" 2>/dev/null || true
  echo
  exit 1
fi
echo "$1 change-password refused with DEMO_MODE_RESTRICTED"
