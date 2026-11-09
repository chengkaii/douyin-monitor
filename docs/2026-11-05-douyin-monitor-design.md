# 抖音账号监测与视频采集系统 — 技术实现文档

- **日期**：2026-11-05（2026-11-06 修订：对齐 DTK v5）
- **状态**：设计定稿；代码骨架已落地（见 `douyin-monitor/`），真实容器联调待 M1
- **负责人**：凯哥
- **关联项目**：下游转录/翻译再创作管线（云端）、ffyc-creator OSS
- **实现代码**：[`README.md`](../README.md)

> 实现状态速览：`tsc --noEmit` 0 错误、32 个测试全通过、`npm run demo` 端到端通过（同步 + v5 异步两种链路）。已实现 M1–M4 的调度器侧：Channel 抽象、SQLite 增量、错峰/退避、下载校验、manifest、local/oss sink、告警、CLI 与 launchd 模板。**2026-11-06 code review 第一批已修**：① 启动时把遗留 `downloading` 恢复为 `pending`；② 作品列表结构不符（错误体/字段改名/ID 解析不出）抛 `ChannelError` 进入退避告警，不再假成功；③ `failed` 在 `serve` 中按 `retry.everyRounds` 自动重投，用 `attempts` 列封顶（`retry.maxAttempts`）。**未完成**：真实 DTK 容器联调（本机无 Docker）、`DTK_POSTS_PATH` 等路径需 `npm run inspect-openapi` 实测填写、真实账号与 OSS 凭据未提供、云端回调（二期）、review 第二批 🟡 项。

---

## 1. 需求快照

| 决策点  | 结论                                                       |
| ---- | -------------------------------------------------------- |
| 用途   | 视频本体 + 文案下载后交给云端转录/翻译程序再创作                               |
| 监测规模 | 20+ 固定账号，分钟级发现新作品                                        |
| 获取通道 | 自建爬虫（免费），Docker 自部署 Evil0ctal/Douyin_TikTok_Download_API |
| 部署位置 | 本地 Mac 常驻采集，云端处理                                         |
| 数据交接 | 上传 ffyc-creator OSS，云端程序消费                               |
| 工程形态 | 开源 API 容器 + 自研 Node.js 调度器                               |

## 2. 总体架构

```
┌────────────────────── Mac (本地) ──────────────────────┐
│                                                         │
│  ┌─────────────────────┐    ┌────────────────────────┐ │
│  │ douyin-api           │◄──│  monitor 调度器          │ │
│  │ (Docker 容器)        │HTTP│  (Node.js + TypeScript) │ │
│  │ Evil0ctal            │───►│                        │ │
│  │ Douyin_TikTok_       │    │  · 账号配置 + 轮询      │ │
│  │ Download_API         │    │  · 增量比对 + 去重      │ │
│  │ 签名/解析/风控隔离层 │    │  · 视频下载             │ │
│  └─────────────────────┘    │  · 文案提取 + JSON      │ │
│                             │  · 上传 OSS             │ │
│                             │  · SQLite 状态库         │ │
│                             └───────────┬────────────┘ │
└─────────────────────────────────────────┼──────────────┘
                                           │
                              ffyc-creator OSS（已有）
                                           │
                                ┌──────────▼──────────┐
                                │ 云端转录/翻译程序     │
                                │ （消费 OSS 新文件）   │
                                └─────────────────────┘
```

**核心设计原则**：

1. **风险隔离**：签名逆向（a_bogus 等）全部封在开源容器内。容器坏了只需 `docker compose ... pull && up -d` 跟社区版本更新，调度器代码零改动。
2. **通道抽象**：调度器通过 `Channel` 接口调用容器 HTTP API。将来若被风控需要切换 TikHub 等付费 API，只替换 `Channel` 实现。
3. **纯 IO 型调度器**：Node.js + TypeScript，逻辑全部是"轮询 → 比对 → 下载 → 上传"，无重计算。
4. **状态本地化**：SQLite 单文件库存增量状态与任务队列，零运维、易备份（直接拷文件）。

## 3. 组件设计

### 3.1 douyin-api 容器（不自研，自部署）

