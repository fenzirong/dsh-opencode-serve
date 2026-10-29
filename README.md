# dsh-opencode-serve

把**本机官方 opencode 客户端**（`opencode-cli serve`）注册成 DeepSeek Harness（DSH）的原生 LLM provider。
模型请求由 opencode 自己的进程发出，因此在 DSH 里可以直接选用 OpenCode 的免费模型。

---

## 为什么需要这个插件

DSH 直连 `https://opencode.ai/inference/v1` 时，即使把请求伪装成官方客户端也会被拒。

2026-10-28 实测（同一 IP、同一分钟、同一模型 `deepseek-v4.1-flash-free`）：

| 伪装身份 | 结果 |
| --- | --- |
| `opencode/1.18.31` + `x-opencode-client: cli` | `429 FreeUsageLimitError` |
| `opencode/1.19.4` + `cli` | `429`，`retry-after` 与上面同值 |
| `opencode/2.2.0` + `cli` | `429` |
| `opencode/2.2.0` + `x-opencode-client: desktop` | `429` |
| 裸 `node-fetch`，无 UA | `429` |

而用官方 **2.2.0 CLI 本体**（完全未登录、`XDG_DATA_HOME` 指向空目录）调用同一模型，**同一分钟连续两次成功**。

结论：上游识别的不是 User-Agent，而是**运行时连接指纹**（opencode 是 Bun 编译的，TLS/HTTP2 特征与 Node/undici 不同）。
因此唯一可靠的接入方式是：**让请求从 opencode 自己的进程里发出去**，DSH 只做协议翻译。

## 工作原理

```
DSH 会话
  │  llm adapter（本插件）
  ▼
私有 opencode serve 进程（本插件 spawn，隔离 XDG 根）
  │  POST /api/session             → 建立 opencode 会话（agent + model）
  │  POST /api/session/{id}/prompt → 发送本轮用户文本（异步）
  │  GET  /api/event (SSE)         → 订阅事件，按 sessionID 分发
  ▼
https://opencode.ai  （请求由 opencode 运行时发出）
```

事件到 DSH 块的映射：

| opencode 事件 | DSH 块 |
| --- | --- |
| `session.text.started` | `block-start` (`blockType: "text"`) |
| `session.text.delta` `{delta}` | `text-delta` |
| `session.text.ended` `{text}` | `block-end` |
| `session.step.ended` `{finish, tokens}` | 累加用量 / 决定 `finish` 原因 |
| `session.execution.succeeded` \| `.failed` | 结束本轮 / 错误收尾 |
| `POST /api/session/{id}/interrupt` | 响应 DSH 的中断信号 |

## 上下文如何保留（换模型 / 重启都不丢）

同一 DSH 会话始终复用同一个 opencode `ses_`，因此多轮对话由 opencode 会话自身维护，不需要每轮重放历史。
映射关系落盘在 `<dataRoot>/sessions.json`：

```json
{ "switch-1": { "sid": "ses_e7a8d146affe…", "model": "glm-5.3-flash-free", "updatedAt": 1793240263576 } }
```

保活与兜底策略：

| 情况 | 行为 |
| --- | --- |
| 同会话、同模型，进程未重启 | 直接复用 `ses_`，只发送本轮消息（最省 token） |
| **中途换了模型** | 旧会话绑定旧模型，必须新建 `ses_`；此时把 DSH 侧历史压成前导文本（`[系统指令]` + `[此前对话]` + `[当前消息]`）随首轮一起发送，**换模型不丢上下文** |
| 进程重启（映射从 `sessions.json` 复原） | 复用原 `ses_`，只发送本轮消息；上下文继续 |
| opencode 侧会话被清理（`GET /api/session/{id}` 返回 404） | 丢弃映射、新建会话，并同样用历史前导兜底 |
| 映射文件缺失/损坏（首次安装） | 新建会话；若 DSH 已带历史，则同样补发前导 |

前导只保留最近 40 条消息、单条截断 2000 字符（系统提示 8000），避免把上下文窗口一次塞满。

实测（T1→T4）：

```
T1 首轮       deepseek-v4.1-flash-free → "记住了"      （暗号：蓝鲸42）
T2 换模型     glm-5.3-flash-free       → "蓝鲸42"      ← 历史前导生效
T3 同模型续聊  glm-5.3-flash-free       → "蓝鲸42"
T4 新进程续聊  glm-5.3-flash-free       → "蓝鲸42"      ← 仅靠 sessions.json + opencode 会话记忆
```

## 安全模型

