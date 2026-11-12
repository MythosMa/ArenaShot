#!/usr/bin/env bash
# 确保本机 Docker 已就绪（构建在开发机上执行）。
set -euo pipefail

if docker info >/dev/null 2>&1; then
  echo "[check-docker] Docker is running"
  exit 0
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[check-docker] Docker 未运行，请先启动后重试" >&2
  exit 1
fi

echo "[check-docker] Docker is not running, starting Docker Desktop..."
open -a Docker

# 最多等 60 秒，每 2 秒探测一次
for _ in $(seq 1 30); do
  sleep 2
  if docker info >/dev/null 2>&1; then
    echo "[check-docker] Docker is ready"
    exit 0
  fi
done

echo "[check-docker] Docker 启动超时，请手动启动后重试" >&2
exit 1
