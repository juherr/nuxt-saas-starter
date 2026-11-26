#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Waits up to 60 seconds for $NUXT_APP_URL/api/health to answer a 2xx.
set -euo pipefail

: "${NUXT_APP_URL:?NUXT_APP_URL must be set}"

for _ in $(seq 1 60); do
  if curl -fsS "$NUXT_APP_URL/api/health"; then
    echo
    exit 0
  fi
  sleep 1
done
echo "::error::/api/health never answered ok"
exit 1