- 项目：`github.com/Evil0ctal/Douyin_TikTok_Download_API`（v5，2026-10 最新 v5.1.7，约 2 万 star，Apache-2.0）
- 部署：`docker compose -p dtk -f docker/compose.yml up -d`，v5 默认绑定 `http://127.0.0.1:8000`
- v5 组件：API（FastAPI）+ Worker（异步任务）+ PostgreSQL/TimescaleDB + Redis + 可选 Go 下载 sidecar / 浏览器身份容器 / 离线转写容器；首次启动 `logs api` 拿 setup token 在 console 创建管理员
- 鉴权：console 生成 API key，请求头 `Authorization: Bearer dtk_XXX`，scopes/roles 控制权限
- REST 基路径 `/api/v1/...`（128 个 operation）；**接口清单不写死在 README，由实例自身 `/openapi.json`、`/swagger`、`/docs` 生成**——M1 阶段必须实测确定"拉取用户作品列表"的路径与参数名（能力表确认 `An author's posts` ✅，MCP 工具为 `list_user_posts`）
- **异步优先**：数据接口默认返回 `202 + task_id`，追加 `?wait=N` 可同步等待；任务结果端点从 OpenAPI 查。`Channel.evil0ctal.ts` 需封装"提交任务 → 取结果"，或直接用 `?wait=` 同步模式
- 内置能力：a_bogus / X-Bogus / X-Gnarly 等签名纯 Python 生成 + 浏览器兜底；自愈身份池（自动生成 guest 身份）、令牌桶限速、端点熔断、健康分层——平台侧风控由项目承担

> ⚠️ 初版写的 `GET /api/douyin/web/fetch_user_post_videos?sec_user_id=...&max_cursor=0&count=20` 是 **v4 风格接口**，v5 已整体重写，路径/参数名以实例 `/openapi.json` 为准。`Channel` 抽象层的价值正在于此：接口形态变化只改一个文件。

- 升级策略：签名失效表现为接口 4xx/空数据。处理流程：`docker compose -p dtk -f docker/compose.yml pull && up -d` 跟社区版本更新，调度器代码零改动。

### 3.2 monitor 调度器（自研，核心工作量）

目录结构：

```
douyin-monitor/
├── docker-compose.yml          # 只管 douyin-api 容器
├── src/
│   ├── index.ts                # 入口：启动轮询 + 队列消费
│   ├── config.ts               # 配置加载（accounts.yaml + env）
│   ├── channel/
│   │   ├── types.ts            # Channel 接口定义
│   │   ├── evil0ctal.ts        # 现通道实现（调容器）
│   │   └── tikhub.ts           # 预留：付费 API 备用通道
│   ├── scheduler.ts            # 轮询调度（错峰 + 退避）
│   ├── store.ts                # SQLite 封装（better-sqlite3）
│   ├── downloader.ts           # 视频下载（并发限制 + 重试）
│   ├── metadata.ts             # 文案/元数据归一化 → JSON
│   ├── oss.ts                  # OSS 上传（复用 ali-oss SDK）
│   └── notify.ts               # 通知（失败告警到微信/邮件）
├── accounts.yaml               # 监测账号清单
└── data/                       # SQLite + 临时下载目录
```

**Channel 接口**（切换通道的唯一边界）：

```typescript
interface Channel {
  // 拉取账号最近作品列表（首页即可，增量场景无需深分页）
  listUserVideos(secUserId: string, cursor?: number): Promise<{
    videos: RawVideo[];
    nextCursor: number;
    hasMore: boolean;
  }>;
  // 解析单视频：无水印播放地址 + 完整文案 + 元数据
  resolveVideo(videoUrl: string): Promise<RawVideoDetail>;
}
```

**accounts.yaml 格式**：

```yaml
accounts:
  - name: "账号A"
    sec_user_id: "MS4wLjABAAAA..."   # 从账号主页分享链接解析获得
    enabled: true
polling:
  interval_minutes: 5        # 每账号轮询周期
  jitter_seconds: 120        # 错峰随机抖动，避免整齐划一的请求模式
download:
  concurrency: 2             # 同时下载视频数
  max_retries: 3
oss:
  bucket: "ffyc-creator"
  prefix: "douyin-monitor/"  # 上传根前缀
```

### 3.3 SQLite 数据模型

