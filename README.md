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
| 需要 | Docker 常驻、调度器进程（systemd 托管）、机房 IP 场景配住宅代理 |

> **部署平台**：主形态是 **Linux 服务器 + Docker CE + systemd**——`scripts/setup-runtime.sh` 按 `uname` 自动分流，`deploy/install-service.sh` 安装 systemd unit。macOS 本地调试仍可用 Docker Desktop + `deploy/*.plist`（见 §5 末尾）。`src/`、配置与 DTK 接口契约全部平台无关。

DTK v5 的 README 不列固定路径清单，但本项目已从 **v5.1.7 源码**逐条确认了真实契约（作品列表、单视频、任务状态、鉴权头、cursor 语义），已写进 `.env` 与 `src/config.ts` 默认值。`npm run inspect-openapi` 仍保留，用于实例版本不同时核对——路径与参数依旧全部可配置。

---

## 2. 三分钟验证（零凭据、零 Docker）

```bash
npm install
npm run demo          # 本地 mock DTK + 假视频，跑两轮验证全链路与去重
npm run type-check    # tsc --noEmit
npm test              # 77 个测试（含失败/恢复/补传复用/幂等/限速告警、secuid 解析与 doctor 自检）
```

`npm run demo` 会启动 `127.0.0.1:8787` 的 mock 服务，模拟 v5 的 `202 + task_id` 异步模式，产出：

```
data/demo/outbox/douyin-monitor/{secUserId 哈希12位}/202611/
  7450000000000000001.mp4 / .json   ...共 3 组
```

第 1 轮发现 3 条并交付，第 2 轮发现 0 条（验证增量去重），最后打印 `✅ 全链路通过`。

---

## 3. 正式部署

> **从 GitHub clone 到新机器（Linux 服务器）时**，仓库不含 `.env` / `accounts.yaml` / `data/`，先初始化：
>
> ```bash
> git clone git@github.com:chengkaii/douyin-monitor.git /opt/douyin-monitor
> cd /opt/douyin-monitor
> sudo ./scripts/setup-runtime.sh      # Docker CE + compose plugin + 镜像源 + Node 检查
> cp .env.example .env                 # DTK 接口路径已按 v5.1.7 填好
> cp accounts.example.yaml accounts.yaml   # 也可跳过：npm run add-account 会自动从模板初始化
> npm install                          # better-sqlite3 是原生模块，必须在目标机重新编译
> ```
>
> 官方 DTK 源码是第三方仓库，未纳入本项目：clone 到**与本项目同级**目录（如 `/opt/Douyin_TikTok_Download_API/`），或用 `DTK_REPO=/path/to/repo` 指定。

### 3.1 起 DTK v5 容器栈（Linux）

`setup-runtime.sh` 已装好 Docker CE + compose plugin、合并 `/etc/docker/daemon.json` 的 registry-mirrors、设置 Docker 开机自启。接下来：

```bash
# 官方源码放到与本项目同级的目录，例如都在 /opt/ 下
git clone https://github.com/Evil0ctal/Douyin_TikTok_Download_API.git \
  /opt/Douyin_TikTok_Download_API

npm run dtk:up         # 自动生成官方 .env → 拉发布镜像 → 起栈并等 healthy
npm run dtk:status     # 复核 api/worker/postgres/redis 全部 healthy
npm run dtk:bootstrap  # 建管理员 → 登录 → 生成 douyin:read API key → 写回 .env
```

要点：

- `dtk:up` 用官方发布镜像（`--no-build`），不本地构建 console；首次会自动生成官方仓库根的 `.env`（权限 600，含随机 `DTK_SECRET_KEY` / DB / Redis 密码），**别提交到任何仓库**。
- DTK 的 `api` 只绑 `127.0.0.1:8000`，**无需开放防火墙端口**；compose 里各服务都是 `restart: unless-stopped`。
- `dtk:bootstrap` 全程 HTTP，setup token 自动从容器日志提取，也可 `-- --token <token>` 手动指定；管理员凭据存 `data/dtk-admin.json`（已 gitignore）。
- Docker Hub 直连不通时，靠 `setup-runtime.sh` 写入的镜像源兜底（daocloud / 1ms / 轩辕 / rat.dev）。

