#!/usr/bin/env bash
# DTK v5 容器栈操作封装（官方 compose 文件，不在本仓库重复维护）
# 用法: ./scripts/dtk.sh up|pull|status|logs|openapi|bootstrap|down
#
# 官方源码位置：默认与本项目同级（$WORKSPACE/douyin-api），也接受官方 clone 名。
# 其它位置用 DTK_REPO=/path/to/repo 指定。Linux / macOS 通用。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE="$(cd "$SCRIPT_DIR/../.." && pwd)"
DTK_REPO="${DTK_REPO:-$WORKSPACE/douyin-api}"
if [[ ! -f "$DTK_REPO/docker/compose.yml" ]]; then
  ALT="$WORKSPACE/Douyin_TikTok_Download_API"
  [[ -f "$ALT/docker/compose.yml" ]] && DTK_REPO="$ALT"
fi
COMPOSE_FILE="$DTK_REPO/docker/compose.yml"
CMD="${1:-status}"

if ! command -v docker >/dev/null 2>&1; then
  echo "未检测到 docker。先跑 ./scripts/setup-runtime.sh（Linux: Docker CE / macOS: Docker Desktop）。" >&2
  exit 1
fi

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "未找到 $COMPOSE_FILE" >&2
  echo "请把官方仓库 clone 到与本项目同级，或用 DTK_REPO=/path/to/repo 指定：" >&2
  echo "  git clone https://github.com/Evil0ctal/Douyin_TikTok_Download_API.git $WORKSPACE/Douyin_TikTok_Download_API" >&2
  exit 1
fi

# 官方 compose 用 env_file: ../.env，缺失时容器会拒绝启动；首次自动补齐随机密钥
ensure_dtk_env() {
  local env_file="$DTK_REPO/.env"
  [[ -f "$env_file" ]] && return 0
  echo "未找到 $env_file，自动生成随机密钥 + 官方发布镜像配置 ..."
  PG="$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("hex"))')"
  RD="$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("hex"))')"
  SK="$(node -e 'process.stdout.write(require("crypto").randomBytes(36).toString("base64url"))')"
  cat > "$env_file" <<EOF
DTK_SECRET_KEY=${SK}
POSTGRES_PASSWORD=${PG}
REDIS_PASSWORD=${RD}
DTK_DATABASE_URL=postgresql+asyncpg://dtk:${PG}@postgres:5432/dtk
DTK_REDIS_URL=redis://:${RD}@redis:6379/0
DTK_IMAGE=evil0ctal/douyin_tiktok_download_api
DTK_IMAGE_TAG=latest
# 启用 --profile browser 时取消注释（需构建 CloakBrowser，内网环境可能失败）
# DTK_BROWSER_RPC_URL=http://browser-rpc:9000
EOF
  chmod 600 "$env_file"
  echo "✅ 已生成 $env_file（权限 600，勿提交到任何仓库）"
}

COMPOSE=(docker compose -p dtk -f "$COMPOSE_FILE")
# 默认不启 browser profile：手动导入 Cookie；需要自动铸造游客身份时 DTK_BROWSER=1
if [[ "${DTK_BROWSER:-0}" == "1" ]]; then
  COMPOSE+=(--profile browser)
fi

case "$CMD" in
  up)
    ensure_dtk_env
    # 用官方发布镜像，避免本地源码构建（console 构建需要额外拉 node 镜像）
    "${COMPOSE[@]}" pull
    "${COMPOSE[@]}" up -d --no-build --wait --wait-timeout 300
    echo "已启动：http://127.0.0.1:8000（仅绑定 loopback）"
    echo "下一步：npm run dtk:bootstrap（自动建管理员 + 生成 API key）"
    ;;
  pull)
    ensure_dtk_env
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
