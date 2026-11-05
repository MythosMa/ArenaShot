#!/usr/bin/env bash
# 将服务端配置同步到客户端资源目录。
# 配置唯一来源：server/config/game.json
#
# 用法：bash scripts/sync-config.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/server/config/game.json"
DST_DIR="$ROOT/client/assets/resources/config"
DST="$DST_DIR/game.json"

if [[ ! -f "$SRC" ]]; then
  echo "[sync-config] 源文件不存在: $SRC" >&2
  exit 1
fi

if [[ ! -d "$ROOT/client" ]]; then
  echo "[sync-config] 客户端目录尚未创建: $ROOT/client" >&2
  echo "[sync-config] 请先在 Cocos Dashboard 创建 3.8.8 项目到 client/ 后重试。" >&2
  exit 1
fi

mkdir -p "$DST_DIR"
cp "$SRC" "$DST"
echo "[sync-config] 已同步: $SRC -> $DST"
