#!/usr/bin/env bash
# 在「你自己的终端」里运行：首次安装 Docker Desktop 需要 GUI 授权，Agent 无法代劳。
# 用法: ./scripts/setup-runtime.sh
set -euo pipefail

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) DMG_URL="https://desktop.docker.com/mac/stable/amd64/Docker.dmg" ;;
  arm64)  DMG_URL="https://desktop.docker.com/mac/stable/arm64/Docker.dmg" ;;
  *) echo "未知架构 $ARCH" >&2; exit 1 ;;
esac

echo "=== 1/3 检查 Docker ==="
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo "✅ Docker 已就绪：$(docker --version)"
else
  DMG="$HOME/Downloads/Docker.dmg"
  echo "未检测到运行中的 Docker，开始安装（架构 $ARCH）"
  if [[ ! -s "$DMG" ]]; then
    echo "下载安装包到 $DMG ..."
    if ! curl -fL --http1.1 --retry 3 --max-time 1800 -o "$DMG" "$DMG_URL"; then
      echo "" >&2
      echo "自动下载失败（网络代理限制）。请手动下载后放到 $DMG 再重跑本脚本：" >&2
      echo "  $DMG_URL" >&2
      echo "或用浏览器打开 https://www.docker.com/products/docker-desktop/ 下载 Intel/Apple 对应版本。" >&2
      exit 1
    fi
  fi
  echo "挂载并安装到 /Applications ..."
  MNT="$(mktemp -d /tmp/docker-dmg.XXXXXX)"
  hdiutil attach "$DMG" -nobrowse -mountpoint "$MNT" >/dev/null
  cp -R "$MNT/Docker.app" /Applications/
  hdiutil detach "$MNT" >/dev/null
  open -a Docker
  echo ""
  echo "⚠️  已拉起 Docker Desktop。请在弹窗里点「允许 / OK」完成系统授权，"
  echo "    等菜单栏鲸鱼图标不再动画（约 1-2 分钟），然后重新运行本脚本。"
  exit 0
fi

echo ""
echo "=== 2/3 配置 Docker Hub 镜像加速（重要）==="
echo "当前网络直连 auth.docker.io / registry-1.docker.io 不通，必须配镜像源。"
echo "Docker Desktop → Settings（齿轮）→ Docker Engine，把右侧 JSON 改成："
echo ""
echo '{'
echo '  "registry-mirrors": ['
echo '    "https://docker.m.daocloud.io",'
echo '    "https://docker.1ms.run",'
echo '    "https://docker.xuanyuan.me",'
echo '    "https://hub.rat.dev"'
echo '  ]'
echo '}'
echo ""
echo "（若原有其它配置，只把 registry-mirrors 这一项合并进去）然后点 Apply & Restart。"
echo ""
echo "验证镜像源可用："
echo "  docker pull redis:8-alpine"
echo ""

echo "=== 3/3 启动 DTK 栈 ==="
echo "  npm run dtk:up        # 拉发布镜像并起 api/worker/postgres/redis"
echo "  npm run dtk:status    # 等全部 healthy"
echo "  npm run dtk:bootstrap # 自动建管理员 + 生成 API key 写回 .env"
echo ""
