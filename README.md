# douyin-monitor

抖音固定账号新作品监测：**发现 → 增量去重 → 下载无水印视频 + 文案 → 上传 OSS → 交给云端转录/翻译管线**。

设计文档：[`docs/2026-11-05-douyin-monitor-design.md`](docs/2026-11-05-douyin-monitor-design.md)

---

## 1. 它是什么 / 不是什么

| | |
|---|---|
| 采集端常驻 | 一个 Node.js 调度器 + Docker 里的 Evil0ctal DTK v5 容器栈 |
| 云端 | 只消费 OSS 上成对出现的 `.mp4` + `.json`，不直接跟采集器通信 |
| 不需要 | 屏幕常开浏览器、人工点页面、登录态挂在浏览器里 |
| 需要 | Docker 常驻、调度器进程、主机不休眠 |

> **部署平台**：当前 `scripts/setup-runtime.sh`、`deploy/*.plist`、§5 常驻方式为 **macOS + Docker Desktop / launchd** 版；Linux 服务器版（Docker CE + systemd）尚未适配。`src/`、配置与 DTK 接口契约本身平台无关，服务器上可直接 `clone → npm install → npm run serve`。

DTK v5 的 README 不列固定路径清单，但本项目已从 **v5.1.7 源码**逐条确认了真实契约（作品列表、单视频、任务状态、鉴权头、cursor 语义），已写进 `.env` 与 `src/config.ts` 默认值。`npm run inspect-openapi` 仍保留，用于实例版本不同时核对——路径与参数依旧全部可配置。

---

## 2. 三分钟验证（零凭据、零 Docker）

```bash
npm install
npm run demo          # 本地 mock DTK + 假视频，跑两轮验证全链路与去重
npm run type-check    # tsc --noEmit
npm test              # 33 个测试（含失败/恢复路径）
```

`npm run demo` 会启动 `127.0.0.1:8787` 的 mock 服务，模拟 v5 的 `202 + task_id` 异步模式，产出：

```
data/demo/outbox/douyin-monitor/MS4wLjAB/202611/
  7450000000000000001.mp4 / .json   ...共 3 组
```

第 1 轮发现 3 条并交付，第 2 轮发现 0 条（验证增量去重），最后打印 `✅ 全链路通过`。

---

## 3. 正式部署

> **从 GitHub clone 到新机器（含 Linux 服务器）时**，仓库不含 `.env` / `accounts.yaml` / `data/`，先做一次初始化：
>
> ```bash
> cp .env.example .env                 # DTK 接口路径已按 v5.1.7 填好，只需补 DTK_API_KEY / OSS_*
> cp accounts.example.yaml accounts.yaml
> npm install                          # better-sqlite3 是原生模块，必须在目标机重新编译，别直接拷 node_modules
> ```
>
> 官方 DTK 源码是第三方仓库，未纳入本项目，需单独放到同级 `douyin-api/`（见 §3.1）。远端推荐用 SSH：`git clone git@github.com:chengkaii/douyin-monitor.git`。

### 3.1 起 DTK v5 容器栈（首次需你在自己终端操作一次）

> ⚠️ **平台说明**：以下为 macOS 步骤。Linux 服务器请用 Docker CE + `/etc/docker/daemon.json` 配镜像源，并把 §5 的 launchd 换成 systemd unit（适配待做）。DTK 容器本身与 Node 调度器在 Linux 上运行无差异。

```bash
./scripts/setup-runtime.sh
```

脚本会检查 Docker → 下载并安装 Docker Desktop（自动判断 Intel/Apple）→ 拉起 GUI 授权 → 打印镜像源配置。**Docker Desktop → Settings → Docker Engine** 里合并下面这段并 Apply & Restart：

```json
{
  "registry-mirrors": [
    "https://docker.m.daocloud.io",
    "https://docker.1ms.run",
    "https://docker.xuanyuan.me",
    "https://hub.rat.dev"
  ]
}
```

> 不配镜像源会卡在拉镜像：`auth.docker.io` / `registry-1.docker.io` 当前不可达，上面几个镜像站实测可达。

