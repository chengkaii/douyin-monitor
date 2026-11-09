#!/usr/bin/env bash
# 首次部署：准备容器运行时与镜像源。Linux 走 Docker CE + systemd；macOS 走 Docker Desktop。
#
#   Linux:  sudo ./scripts/setup-runtime.sh
#   macOS:       ./scripts/setup-runtime.sh   （GUI 授权需人工点一次）
#
# 只负责「运行时就绪」，不启动业务容器、不装业务服务，后续步骤见 README §3。
set -euo pipefail

MIRRORS_JSON='["https://docker.m.daocloud.io","https://docker.1ms.run","https://docker.xuanyuan.me","https://hub.rat.dev"]'

need_root() {
  if [[ "$(id -u)" -eq 0 ]]; then SUDO=""; else
    command -v sudo >/dev/null 2>&1 || { echo "需要 root 或 sudo 权限" >&2; exit 1; }
    SUDO="sudo"
  fi
}

check_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "❌ 未检测到 Node.js（本项目要求 >= 20）。请先安装：" >&2
    echo "   curl -fsSL https://fnm.vercel.app/install | bash && fnm install 22" >&2
    echo "   或参考 https://nodejs.org/ 的官方二进制包" >&2
    exit 1
  fi
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if [[ "$major" -lt 20 ]]; then
    echo "❌ Node.js 版本过低：$(node -v)，需要 >= 20" >&2
    exit 1
  fi
  echo "✅ Node.js $(node -v) | npm $(npm -v)"
}

# 合并 registry-mirrors 到现有 daemon.json，保留用户其它配置
write_daemon_json() {
  local path="/etc/docker/daemon.json" existing tmp
  existing="$(mktemp)"
  tmp="$(mktemp)"
  $SUDO mkdir -p /etc/docker
  $SUDO cat "$path" > "$existing" 2>/dev/null || true
  if ! EXISTING_FILE="$existing" MIRRORS="$MIRRORS_JSON" node -e '
    const fs = require("fs");
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(process.env.EXISTING_FILE, "utf8")); } catch { /* 不存在或非法 */ }
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) cfg = {};
    const mirrors = JSON.parse(process.env.MIRRORS);
    const current = Array.isArray(cfg["registry-mirrors"]) ? cfg["registry-mirrors"] : [];
    cfg["registry-mirrors"] = Array.from(new Set([...current, ...mirrors]));
    process.stdout.write(JSON.stringify(cfg, null, 2) + "\n");
  ' > "$tmp"; then
    echo "❌ 生成 daemon.json 失败，请手动加入 registry-mirrors：$MIRRORS_JSON" >&2
    rm -f "$existing" "$tmp"
    exit 1
  fi
  $SUDO cp "$tmp" "$path"
  rm -f "$existing" "$tmp"
  echo "✅ 已写入 $path（保留原有配置，仅合并 registry-mirrors）"
}

install_docker_linux() {
  # shellcheck disable=SC1091
  . /etc/os-release
  local distro="${ID:-unknown}"
  echo "检测到发行版：$distro ${VERSION_ID:-}"
  case "$distro" in
    ubuntu|debian)
      $SUDO apt-get update -qq
      $SUDO apt-get install -y -qq ca-certificates curl gnupg
      $SUDO install -m 0755 -d /etc/apt/keyrings
      if [[ ! -s /etc/apt/keyrings/docker.gpg ]]; then
        curl -fsSL --http1.1 "https://mirrors.aliyun.com/docker-ce/linux/${distro}/gpg" \
          | $SUDO gpg --batch --yes --dearmor -o /etc/apt/keyrings/docker.gpg
      fi
      $SUDO chmod a+r /etc/apt/keyrings/docker.gpg
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://mirrors.aliyun.com/docker-ce/linux/${distro} ${VERSION_CODENAME} stable" \
        | $SUDO tee /etc/apt/sources.list.d/docker.list >/dev/null
      $SUDO apt-get update -qq
      $SUDO apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      ;;
    centos|rhel|rocky|almalinux|fedora)
      $SUDO yum install -y -q yum-utils
      $SUDO yum-config-manager --add-repo https://mirrors.aliyun.com/docker-ce/linux/centos/docker-ce.repo
      $SUDO yum install -y -q docker-ce docker-ce-cli containerd.io docker-compose-plugin
      ;;
    *)
      echo "❌ 未适配发行版 $distro。请按官方文档安装 Docker CE + compose plugin 后重跑本脚本：" >&2
      echo "   https://docs.docker.com/engine/install/" >&2
      exit 1
      ;;
  esac
}