```sql
-- 已见视频（增量判断的核心表）
CREATE TABLE videos (
  video_id     TEXT PRIMARY KEY,     -- 抖音 aweme_id
  sec_user_id  TEXT NOT NULL,
  desc         TEXT,                 -- 文案原文
  create_time  INTEGER,              -- 视频发布时间戳（秒）
  status       TEXT NOT NULL DEFAULT 'pending',
    -- pending → downloading → downloaded → uploaded / failed
  local_path   TEXT,
  oss_key      TEXT,
  discovered_at INTEGER NOT NULL,
  uploaded_at  INTEGER
);

-- 轮询状态（每账号一行）
CREATE TABLE poll_state (
  sec_user_id  TEXT PRIMARY KEY,
  last_poll_at INTEGER NOT NULL,
  next_poll_at INTEGER NOT NULL,
  fail_streak  INTEGER NOT NULL DEFAULT 0,  -- 连续失败次数，驱动退避
  last_ok_at   INTEGER
);

-- 运行日志（排查用）
CREATE TABLE run_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  level TEXT, scope TEXT, message TEXT
);
```

**去重主键 = `video_id`（aweme_id）**。账号删视频重发、跨账号转发均按新 video_id 处理，天然区分。

## 4. 数据流（核心时序）

```
每账号独立定时器（interval + jitter 错峰）
  │
  ▼
1. listUserVideos(sec_user_id, 首页)
  │   Channel 内部提交 v5 异步任务（202 + task_id）→ 取结果；
  │   同步模式可用 ?wait= 简化实现，具体路径/参数以实例 /openapi.json 为准
  ▼
2. 与 videos 表比对 → 过滤已存在的 video_id → 得到新视频集合
  │   新视频 INSERT status='pending'
  ▼
3. 入队下载队列（并发=2）
  │
  ▼
4. 逐条 resolveVideo() 拿无水印播放地址 + 文案
  │   → 流式下载到 data/tmp/{video_id}.mp4
  │   → 校验：Content-Type=video/* 且 大小 > 1MB，否则按失败重试
  ▼
5. 生成 manifest JSON（见 §5）与视频同目录
  │
  ▼
6. 上传 OSS：
  │   douyin-monitor/{sec_user_id短}/{yyyyMM}/{video_id}.mp4
  │   douyin-monitor/{sec_user_id短}/{yyyyMM}/{video_id}.json
  │   成功 → status='uploaded'，删除本地临时文件
  ▼
7. 云端程序按约定消费 OSS 增量（列表 or 事件，见 §5.3）
```

**只拉首页的依据**：轮询周期 5 分钟，正常更新频率下首页 20 条足够覆盖增量。若单次发现 >15 条新视频（补历史或账号高频），才继续用 `nextCursor` 深翻页，翻页同样走队列限速。

## 5. 交付契约（对云端程序）

### 5.1 OSS 目录结构

```
douyin-monitor/
  └── {secUserId前8位}/
      └── 202611/
          ├── 7451234567890123456.mp4     # 无水印视频本体
          └── 7451234567890123456.json    # 该视频的 manifest
```

### 5.2 manifest JSON Schema

```json
{
  "videoId": "7451234567890123456",
  "secUserId": "MS4wLjABAAAA...",
  "author": { "nickname": "账号A", "signature": "账号简介" },
  "desc": "视频文案原文，含话题标签",
  "createTime": 1762400000,
  "stats": { "digg": 12345, "comment": 234, "share": 56 },
  "videoUrlOss": "https://ffyc-creator.oss-cn-beijing.aliyuncs.com/douyin-monitor/xxxx/202611/7451234567890123456.mp4",
  "discoveredAt": 1762400500,
  "uploadedAt": 1762400600
}
```

> `stats` 为列表接口顺带返回的快照数据，字段名以容器实际返回为准，实施时对齐。

### 5.3 消费触发方式（分期实施）

| 阶段     | 方式                                          | 说明                |
| ------ | ------------------------------------------- | ----------------- |
| 一期     | 云端程序定时 `ListObjects` 扫 `douyin-monitor/` 前缀 | 零耦合，最简单           |
| 二期（可选） | 上传成功后调云端回调接口 / 发内部消息                        | 实时性更好，待云端程序具备入口后接 |

> 备注：v5 自带离线转写 sidecar（FunASR ONNX，默认关闭，`POST /api/v1/transcriptions` / MCP `transcribe_video`）。若将来云端管线只做翻译，可评估把转写挪到本地做、字幕文本随 manifest 一起上传——但一期不引入，保持 YAGNI。