官方 DTK 源码**未纳入本仓库**：把它 clone 到同级 `douyin-api/`，或用 `DTK_REPO=/path/to/repo` 指定；并在该目录生成 `.env`（`DTK_SECRET_KEY` / `POSTGRES_PASSWORD` / `REDIS_PASSWORD` / `DTK_DATABASE_URL` / `DTK_REDIS_URL` / `DTK_IMAGE=evil0ctal/douyin_tiktok_download_api`）。之后三步：

```bash
npm run dtk:up         # 拉发布镜像 + 起 api/worker/postgres/redis（--no-build）
npm run dtk:status     # 等全部 healthy
npm run dtk:bootstrap  # 自动建管理员 → 登录 → 生成 douyin:read 的 API key → 写回 .env
```

`dtk:bootstrap` 全程 HTTP，**不用打开浏览器控制台**；setup token 自动从容器日志提取，也可 `npm run dtk:bootstrap -- --token <token>` 手动指定。管理员凭据存在 `data/dtk-admin.json`（已 gitignore）。

**关于 browser profile**：一期默认不启——它要从 GitHub 构建 CloakBrowser，当前网络风险高。改为在 console 手动导入一次登录态 Cookie。要启用自动铸造游客身份：`DTK_BROWSER=1 npm run dtk:up`，并取消 `../douyin-api/.env` 里 `DTK_BROWSER_RPC_URL` 的注释。

### 3.2 接口契约（已按 v5.1.7 源码确认）

| 用途 | 方法 + 路径 | 关键参数 |
|---|---|---|
| 账号作品列表 | `GET /api/v1/douyin/user/posts` | `sec_user_id`、`count=20`、`wait=25`；翻页带 `cursor`，**首屏必须省略** |
| 单视频详情 | `GET /api/v1/douyin/video` | `aweme_id`、`wait=25` |
| 任务结果 | `GET /api/v1/tasks/{taskId}` | `DTK_SYNC_WAIT=0` 时才走异步轮询 |
| 初始化 / 登录 / 发 key | `POST /api/setup/init`、`/api/v1/auth/login`、`/api/v1/admin/api-keys` | 由 `dtk:bootstrap` 完成 |

鉴权头是 **`X-API-Key`**（`Authorization: Bearer` 仅兼容），Channel 两个都发；列表接口需要 `douyin:read` scope，bootstrap 已按此创建。以上值已写进 `.env` 和 `src/config.ts` 默认值，实例版本不同时跑 `npm run inspect-openapi` 核对。

`Channel` 层做了防御式归一化：常见包装形状（`data/result/posts/aweme_list/items`）、播放地址（扁平字段或 `video.play_addr.url_list`）、统计字段都能自动识别。字段有出入时**只改 `src/normalize.ts` 和 `src/metadata.ts`**。

> ⚠️ 归一化不等于"静默容错"：找不到作品数组容器、或条目解析不出 `video_id`，一律抛 `ChannelError` 并进入指数退避 + 告警，**不会**被当成「账号没发新作品」。只有响应里确实是合法空数组，才记 0 新增。老账号突然返回空列表会额外写一条 `poll-empty` warn 日志，便于排查登录态失效。

### 3.3 填账号与凭据

`.env` 与 `accounts.yaml` 含凭据，**不入库**；从 GitHub clone 的全新环境先按 §3 开头复制模板再编辑：

```bash
# 填入每个账号的 sec_user_id（抖音 App → 主页 → 分享 → 复制链接 → 浏览器重定向后的 /user/MS4w...）
# 试跑期保留 intervalMinutes: 30；确认无漏检后再改 5
```

`.env` 里按需设置：