- serve 进程跑在**隔离的 XDG 根**：`~/.dsh/opencode-serve/{data,config}`，不读写你桌面客户端的会话库。
- 插件在启动时写入一份强制配置，**禁止一切本地工具**：

  ```jsonc
  {
    "permissions": [{ "action": "tool.use", "resource": "*", "effect": "deny" }],
    "agents": { "dsh-chat": { "mode": "primary", "system": "…Never call tools…" } }
  }
  ```

  模型只能产出文本，没有 shell / 文件 / 网络工具。需要动文件时仍由 DSH 自己的工具完成。
- 本地 server 使用随机端口 + 每次启动生成的随机口令（`Authorization: Basic base64("opencode:<password>")`），只监听 `127.0.0.1`。
- 不需要登录，也不读取任何账号凭据；不会把凭据写进日志。

## 安装

### 方式一：从本地目录挂载（开发用）

```sh
dsh plugin --profile desktop add D:/AI/deepseek/dsh-opencode-serve
```

或在 profile 的 `package.json` 里加：

```json
{
  "dependencies": { "@local/dsh-opencode-serve": "link:D:/AI/deepseek/dsh-opencode-serve" },
  "dsh": { "profile": { "bundles": ["@local/dsh-opencode-serve"] } }
}
```

然后建 junction（Windows）：`node_modules/@local/dsh-opencode-serve` → 插件目录。

### 方式二：从打包文件安装

```sh
pnpm pack                                   # 产出 dsh-opencode-serve-<version>.tgz
dsh plugin --profile desktop add ./dsh-opencode-serve-1.0.0.tgz
```

安装后**重启 DSH**，模型选择器里会出现「OpenCode 客户端（后台 serve）」分组。

## 前置条件

- 本机装有 opencode 客户端。优先使用桌面版自带的 CLI：
  `%APPDATA%\ai.opencode.desktop\cli\<版本>-<arch>\opencode-cli.exe`
  找不到时回退到 PATH 上的 `opencode`。
- 出站 HTTPS 可达 `opencode.ai`。

## 配置

`cordis.patch.yml` 里可覆盖（全部有默认值）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `providerId` | `opencode-serve` | DSH 中的 provider 路由名，不能与现有路由重名 |
| `opencodePath` | `''` | 显式指定 opencode 可执行文件；留空自动发现（取 `cli/` 下版本号最大的目录） |
| `workdir` | `''` | opencode 工作目录；留空用 DSH 进程 cwd |
| `dataRoot` | `''` | serve 的隔离 XDG 根；留空 = `~/.dsh/opencode-serve` |
| `agentId` | `dsh-chat` | 会话使用的 agent（插件自动写进隔离配置） |
| `requestTimeoutMs` | `600000` | 单轮等待上限，超时会中断会话并按 `TIMEOUT` 失败 |
| `models` | `[]` | 覆盖模型清单；留空用内置免费模型表 |

内置模型：`deepseek-v4.1-flash-free`、`glm-5.3-flash-free`、`mimo-v2.6-flash-free`、
`nemotron-3.5-lightning-free`、`nemotron-3.5-super-vl-free`、`flint-40b-free`、`big-pickle`、`beam-free`。

> 上游会变动模型清单与地区策略：`beam-free` 对中国大陆出口返回 `403 RegionError`，属预期行为，不要试图绕过。

## 排错

| 现象 | 原因与处理 |
| --- | --- |
| 模型选择器里没有该分组 | 插件未装进 profile 的 `bundles`，或 DSH 未重启 |
| 报 `SERVER_UNAVAILABLE` | `opencode-cli` 找不到/起不来；设 `opencodePath` 指向真实 exe |
| 报 `SESSION_FAILED 400` | 模型 id 不在上游清单里；换内置清单内的模型 |
| 首轮很慢（6–8s） | 冷启动：spawn serve + 建会话；同进程后续轮次为毫秒级 |
| 报 `TIMEOUT` | 单轮超 10 分钟；调大 `requestTimeoutMs` |
| 报 `DUPLICATE_ADAPTER` | `providerId` 与 `llm-pi-ai` 已声明路由重名 |

排查子进程：`Get-CimInstance Win32_Process -Filter "Name='opencode-cli.exe'"`；
serve 自身日志在 `<dataRoot>\data\log`（隔离根内）。

## 回滚

1. 从 profile 的 `dependencies` 与 `dsh.profile.bundles` 移除 `@local/dsh-opencode-serve`；
2. 删除 `node_modules/@local/dsh-opencode-serve` 链接；
3. 可选：删除 `~/.dsh/opencode-serve` 与打包目录。

## 兼容性

- Windows（主力验证平台）。Linux/macOS 理论上可用：把 `opencodePath` 指向 `opencode` 即可，`cli/` 自动发现逻辑仅针对桌面版的 Windows 布局。
- opencode CLI ≥ 2.x 提供 `/api/*` 服务端接口；更老版本（1.x）的接口路径不同，不保证兼容。
