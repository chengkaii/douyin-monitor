#!/usr/bin/env bash
# DTK v5 容器栈操作封装（官方 compose 文件，不在本仓库重复维护）
# 用法: ./scripts/dtk.sh up|pull|status|logs|openapi|bootstrap|down
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE="$(cd "$SCRIPT_DIR/../.." && pwd)"
DTK_REPO="${DTK_REPO:-$WORKSPACE/douyin-api}"
COMPOSE_FILE="$DTK_REPO/docker/compose.yml"
CMD="${1:-status}"

if ! command -v docker >/dev/null 2>&1; then
  echo "未检测到 docker。先跑 ./scripts/setup-runtime.sh 安装 Docker Desktop 并启动。" >&2
  exit 1
fi

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "未找到 $COMPOSE_FILE" >&2
  echo "官方仓库应位于 $DTK_REPO；也可用 DTK_REPO=/path/to/repo 指定。" >&2
  exit 1
fi

if [[ ! -f "$DTK_REPO/.env" ]]; then
  echo "缺少 $DTK_REPO/.env（随机密钥），请先生成后再启动。" >&2
  exit 1
fi

COMPOSE=(docker compose -p dtk -f "$COMPOSE_FILE")
# 默认不启 browser profile：一期用手动导入 Cookie，避免构建 CloakBrowser 镜像
# 需要自动铸造游客身份时：DTK_BROWSER=1 ./scripts/dtk.sh up
if [[ "${DTK_BROWSER:-0}" == "1" ]]; then
  COMPOSE+=(--profile browser)
fi

case "$CMD" in
  up)
    # 用官方发布镜像，避免本地源码构建（console 构建需要额外拉 node 镜像）
    "${COMPOSE[@]}" pull
    "${COMPOSE[@]}" up -d --no-build --wait --wait-timeout 300
    echo "已启动：http://127.0.0.1:8000"
    echo "下一步：npm run dtk:bootstrap（自动建管理员 + 生成 API key）"
    ;;
  pull)
    "${COMPOSE[@]}" pull
    "${COMPOSE[@]}" up -d --no-build
    ;;
  status) "${COMPOSE[@]}" ps ;;
  logs)   "${COMPOSE[@]}" logs api --tail=300 ;;
  openapi)
    curl -fsS http://127.0.0.1:8000/openapi.json | head -c 4000
    echo
    echo "完整清单：npm run inspect-openapi"
    ;;
  bootstrap)
    cd "$SCRIPT_DIR/.."
    npm run dtk:bootstrap -- "${@:2}"
    ;;
  down) "${COMPOSE[@]}" down ;;
  *)
    echo "用法: $0 up|pull|status|logs|openapi|bootstrap|down" >&2
    exit 1
    ;;
esac