| 变量 | 说明 | 默认 |
|---|---|---|
| `SINK` | `local`（演练）或 `oss`（正式） | `local` |
| `OSS_*` | ffyc-creator 的 region/bucket/AK/SK | — |
| `OSS_PREFIX` | 对象前缀 | `douyin-monitor/` |
| `DTK_API_KEY` | console 生成的 key | — |
| `DTK_SYNC_WAIT` | >0 用 `?wait=N` 同步；0 走 `202 + task_id` 轮询 | `25` |
| `RETRY_MAX_ATTEMPTS` | 单条视频跨轮最多处理次数（1 次首发 + N 次自动重投） | `5` |
| `RETRY_FAILED_EVERY_ROUNDS` | `serve` 每 N 轮扫一次 `failed`（15s/轮，20 ≈ 5 分钟） | `20` |
| `WECOM_WEBHOOK` | 企微机器人告警，留空则只写 `run_log` | 空 |

> 这两个 retry 值也可以在 `accounts.yaml` 的 `retry:` 段配置，yaml 优先于 env。

### 3.4 跑起来

```bash
npm run once -- --force     # 手动跑一轮（--force 忽略轮询到期）
npm run status              # 查看已见视频数、队列深度、各账号下次轮询、最近日志
npm run serve               # 常驻，每 15s 检查到期账号；每 N 轮顺带自动重投 failed
```

`npm run once` 的其他参数：`--account "账号名"` 只跑某个账号，`--retry-failed` 把未达上限的 failed 重新入队。

`npm run retry-failed` 是手动补投；已耗尽尝试次数的行默认跳过，确认故障已修复后可用 `npm run retry-failed -- --force` 突破上限。`npm run status` 会显示「可自动重投 / 已达上限」的失败条数。

---

## 4. 交付契约（云端消费）

OSS key 规则：`douyin-monitor/{secUserId前8位}/{yyyyMM}/{videoId}.{mp4|json}`

`.json` manifest 示例：

```json
{
  "videoId": "7450000000000000001",
  "secUserId": "MS4wLjABAAAA...",
  "author": { "nickname": "账号A", "signature": "简介" },
  "desc": "视频文案原文，含话题标签",
  "createTime": 1762400000,
  "stats": { "digg_count": 100, "comment_count": 10, "share_count": 1 },
  "sourceUrl": "https://www.douyin.com/video/7450000000000000001",
  "videoFile": "7450000000000000001.mp4",
  "videoUrlOss": "https://ffyc-creator.oss-cn-beijing.aliyuncs.com/douyin-monitor/.../7450000000000000001.mp4",
  "discoveredAt": 1762400500,
  "uploadedAt": 1762400600
}
```

一期建议云端定时 `ListObjects` 扫前缀；二期可加上传成功后的回调通知。

---

## 5. 常驻与自愈

`deploy/com.starpp.douyin-monitor.plist.template` 是 launchd 模板：

```bash
mkdir -p data/logs
sed -e "s|__PROJECT_DIR__|$PWD|g" -e "s|__HOME__|$HOME|g" \
  deploy/com.starpp.douyin-monitor.plist.template \
  > ~/Library/LaunchAgents/com.starpp.douyin-monitor.plist
launchctl load ~/Library/LaunchAgents/com.starpp.douyin-monitor.plist
```

> 模板里的 node 路径按 nvm 默认写法，若你用 Homebrew/volta 装 Node，把 `ProgramArguments` 第一项和 `PATH` 改成 `which npm` 的实际结果。

`KeepAlive` 保证崩溃重启，状态全在 SQLite，重启后从断点续传：

| 崩溃点 | 重启后行为 |
|---|---|
| 正在下载（`downloading`） | 启动时重置为 `pending`，重新下载；不会永久卡在队列外 |
| 已下载待上传（`downloaded`） | 下一轮自动重新入队（当前实现会重新下载，见下方边界） |
| 处理失败（`failed`） | `serve` 每 N 轮自动重投，受 `attempts` 上限约束，坏视频不会无限重试 |
| 已交付（`uploaded`） | 不再处理 |

> **只允许一个写进程**：`serve` 跑着时不要同时执行 `once` / `retry-failed`，否则可能重复处理同一条。`status` 是只读命令，不触发任务恢复，随时可查。
>
> 已知边界：`downloaded` 补传会重新下载而非复用本地文件（见设计文档 §6），临时文件在失败分支未清理——这两项属于第二批优化。

