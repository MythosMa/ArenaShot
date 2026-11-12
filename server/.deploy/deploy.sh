#!/usr/bin/env bash
# 构建并推送 ArenaShot 服务端镜像到腾讯云 CCR。
# 版本号统一在下方 BUILD_IMG_TAG 一行管理。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${SERVER_DIR}"

export BUILD_IMG_TAG=0.0.0002
IMAGE="ccr.ccs.tencentyun.com/mythosma/arena-shot-server:${BUILD_IMG_TAG}"

bash "${SCRIPT_DIR}/check-docker.sh"

docker buildx build \
   --platform=linux/amd64 \
   -f "${SCRIPT_DIR}/Dockerfile" \
   --build-arg VERSION="${BUILD_IMG_TAG}" \
   -t "${IMAGE}" \
   --push \
   .

echo "[deploy] 已推送 ${IMAGE}"
