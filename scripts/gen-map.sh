#!/usr/bin/env bash
# 由 scripts/map-layout.txt 生成地图配置，并同步一份到客户端资源目录。
#
# 用法：bash scripts/gen-map.sh
#
# 流程：ASCII 布局 -> server/config/game.json -> client/assets/resources/config/game.json
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

node "$ROOT/scripts/gen-map.mjs"
bash "$ROOT/scripts/sync-config.sh"