**关于 browser profile**：一期默认不启——它要从 GitHub 构建 CloakBrowser，内网环境风险高。改为在 console 手动导入一次登录态 Cookie。要启用自动铸造游客身份：`DTK_BROWSER=1 npm run dtk:up`，并取消官方仓库 `.env` 里 `DTK_BROWSER_RPC_URL` 的注释。

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

**账号不用手抠 `sec_user_id`**，粘链接即可：

```bash
npm run add-account -- "https://www.douyin.com/user/MS4wLjABAAAA..." --name 某某
npm run add-account -- "长按复制此条消息… https://v.douyin.com/xxxxx/"   # 短链 / 分享文案
npm run add-account -- "MS4wLjABAAAA..."                                  # 纯 id
```

支持纯 `sec_user_id` / 主页链接 / 短链 / 整段分享文案；纯本地正则能命中就不发网络，只有短链才用 `HEAD` 跟重定向（**只跟随 `douyin.com` 域、最多 4 跳**，防 SSRF）。重复 `sec_user_id` 自动跳过，模板里的 `REPLACE_ME` 占位账号自动清除；写回按行编辑，**保留注释与 `polling` / `retry` 等原有配置**。短链解析失败会提示改粘浏览器重定向后的 `/user/` 主页地址。

> 试跑期保留 `intervalMinutes: 30`；确认无漏检后再改 5。

`.env` 里按需设置：

| 变量 | 说明 | 默认 |
|---|---|---|
| `SINK` | `local`（演练）或 `oss`（正式） | `local` |
| `OSS_*` | ffyc-creator 的 region/bucket/AK/SK | — |
| `OSS_PREFIX` | 对象前缀 | `douyin-monitor/` |
| `DTK_API_KEY` | console 生成的 key | — |
| `DTK_SYNC_WAIT` | >0 用 `?wait=N` 同步；0 走 `202 + task_id` 轮询 | `25` |
| `DTK_PROXY_URL` | 住宅代理完整 URL，**机房 IP 部署必配**，见 §3.5 | 空（直连） |
| `POLLING_TIMEZONE` | 夜间窗口时区；`accounts.yaml` 的 `polling.timeZone` 优先 | `Asia/Shanghai` |
| `RETRY_MAX_ATTEMPTS` | 单条视频跨轮最多处理次数（1 次首发 + N 次自动重投） | `5` |
| `RETRY_FAILED_EVERY_ROUNDS` | `serve` 每 N 轮扫一次 `failed`（15s/轮，20 ≈ 5 分钟） | `20` |
| `WECOM_WEBHOOK` | 企微机器人告警，留空则只写 `run_log` | 空 |

> 这两个 retry 值也可以在 `accounts.yaml` 的 `retry:` 段配置，yaml 优先于 env。

### 3.4 先自检，再跑起来

```bash
npm run doctor               # 上线前 / 排障第一条命令
npm run once -- --force      # 手动跑一轮（--force 忽略轮询到期）
npm run status               # 查看已见视频数、队列深度、各账号下次轮询、最近日志
npm run serve                # 常驻，每 15s 检查到期账号；每 N 轮顺带自动重投 failed
```

`doctor` 把两类问题**彻底分开**：先查本地（Node 版本、`.env` / `accounts.yaml`、API key、接口路径、账号合法性、OSS 凭据、目录可写、时区、告警配置），本地有错就直接返回、不再探测上游；再查 DTK（`/readyz` 可达、`/auth/me` 鉴权与 scope、首个账号能否读出作品）。退出码 **0 通过 / 2 本地配置错误 / 3 上游故障**，便于 CI 或 systemd 直接判定。

```bash
npm run doctor -- --all-accounts   # 逐个验证所有账号（每个消耗 1 个身份租约）
npm run doctor -- --no-probe       # 只查本地配置，完全不碰上游
```

> 老账号返回**合法空列表**时 doctor 给 `warn` 而不是「通过」——这类静默失败常见于登录态过期 / 游客视角，接口本身并不报错。

`npm run once` 的其他参数：`--account "账号名"` 只跑某个账号，`--retry-failed` 把未达上限的 failed 重新入队。