## 6. 错误处理与风控策略

| 场景             | 检测方式                            | 处理                                                   |
| -------------- | ------------------------------- | ---------------------------------------------------- |
| 容器签名失效（社区接口变更） | 接口连续 4xx / 任务结果为空     | 调度器标记通道 unhealthy，暂停轮询 + 告警；`docker compose ... pull && up -d` 升级后恢复 |
| 单账号风控（滑块/空数据）  | 该账号 `fail_streak` 累计            | 指数退避：下次轮询时间 = now + min(间隔 × 2^n, 24h)；连续 24h 失败告警   |
| 视频下载中断/损坏      | 大小校验、Content-Type 校验、ffprobe 可选 | 重试 3 次（间隔 30s/2m/10m），仍失败置 `failed` 并告警，不阻塞队列        |
| OSS 上传失败       | SDK 抛错                          | 重试 3 次；本地文件保留不删，下次启动扫 `downloaded` 状态补传              |
| Mac 重启/进程崩溃    | —                               | launchd `KeepAlive` 自动拉起；所有任务状态落 SQLite，重启后从断点恢复     |
| 视频发布后列表延迟可见    | 常见现象                            | 无需处理，下次轮询自然补上；5 分钟周期可接受                              |

**风控减压设计**：

- 20+ 账号统一周期但请求间隔 ≥ 8s（单轮询周期内串行+错峰 jitter），折合单容器 QPS < 0.15；
- 住宅 IP（Mac 本机出口）天然比机房 IP 风险低；
- 只拉列表首页，不做深翻页扫库；
- 夜间（0:00–6:00）轮询周期放宽到 15 分钟，进一步降低行为规律性；
- v5 自带自愈身份池、令牌桶、端点熔断，我们这层只做"账号级退避 + 全局错峰"，不重复造限速轮子。

## 7. 部署与运维

### 7.1 常驻方式（macOS）

`~/Library/LaunchAgents/com.starpp.douyin-monitor.plist`：

- `KeepAlive: true` — 崩溃自动重启
- `RunAtLoad: true` — 开机自启
- 日志重定向到 `data/logs/`，按天滚动（rotating file stream）

容器栈由 `docker compose -p dtk -f docker/compose.yml up -d` 启动（api + worker + postgres + redis），Docker Desktop 设置为开机启动。首次启动用 `logs api` 中的 setup token 建管理员，并在 console 生成带 scopes 的 API key 写入调度器 `.env`。

**关于"要不要一直开着浏览器"**：不需要。采集链路是纯后台 HTTP 请求（v5 用 `wreq` 模拟浏览器 TLS 指纹 + 纯 Python 生成签名），不是 Selenium 式挂着一个抖音网页。三种"浏览器"概念要分清：

| 形态 | 是否常驻 | 作用 |
| --- | --- | --- |
| 屏幕上的 Chrome/Safari | ❌ 不需要 | 仅两类一次性操作：首次打开 `127.0.0.1:8000` console 建管理员/生成 API key；导入自有登录 Cookie |
| Docker 内 `--profile browser` 无头容器 | ✅ 后台常驻（无界面） | CloakBrowser / browser-rpc，身份池可用身份不足时自动铸造游客身份、签名兜底；只被 HTTP 按需调用，不占屏幕、不需人工操作 |
| 真机登录态 | 视选择 | 只有选择"不启 browser profile + 手动导入 Cookie"时才需要定期维护 |

**真正需要一直运行的**：Docker Desktop（后台）、Node 调度器（launchd 拉起）、以及 Mac 保持不休眠（`caffeinate` 或系统设置「防止自动睡眠」）。合盖休眠会中断采集，这比"开不开浏览器"更值得关注。

推荐 `--profile browser`：省掉 Cookie 定期维护，代价是多一个 headless Chromium 容器（额外几百 MB 内存）。20+ 账号分钟级的场景，用手动 Cookie 保活得不偿失。

### 7.2 告警通道（notify.ts）

- 最小实现：失败事件写入 `run_log` + 发送 Server酱/企业微信机器人 webhook（文本消息即可）
- 告警收敛：同类错误 30 分钟内只报一次，附 `fail_streak` 计数

### 7.3 日常操作

