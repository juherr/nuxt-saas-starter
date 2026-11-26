#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Fails unless the `node` on the PATH matches the version pinned in
# ./mise.toml (`node = "26"` matches any 26.x.y, `node = "26.1"` any
# 26.1.y). Run after setup-node, which installs no Node of its own here
# but would otherwise go unnoticed if it ever put one first on the PATH.
set -euo pipefail

pin=$(sed -n 's/^node = "\(.*\)"$/\1/p' mise.toml)
if [ -z "$pin" ]; then
  echo "::error::no node = \"<version>\" line in mise.toml"
  exit 1
fi
actual=$(node -p process.versions.node)
echo "node $actual at $(command -v node), mise.toml pins $pin"
case "$actual" in
  "$pin" | "$pin".*) ;;
  *)
    echo "::error::node $actual does not match the $pin pinned in mise.toml"
    exit 1
    ;;
esac