`npm run retry-failed` 是手动补投；已耗尽尝试次数的行默认跳过，确认故障已修复后可用 `npm run retry-failed -- --force` 突破上限。`npm run status` 会显示「可自动重投 / 已达上限」的失败条数。

### 3.5 机房 IP 风控：住宅代理（Linux 部署必读）

服务器出口是机房 IP，抖音对作品列表/详情接口的风控明显严于住宅宽带。**正式跑 20+ 账号前必配住宅代理**：

```bash
# .env
DTK_PROXY_URL=http://user:pass@proxy.example.com:8080
```

支持 `http` / `https` / `socks5` / `socks5h` 完整 URL。该值由 Channel 作为 `?proxy=` 传给 DTK 的 `/{platform}/user/posts` 与 `/{platform}/video`，DTK 内部用 `wreq.Proxy` 把「DTK → 抖音」的上游请求换成住宅出口——**不用给容器塞 `HTTP_PROXY`，也不用给 Node 装代理库**。

> DTK 默认 `security.request_proxy=deny`（防 SSRF），带 `?proxy=` 会被直接拒绝。`npm run dtk:bootstrap` 检测到 `DTK_PROXY_URL` 非空时会自动用管理员会话把它设为 `public`（仅允许公网可路由地址，不开 `any`）。若这步失败会打印手动指引，**此时别开跑**，否则每轮轮询都会失败。不用代理时建议在 console 改回 `deny` 收窄攻击面。

三条边界：

- 本机 `Node → 127.0.0.1:8000`、OSS 上传、企微告警**都不走代理**；
- 视频 CDN 下载直连——静态资源不是风控面，且大文件走住宅代理流量成本极高；
- 代理凭据会出现在 DTK 的请求 URL 里（DTK 侧日志已脱敏，本项目错误信息只打 pathname），别把容器访问日志外泄。

先按 §8 用 2 账号 / 30 分钟周期试跑 3 天，观察 4xx 与「老账号突然返回合法空列表」的比例；异常先降频或换代理，再考虑切 TikHub 备用通道。

---

## 4. 交付契约（云端消费）

OSS key 规则：`douyin-monitor/{secUserId 的 sha256 前 12 位}/{yyyyMM}/{videoId}.{mp4|json}`

