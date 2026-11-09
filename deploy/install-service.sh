#!/usr/bin/env bash
# 安装 douyin-monitor 为 systemd 服务（Linux 常驻方式）
#
#   sudo ./deploy/install-service.sh              # 运行用户取 SUDO_USER / 当前用户
#   sudo ./deploy/install-service.sh deploy      # 指定运行用户
#   SERVICE_TZ=Asia/Shanghai sudo ./deploy/install-service.sh
#
# 卸载： sudo systemctl disable --now douyin-monitor && sudo rm /etc/systemd/system/douyin-monitor.service && sudo systemctl daemon-reload
set -euo pipefail

[[ "$(uname -s)" == "Linux" ]] || { echo "❌ 仅支持 Linux（macOS 用 deploy/*.plist.template）" >&2; exit 1; }
command -v systemctl >/dev/null 2>&1 || { echo "❌ 未检测到 systemd" >&2; exit 1; }
[[ "$(id -u)" -eq 0 ]] || { echo "❌ 请用 sudo 运行本脚本" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATE="$SCRIPT_DIR/douyin-monitor.service.template"
UNIT="/etc/systemd/system/douyin-monitor.service"

SERVICE_USER="${1:-${SUDO_USER:-$(id -un)}}"
SERVICE_TZ="${SERVICE_TZ:-Asia/Shanghai}"
NODE_BIN="$(command -v node || true)"
[[ -n "$NODE_BIN" ]] || { echo "❌ 未找到 node" >&2; exit 1; }
NODE_DIR="$(dirname "$NODE_BIN")"

[[ -f "$TEMPLATE" ]] || { echo "❌ 缺少模板 $TEMPLATE" >&2; exit 1; }
[[ -f "$PROJECT_DIR/node_modules/tsx/dist/cli.mjs" ]] || {
  echo "❌ 未找到 tsx，请先在项目目录执行 npm install（better-sqlite3 需在目标机重新编译）" >&2
  exit 1
}
[[ -f "$PROJECT_DIR/.env" ]] || {
  echo "❌ 缺少 .env，请先 cp .env.example .env 并填写" >&2
  exit 1
}
id "$SERVICE_USER" >/dev/null 2>&1 || { echo "❌ 用户 $SERVICE_USER 不存在" >&2; exit 1; }

# 调度器要写 data/（SQLite、临时文件、local sink 产物）
mkdir -p "$PROJECT_DIR/data"
chown -R "$SERVICE_USER" "$PROJECT_DIR/data"
chmod 600 "$PROJECT_DIR/.env"

sed -e "s|__PROJECT_DIR__|${PROJECT_DIR}|g" \
    -e "s|__USER__|${SERVICE_USER}|g" \
    -e "s|__NODE_BIN__|${NODE_BIN}|g" \
    -e "s|__NODE_DIR__|${NODE_DIR}|g" \
    -e "s|__TZ__|${SERVICE_TZ}|g" \
    "$TEMPLATE" > "$UNIT"
chmod 644 "$UNIT"

systemctl daemon-reload
systemctl enable --now douyin-monitor

echo ""
echo "✅ 服务已安装并启动：$UNIT"
echo "   运行用户 : $SERVICE_USER"
echo "   工作目录 : $PROJECT_DIR"
echo "   时区     : $SERVICE_TZ（夜间窗口由 POLLING_TIMEZONE 独立控制，不依赖此项）"
echo ""
echo "常用命令："
echo "  systemctl status douyin-monitor"
echo "  journalctl -u douyin-monitor -f          # 实时日志"
echo "  journalctl -u douyin-monitor --since '1 day ago'"
echo "  systemctl restart douyin-monitor"
echo ""
echo "⚠️  只允许一个写进程：服务运行期间不要再手动执行 npm run once / retry-failed；"
echo "    npm run status 是只读的，随时可查。"