**必须防休眠**：`caffeinate -s &` 或「系统设置 → 电池 → 防止自动睡眠」。合盖休眠会直接断采。

---

## 6. 目录结构

```
src/
  config.ts          配置加载（.env + accounts.yaml）
  types.ts           配置与领域类型
  normalize.ts       DTK 响应防御式归一化（唯一字段适配层）
  channel/           Channel 抽象 + evil0ctal v5 实现 + TikHub 预留
  store.ts           SQLite（videos / poll_state / run_log）+ 崩溃恢复 + attempts 计数
  scheduler.ts       错峰、指数退避、夜间放宽、最小间隔限速
  downloader.ts      流式下载 + 大小/类型校验 + 重试
  metadata.ts        manifest 生成 + OSS key 规则
  sink.ts            local（演练）/ oss（正式）
  notify.ts          run_log + 企微告警收敛
  pipeline.ts        轮询 → 队列 → 状态闭环的全部编排
  cli.ts             once / serve / status / retry-failed
scripts/
  dtk.sh             官方 compose 封装（up/pull/status/logs/bootstrap）
  setup-runtime.sh   首次安装 Docker Desktop + 镜像源指引（需在你自己终端跑）
  bootstrap.ts       自动初始化管理员 + 生成 API key 写回 .env
  inspect-openapi.ts 核对实例 OpenAPI 路径
  mock-dtk.ts        本地 mock v5 服务 + 假视频
  demo.ts            一键端到端演练
test/                33 个测试（同步/异步 E2E + 崩溃恢复、结构不符、重投上限、v5 契约）
deploy/              launchd 常驻模板（macOS；Linux 版 systemd 待补）
docs/                技术实现文档（需求快照、架构、接口契约、风控与里程碑）
```

---

## 7. 风控与合规

- 20+ 账号统一周期但**请求间隔 ≥ 8s**（`polling.minGapSeconds`），随机抖动打散规律；夜间周期放宽到 15 分钟
- v5 自带自愈身份池、令牌桶、端点熔断；本项目这层只做账号级失败退避（连续失败指数退避，上限 24h）与告警
- 只拉作品列表首页，不深翻页扫库；单次发现接近整页（≥15 条）才最多补 2 页
- 采集内容仅用于内部转录/翻译再创作，不二次分发原始视频；账号如有维权声明即从清单移除
- DTK 是第三方逆向项目（Apache-2.0 只授权源码），自托管不等于平台授权采集，请自行评估使用场景

---

## 8. 当前状态与边界

| 项 | 状态 |
|---|---|
| 代码骨架、SQLite、调度、下载、manifest、OSS/local sink、告警、CLI | ✅ 已实现 |
| review 第一批修复：崩溃恢复 / 结构不符拒绝假成功 / failed 自动重投封顶 | ✅ 已修复并补回归测试 |
| 类型检查 `tsc --noEmit` / 32 个测试 / 一键 demo | ✅ 0 错误、全通过 |
| review 第二批（🟡 限速器竞态、账号目录撞车、补传复用本地文件、告警收敛等） | ⚠️ 未做，按优先级排期 |
| 切 TikHub 备用通道 | ⚠️ 仅占位（`src/channel/tikhub.ts`），需要时补两个方法 |
| 真实 DTK 容器联调 | ⚠️ **未做**：本机没有 Docker，`DTK_POSTS_PATH` 等待 `inspect-openapi` 实测填写 |
| 真实账号 / OSS 凭据 | ⚠️ 未提供，代码用 mock 与 local sink 保证可验证 |
| 云端回调通知（二期） | ⚠️ 未做，一期用 ListObjects 即可 |

**上线顺序**：起容器 → `inspect-openapi` 填路径 → 2 个账号 + 30 分钟周期试跑 3 天（对照 App 查漏检）→ 切 `SINK=oss` → 扩到 20+ 账号 + 5 分钟周期 → 装 launchd。