> 账号目录**不能**截 `sec_user_id` 前 8 位：抖音的 `sec_user_id` 普遍以 `MS4wLjABAAAA` 开头，20+ 账号会全部撞进同一个 `MS4wLjAB/` 目录。哈希保证同一账号稳定映射、不同账号互不干扰。升级后 key 前缀会变，已在 OSS 上的旧对象需按 `videoId` 自行迁移（当前尚未真实联调，无历史对象）。

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
  "videoSha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "videoBytes": 1049088,
  "discoveredAt": 1762400500,
  "uploadedAt": 1762400600
}
```

> `videoSha256` / `videoBytes` 是交付 MP4 的完整性指纹：云端以 JSON 为就绪标记，处理前先核对 MP4 的字节数与哈希，避免拿到半截文件。MP4 先上传并核对远端大小，JSON 才最后落地。

一期建议云端定时 `ListObjects` 扫前缀；二期可加上传成功后的回调通知。

---

## 5. 常驻与自愈

### Linux（systemd，主部署形态）

```bash
sudo ./deploy/install-service.sh            # 渲染 unit → daemon-reload → enable --now
systemctl status douyin-monitor
journalctl -u douyin-monitor -f            # 实时日志
```

脚本会按 `SUDO_USER` 设运行用户、用 `node` 绝对路径写 `ExecStart`、把 `data/` 属主改给运行用户、将 `.env` 权限收为 600。unit 关键项：`Restart=always` + `RestartSec=10`、`After/Requires=docker.service`、`WantedBy=multi-user.target`；日志走 journald（自带轮转，不再写固定文件）。

容器侧由 compose 的 `restart: unless-stopped` 与 `systemctl enable --now docker` 覆盖，服务器重启后自动恢复。状态全在 SQLite，重启后从断点续传：

| 崩溃点 | 重启后行为 |
|---|---|
| 首次下载中断（`downloading`，无完整性指纹） | 启动时重置为 `pending`，重新下载；不会永久卡在队列外 |
| 补传中断（`downloading`，已有完整 MP4） | 启动时回到 `downloaded`，下一轮复用本地文件补传 |
| 已下载待上传（`downloaded`） | 下一轮自动入队；本地文件大小/sha256 与库中记录一致才复用，否则重新下载 |
| 处理失败（`failed`） | `serve` 每 N 轮自动重投，受 `attempts` 上限约束，坏视频不会无限重试 |
| 已交付（`uploaded`） | 不再处理 |

> **只允许一个写进程**：systemd 服务运行期间不要手动执行 `once` / `retry-failed`，否则可能重复处理同一条。`status` 只读，随时可查。
>
> **交付保障**：MP4 落盘即算 sha256 存 SQLite；`downloaded` 补传复用前会重算哈希比对，不符则回退重新下载。上传按 key + 大小幂等；MP4 先传并核对远端大小，JSON 才作为就绪标记落地。任何失败分支都会清掉临时 JSON，完整 MP4 保留给下一轮补传，交付成功后才删除本地文件。
>
> 已知边界：`stat` 只比对字节数（OSS `head` 的 ETag 对分片上传不等于 MD5），sha256 由云端消费前自行复核；`createTime=0` 时年月取当前月份，跨月重试可能换 key；`run_log` 暂无自动清理策略，长期运行需自行配置 SQLite 保留窗口。

**时区**：unit 设 `TZ=Asia/Shanghai`；夜间窗口另由 `POLLING_TIMEZONE` / `polling.timeZone` 独立判定（代码用 `Intl.DateTimeFormat` 取小时），云主机默认 UTC 也不会把北京时间 0–6 点错判成白天。

**告警收敛**：`error` 和 `warn`（含 `poll-empty` 这类静默失败）都会推企微。去重 key = `scope + 主体（账号名 / videoId）+ 归一化错误`，同一账号连续失败 30 分钟内只推一次，但不同账号各自能报出来；每个 scope 单窗口最多 5 条，超出部分在下个窗口汇总成「另有 N 条被收敛」。webhook 返回 4xx/5xx 不占窗口名额，下一条会重试；所有明细始终写 `run_log`。

### macOS 本地调试（可选）

```bash
mkdir -p data/logs
sed -e "s|__PROJECT_DIR__|$PWD|g" -e "s|__HOME__|$HOME|g" \
  deploy/com.starpp.douyin-monitor.plist.template \
  > ~/Library/LaunchAgents/com.starpp.douyin-monitor.plist
launchctl load ~/Library/LaunchAgents/com.starpp.douyin-monitor.plist
```

`KeepAlive` / `RunAtLoad` 等价 systemd 的重启与自启；另需 `caffeinate -s &` 防合盖休眠。生产不用这套。

---

## 6. 目录结构

```
src/
  config.ts          配置加载（.env + accounts.yaml，账号 id 同步归一化）
  types.ts           配置与领域类型
  secuid.ts          纯本地 sec_user_id 解析 + 短链 HEAD（零 DTK scope）
  account-file.ts    accounts.yaml 按行录入（保留注释、去重、清占位）
  doctor.ts          自检的纯判断与渲染（本地 / 上游两类检查项）
  normalize.ts       DTK 响应防御式归一化（唯一字段适配层）
  channel/           Channel 抽象 + evil0ctal v5 实现 + TikHub 预留
  store.ts           SQLite（videos / poll_state / run_log）+ 崩溃恢复 + attempts + 本地文件完整性指纹
  scheduler.ts       错峰、指数退避、夜间放宽、全局预约式限速（列表 + 详情共用）
  downloader.ts      流式下载 + 大小/类型校验 + sha256 + 补传复用 + 重试
  metadata.ts        manifest 生成（含 sha256/bytes）+ OSS key 规则（账号目录哈希）
  sink.ts            local（演练）/ oss（正式）+ stat 幂等与配对校验
  notify.ts          run_log + 企微告警按主体收敛与窗口汇总
  pipeline.ts        轮询 → 队列 → 状态闭环的全部编排
  cli.ts             once / serve / status / retry-failed
