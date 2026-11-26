#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Waits for $NUXT_APP_URL/api/health to answer a 2xx: tries start during 60
# seconds and each one is cut at 5, so a server that accepts the connection
# and never answers fails the wait within 65 seconds.
set -euo pipefail

: "${NUXT_APP_URL:?NUXT_APP_URL must be set}"

deadline=$((SECONDS + 60))
while [ "$SECONDS" -lt "$deadline" ]; do
  if curl -fsS --connect-timeout 2 --max-time 5 "$NUXT_APP_URL/api/health"; then
    echo
    exit 0
  fi
  sleep 1
done
echo "::error::/api/health never answered ok within 60 seconds"
exit 1
