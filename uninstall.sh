#!/usr/bin/env sh
set -eu
BAA_SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$BAA_SCRIPT_DIR/src/install.mjs" --remove "$@"