setup_linux() {
  need_root
  echo "=== 1/4 检查 Node.js ==="
  check_node

  echo ""
  echo "=== 2/4 检查 Docker CE + compose plugin ==="
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    echo "✅ Docker 已就绪：$(docker --version) / $(docker compose version)"
  else
    install_docker_linux
    $SUDO systemctl daemon-reload
    $SUDO systemctl enable --now docker
    echo "✅ Docker 已安装并设置为开机自启"
  fi

  echo ""
  echo "=== 3/4 配置 Docker Hub 镜像加速 ==="
  write_daemon_json
  $SUDO systemctl restart docker
  for _ in 1 2 3 4 5; do docker info >/dev/null 2>&1 && break; sleep 2; done
  docker info >/dev/null 2>&1 || { echo "❌ Docker 重启后未就绪，检查 journalctl -u docker" >&2; exit 1; }
  echo "✅ Docker 已重启并就绪"

  echo ""
  echo "=== 4/4 收尾 ==="
  echo "容器运行时准备完成。接下来（README §3）："
  echo "  cp .env.example .env && cp accounts.example.yaml accounts.yaml"
  echo "  npm install                 # better-sqlite3 需在目标机重新编译"
  echo "  # 官方 DTK 源码放到同级 douyin-api/，或设置 DTK_REPO=/path/to/repo"
  echo "  npm run dtk:up && npm run dtk:bootstrap"
  echo "  sudo ./deploy/install-service.sh"
  echo ""
  echo "注意：DTK 的 api 容器只绑 127.0.0.1:8000，无需开放防火墙端口。"
}

setup_macos() {
  echo "=== 1/3 检查 Node.js ==="
  check_node

  echo ""
  echo "=== 2/3 检查 Docker Desktop ==="
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    echo "✅ Docker 已就绪：$(docker --version)"
  else
    local arch dmg_url dmg mnt
    arch="$(uname -m)"
    case "$arch" in
      x86_64) dmg_url="https://desktop.docker.com/mac/stable/amd64/Docker.dmg" ;;
      arm64)  dmg_url="https://desktop.docker.com/mac/stable/arm64/Docker.dmg" ;;
      *) echo "未知架构 $arch" >&2; exit 1 ;;
    esac
    dmg="$HOME/Downloads/Docker.dmg"
    echo "未检测到运行中的 Docker，开始安装（架构 $arch）"
    if [[ ! -s "$dmg" ]]; then
      curl -fL --http1.1 --retry 3 --max-time 1800 -o "$dmg" "$dmg_url" || {
        echo "自动下载失败。请手动下载后放到 $dmg 再重跑，或浏览器打开 https://www.docker.com/products/docker-desktop/" >&2
        exit 1
      }
    fi
    mnt="$(mktemp -d /tmp/docker-dmg.XXXXXX)"
    hdiutil attach "$dmg" -nobrowse -mountpoint "$mnt" >/dev/null
    cp -R "$mnt/Docker.app" /Applications/
    hdiutil detach "$mnt" >/dev/null
    open -a Docker
    echo "⚠️  已拉起 Docker Desktop，请在弹窗完成系统授权，等鲸鱼图标静止后重跑本脚本。"
    exit 0
  fi

  echo ""
  echo "=== 3/3 配置镜像加速 ==="
  echo "Docker Desktop → Settings → Docker Engine，把 registry-mirrors 合并进去并 Apply & Restart："
  echo "$MIRRORS_JSON"
  echo ""
  echo "然后：npm run dtk:up && npm run dtk:bootstrap"
}

case "$(uname -s)" in
  Linux) setup_linux ;;
  Darwin) setup_macos ;;
  *) echo "不支持的操作系统：$(uname -s)" >&2; exit 1 ;;
esac
