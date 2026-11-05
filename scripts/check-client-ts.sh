#!/usr/bin/env bash
# 用 Cocos Creator 自带 TypeScript 编译器对客户端脚本做类型检查。
#
# 用法：bash scripts/check-client-ts.sh
# 说明：临时生成 tsconfig.check.json（构造后清理），不污染项目配置。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLIENT="$ROOT/client"
CREATOR_VER="${COCOS_VERSION:-3.8.8}"
TSC="/Applications/Cocos/Creator/$CREATOR_VER/CocosCreator.app/Contents/Resources/resources/3d/engine/node_modules/@cocos/typescript/lib/tsc.js"
DECL="$CLIENT/temp/declarations"
ENGINE_ASSETS="/Applications/Cocos/Creator/$CREATOR_VER/CocosCreator.app/Contents/Resources/resources/3d/engine/editor/assets"

if [[ ! -f "$TSC" ]]; then
  echo "[check-client-ts] 找不到 Cocos $CREATOR_VER 的 tsc: $TSC"
  echo "[check-client-ts] 可通过环境变量 COCOS_VERSION 指定其他版本"
  exit 1
fi
if [[ ! -d "$DECL" ]]; then
  echo "[check-client-ts] 缺少引擎类型声明: $DECL"
  echo "[check-client-ts] （请先在 Cocos Dashboard 打开一次客户端项目，让编辑器生成 temp/）"
  exit 1
fi

CONF="$CLIENT/tsconfig.check.json"
trap 'rm -f "$CONF"' EXIT

cat > "$CONF" <<JSON
{
  "compilerOptions": {
    "target": "ES2015",
    "module": "ES2015",
    "strict": true,
    "noEmit": true,
    "experimentalDecorators": true,
    "isolatedModules": true,
    "moduleResolution": "node",
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "baseUrl": ".",
    "types": [
      "./temp/declarations/jsb",
      "./temp/declarations/cc",
      "./temp/declarations/cc.custom-macro",
      "./temp/declarations/cc.env"
    ],
    "paths": {
      "db://internal/*": ["$ENGINE_ASSETS/*"],
      "db://assets/*": ["./assets/*"]
    }
  },
  "include": ["assets/**/*.ts"]
}
JSON

(cd "$CLIENT" && node "$TSC" -p "$CONF")
echo "[check-client-ts] 客户端脚本类型检查通过 ✔"