scripts/
  dtk.sh             官方 compose 封装（up/pull/status/logs/bootstrap，自动生成官方 .env）
  setup-runtime.sh   双平台运行时准备（Linux: Docker CE + 镜像源 / macOS: Docker Desktop）
  bootstrap.ts       初始化管理员 + 发 API key + 按需开启 request_proxy，写回 .env
  doctor.ts          自检 CLI：本地配置 / 上游故障分流，退出码 0|2|3
  add-account.ts     粘链接录账号（纯本地解析 + 短链重定向，按行写回 yaml）
  inspect-openapi.ts 核对实例 OpenAPI 路径
  mock-dtk.ts        本地 mock v5 服务 + 假视频
  demo.ts            一键端到端演练
test/                77 个测试（同步/异步 E2E + 崩溃恢复、结构不符、重投上限、v5 契约、时区/代理、补传复用/篡改回退/幂等/配对校验、限速竞态/账号目录/告警收敛、secuid 解析/账号录入/doctor 分流）
deploy/              systemd unit + install-service.sh（Linux）/ launchd plist（macOS）
docs/                技术实现文档（需求快照、架构、接口契约、风控与里程碑）
```

---

## 7. 风控与合规

- 20+ 账号统一周期但**所有 DTK 请求间隔 ≥ 8s**（`polling.minGapSeconds`）：作品列表、翻页、每条视频详情共用一个预约式限速器，并发调用先占位再等待，不会同时穿透；随机抖动打散规律，夜间（北京时间 0–6 点）周期放宽到 15 分钟
- **账号数与间隔要配套**：20 个账号 × 8s ≈ 160s，再加上新视频详情请求，若一轮跑不满 5 分钟周期，请调大 `intervalMinutes`（或试跑期调小 `minGapSeconds`），避免请求持续积压
- **机房 IP 必须配住宅代理**（§3.5）：`DTK_PROXY_URL` 经 DTK `?proxy=` 换上游出口；不配代理直接跑 20+ 账号，大概率触发风控
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
| 类型检查 `tsc --noEmit` / 77 个测试 / 一键 demo | ✅ 0 错误、全通过 |
| Linux 服务器适配：Docker CE + 镜像源 + systemd + 住宅代理 + 显式时区 | ✅ 已实现（脚本与模板已用模拟数据验证，未在真实服务器跑过） |
| review 第二批：补传复用本地文件 / 临时文件清理 / sha256 校验 / 上传幂等 / MP4+JSON 配对 | ✅ 已修复并补 7 个回归测试 |
| review 第三批 🟡：限速器竞态 + 详情请求限速 / 账号目录撞车 / 告警收敛粒度 | ✅ 已修复并补 9 个回归测试 |
| 借鉴同行：`doctor` 自检（配置/上游分流，退出码 0\|2\|3）、`add-account` 粘链接录账号 | ✅ 已实现并补 25 个回归测试 |
| `run_log` 自动清理 / 独立日志文件轮转 | ⚠️ 未做（生产走 journald 自带轮转，DB 保留窗口待配） |
| 切 TikHub 备用通道 | ⚠️ 仅占位（`src/channel/tikhub.ts`），需要时补两个方法 |
| 真实 DTK 容器联调 | ⚠️ **未做**：开发机没有 Docker，接口路径虽已按 v5.1.7 源码确认，仍需在服务器上 `inspect-openapi` 复核 |
| 真实账号 / OSS 凭据 / 住宅代理地址 | ⚠️ 未提供，代码用 mock 与 local sink 保证可验证 |
| 云端回调通知（二期） | ⚠️ 未做，一期用 ListObjects 即可 |

**上线顺序（Linux 服务器）**：`setup-runtime.sh` → clone 官方源码 → `dtk:up` + `dtk:bootstrap` → 填 `DTK_PROXY_URL` 并重跑 bootstrap 开启 `?proxy=` → 2 个账号 + 30 分钟周期试跑 3 天（对照 App 查漏检、看 4xx 比例）→ 切 `SINK=oss` → 扩到 20+ 账号 + 5 分钟周期 → `install-service.sh` 装 systemd。