| 操作    | 命令                                            |
| ----- | --------------------------------------------- |
| 加/停账号 | 编辑 `accounts.yaml`（enabled 字段），热加载或重启         |
| 看状态   | `npm run status` — 各账号最近轮询时间、队列深度、今日新增数       |
| 补传失败  | `npm run retry-failed`                        |
| 升级容器  | `docker compose -p dtk -f docker/compose.yml pull && up -d` |

## 8. 测试方案

1. **单元**：去重比对逻辑（新/旧/边界 video_id）、退避时间计算、manifest 生成 schema 校验
2. **通道集成**：拿 1–2 个真实账号手动调容器 API，固化一份 mock 响应 fixture，后续单测离线跑
3. **端到端演练**：先用 2 个账号 + 30 分钟周期试运行 3 天，观察：漏检率（对照抖音 App 手查）、失败率、风控迹象
4. **混沌项**：手动 kill 进程 / 断网 10 分钟，验证恢复与补传
5. **扩量**：试运行通过后切到 20+ 账号 + 5 分钟周期，同时观察容器 QPS

## 9. 实施里程碑

| 阶段 | 内容                           | 验收标准                          |
| -- | ---------------------------- | ----------------------------- |
| M1 | 容器跑通 + 从实例 `/openapi.json` 确认用户作品列表/单视频解析的真实路径与参数 + Channel 封装（含 202/task_id 或 `?wait=` 处理） | 能打印某账号最新 20 条作品的 video_id 与文案 |
| M2 | SQLite 增量 + 轮询调度 + 下载落盘      | 单账号自动发现新视频并下载成功               |
| M3 | manifest + OSS 上传 + 状态闭环     | OSS 出现 mp4+json 配对，本地临时文件清理   |
| M4 | 告警 + launchd 常驻 + status 命令  | 重启自愈、失败可观测                    |
| M5 | 2 账号试运行 3 天 → 扩到全量           | 漏检率 ≈ 0、无风控告警                 |

## 10. 风险与开放问题

| 风险                      | 等级   | 缓解                                               |
| ----------------------- | ---- | ------------------------------------------------ |
| 开源项目签名更新滞后于抖音风控（数天级不可用） | 🟡 中 | 通道抽象已预留 TikHub 切换位；付费按量计费，应急成本低                  |
| 游客身份自动生成（guest identity） | 🟡 中 | v5 默认不启浏览器容器，抖音/TikTok 身份只能"导入"；要么加 `--profile browser` 让身份池自动铸造，要么导入自有登录 Cookie（有账号风险），M1 实测确认 |
| v5 接口形态与预期不符（异步/路径/参数） | 🟡 中 | 以实例 `/openapi.json` 为唯一事实来源，M1 先固化 fixture 再写 Channel；不在 README 里猜路径 |
| 抖音接口字段变更导致 manifest 断裂  | 🟢 低 | 字段归一化集中在 metadata.ts 一处，变更只改一个文件                 |
| 合规                      | 🟡 中 | 下载内容用于内部再创作处理；控制请求频率、不二次分发原始视频；账号如有维权声明则从清单移除    |
| Mac 合盖休眠导致采集停止          | 🟡 中 | `caffeinate` 防睡眠 或 系统设置「防止自动睡眠」；笔记本形态长期可迁云服务器+代理 |

---

## 附录 A：sec_user_id 获取方法

1. 抖音 App → 目标账号主页 → 右上角分享 → 复制链接
2. 链接形如 `https://v.douyin.com/xxxxx/`，浏览器打开重定向到 `.../user/MS4wLjABAAAA...`
3. 路径中 `MS4wLjABAAAA...` 即 `sec_user_id`，填入 `accounts.yaml`

## 附录 B：技术选型清单

| 依赖                                   | 用途                              |
| ------------------------------------ | ------------------------------- |
| Node.js 20+ / TypeScript             | 调度器运行时                          |
| better-sqlite3                       | SQLite（同步 API，适合本场景，无连接池心智负担）   |
| ali-oss                              | OSS 上传（与现有 ffyc-creator 同套凭据体系） |
| yaml                                 | accounts.yaml 解析                |
| p-limit                              | 下载并发控制                          |
| Evil0ctal/Douyin_TikTok_Download_API v5 | 抖音签名与解析（Docker Compose：api/worker/postgres/redis，端口 8000） |
