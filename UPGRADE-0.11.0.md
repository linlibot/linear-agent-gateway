# 0.11.0：API 兼容性升级与验证

本版将提供的 0.10.0 方案合入现有项目，并保留凭证自动同步改动，统一版本为 0.11.0。开发和验证在本地进行，没有登录、停止或更新 AWS 服务。

## 已实现的行为

- 标准 Chat Completions 函数工具：`tools`、`tool_choice` 的 auto/none/required/指定函数/允许列表、多调用、`parallel_tool_calls`、`assistant.tool_calls`、`role: tool`、调用 ID 关联、`finish_reason: tool_calls`。
- 实验性结构化适配：每回合随机 nonce，严格 JSON、工具名和支持的 Schema 约束校验；可在原对话修正一次，无效调用不交付客户端。网关不执行文件或 Shell 工具，客户端负责审批、执行并返回真实结果。
- 工具循环按客户端 Key 隔离，匹配完整消息历史的哈希后固定到原账号和 Linear 对话。续接只发送新增结果；无法匹配时可重放完整历史。繁忙会话返回 409。
- 相同在途请求阻止重复派发。工具结果请求成功后短时缓存同一回复和调用 ID；派发记录持久化，已发送但结果不确定、重启或缓存过期的相同请求不会盲目重放。记录有效期默认 24 小时。客户端仍需按调用 ID 防止工具重复执行，这不是无限期的 exactly-once 保证。
- 默认全局并发 4、单账号并发 1、执行与排队合计上限 8；保留轮转、冷却、明确发送前认证/限流失败的换号策略。超时包含排队时间。
- SSE 文本和标准工具 delta；只转发当前 turn 的 answer 阶段，不输出 reasoning、commentary、未知阶段或内部工具参数。上游改写已发送前缀时明确失败，不拼接重复文本。
- Chrome/Edge 扩展配对后自动检查已登录标签页并同步更新 Cookie。服务端核验账号身份后原子保存；配对可撤销，不需要向扩展提供管理员密码。浏览器及 Linear 登录需保持可用；不是 OAuth 刷新令牌，也不保证会话永久有效。

Schema 是明确支持的子集；未知约束、远程引用、`format`、不支持的正则返回 400。`strict` 表示网关校验，不是上游约束解码。图片、音频、Responses API、Anthropic Messages、token 用量及精确采样控制尚未支持。被兼容接收的采样/长度字段会列入 `ignored_parameters`；设置 `LINEAR_STRICT_PARAMETERS=1` 可改为拒绝。

## 2026-10-28 的证据

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| 自动化测试 | 154 项通过 | 模拟上游，不消耗真实额度；含既有管理员、Key、账号持久化及同步测试 |
| 真实输入字段校验 | 12 个候选工具/流式字段被明确拒绝 | `tools`、`clientTools`、`toolDefinitions`、`functions`、`toolChoice`、`toolResults`、`toolResult`、`functionResults`、`systemPrompt`、`instructions`、`mcpServers`、`stream` |
| 真实工具结果 mutation 探测 | 6 个候选字段均不存在 | 不代表穷举所有内部接口；校验探测不执行 mutation |
| 详细 GraphQL 读取 | 接口接受 | `body`、`bodyData`、`endedAt`、内置工具名称 |
| 真实本地文件闭环 | 通过，约 25 秒、5 个 Agent 回合 | 默认模型入口；客户端执行 write/read/replace/read，`index.html` 最终标题为 Final Title；后四轮为 native 续接 |
| 真实 SSE | 200、stop、DONE 完整 | 工具调用以标准 delta 交付，参数在整个回合校验后发送 |
| 真实正文增量 | 本次没有观察到 | 短回复及 11,957 字符 HTML 均完成后才有正文；长回复约 56 秒，44 次 active 轮询无正文，实际仍为缓冲 SSE |
| WebSocket / HTTP 订阅 | 未实现 | HTTP 订阅探测返回 INTERNAL_SERVER_ERROR；WebSocket 未验证 |
| Cline/Roo Code 桌面扩展 | 尚未 UI 联调 | 标准请求形状、SSE 累积及本地模拟编程客户端通过；不能据此保证所有版本和复杂任务 |
| 扩展自动同步 | HTTP 端到端模拟通过 | 未在真实 Chrome/Edge 扩展中长期运行验证 |

本机脱敏证据保存在被 Git 忽略的 `outputs/upstream-tool-probe.json`、`outputs/live-api-coding-check.json`、`outputs/live-api-current-check.json`、`outputs/live-api-stream-check.json`、`outputs/live-api-stream-html-check.json`。真实文件位于隔离的 `.private/current-api-workspace-final/index.html`；生成内容没有执行。本版模型名及 reasoning 字段仍只代表请求参数，不验证实际模型身份或算力预算。

**是否实现 Tool Calling：** 客户端 API 层已实现并通过真实工具闭环；上游层是实验性结构化输出转换，没有原生自定义函数接口的证据。

**能否改本地文件：** 本地测试客户端实际改写并校验通过；Cline/Roo Code 需按下节联调，操作仍由其本地审批机制控制。

**是否真正实时流式：** 增量转发实现通过模拟测试，但本次真实上游只提供最终正文，不能宣称已实现端到端实时生成。

## 文件清单

新增运行模块：`chat-completions.mjs`（工具与普通聊天编排）、`tool-protocol.mjs`（结构化协议）、`json-schema.mjs`（约束校验）、`messages.mjs`（消息及历史哈希）、`prompt-builder.mjs` / `rich-doc.mjs`（逐字消息文档）、`tool-sessions.mjs`（会话、缓存及派发记录）、`scheduler.mjs`（并发）、`progressive.mjs` / `sse.mjs`（流式）、`errors.mjs`、`credential-sync.mjs`、`browser-extension/sync.mjs`。

修改运行入口及界面：`gateway.mjs`、`upstream.mjs`、`server.mjs`、`config.mjs`、`accounts.mjs`、`accounts-page.mjs`、`capture-extension.mjs`、`welcome.mjs`、扩展的 `background.mjs` / `manifest.json` / `popup.html` / `popup.css` / `popup.mjs`。

配置及文档：`package.json`、`.env.example`、`compose.yaml`、`.dockerignore`、`README.md`、`browser-extension/README.txt`、本文件。既有 Dockerfile 和数据卷结构保留。

新增脚本：`scripts/probe-upstream-tools.mjs`、`scripts/local-coding-client.mjs`。新增测试：`test/tool-protocol.test.mjs`、`test/tool-calling.test.mjs`、`test/tool-sessions.test.mjs`、`test/streaming.test.mjs`、`test/concurrency.test.mjs`、`test/e2e-coding-client.test.mjs`、`test/credential-sync.test.mjs`、`test/protocol-safety.test.mjs` 及辅助 `test/mock-linear.mjs`、`test/openai-client.mjs`。更新 `scripts/stop-local.ps1`，在校验 PID 归属后使用 Force 停止以兼容 Windows 进程。调整既有 `test/gateway.test.mjs`、`test/config.test.mjs`、`test/routing.test.mjs`、`test/capture-extension.test.mjs`。

## Cline / Roo Code 验证

在扩展中选择 **OpenAI Compatible**，Base URL 填 `https://你的网关域名/v1`，使用 `/keys` 创建的调用 Key，Model ID 先选 `linear-agent`。关闭图片和 Computer Use；保留本地工具审批。配置项参见 [Cline 官方文档](https://docs.cline.bot/provider-config/openai-compatible) 和 [Roo Code 提供商文档](https://github.com/RooCodeInc/Roo-Code/blob/main/apps/docs/docs/providers/openai-compatible.md)。

打开一个空测试文件夹，发送：

> 在当前目录创建 index.html，标题为 Draft。读取它，把标题改为 Final Title，再读取确认，最后总结改动。必须通过本地工具操作文件。

逐项批准工具请求，核对本地文件实际存在和标题正确。再验证创建 JS / Python、读取现有文件、应用补丁、执行测试及失败后的修复。若只有文本声称文件已创建而没有本地工具请求，不能当作成功。

不用桌面扩展也可先运行示例客户端（Node 22+）：

```powershell
$env:LINEAR_GATEWAY_KEY = Read-Host '调用 Key'
node --preserve-symlinks --preserve-symlinks-main scripts/local-coding-client.mjs --base https://你的网关域名/v1 --model linear-agent --stream
Remove-Item Env:LINEAR_GATEWAY_KEY
```

默认使用独立临时目录并保留供检查，每个本地工具显示参数、输入 `y` 才执行。JS 命令有本机进程权限，示例路径检查不是操作系统沙箱。结果中的 `index_has_final_title: true` 是文件内容校验。设置 `NODE_EXTRA_CA_CERTS` 可添加自己的受信任 CA，需在客户端进程启动前设置。

## AWS Docker 升级与回滚（由部署者执行）

先确认当前目录没有未提交的部署改动，保留 `.env`、Compose override 和 Caddy 配置。本节没有自动执行。不要运行 `docker compose down -v` 或删除卷，也不要把备份提交 Git。

```sh
cd linear-agent-gateway
git rev-parse HEAD > ../gateway-previous-commit.txt
docker image tag linear-agent-gateway:local linear-agent-gateway:rollback
git pull --ff-only
docker compose config --quiet
docker compose build --pull
# 构建阶段会运行完整自动化测试；成功后再短暂停服取得一致备份
docker compose stop gateway
docker compose cp gateway:/app/.local-runtime ./linear-data-backup
docker compose up -d --wait
curl -fsS http://127.0.0.1:8089/health
docker compose logs --tail=50 gateway
```

备份目录应使用未占用的位置并限制读取权限。启动后先核对 `/login`、账号列表、原有 Key、`GET /v1/models`，再用空目录验证工具循环。首次初始化用户仍需自行在 `/setup` 设置管理员密码。

Caddy 一般可保持原配置。官方说明 `text/event-stream` 会立即 flush；不要盲目加 `flush_interval -1`，其文档指出负值会影响客户端断开后的上游取消行为。[Caddy 流式说明](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#streaming)。如有中间代理，请实际检查缓冲和中断行为；本次没有验证 AWS 上的整条链路。

如需暂缓新功能，在 `.env` 中设置 `LINEAR_CLIENT_TOOLS=off`、`LINEAR_STREAM_MODE=buffered`、`LINEAR_MAX_CONCURRENCY=1`；要沿用旧版严格参数拒绝可设 `LINEAR_STRICT_PARAMETERS=1`。调整后重新创建服务。

回滚代码及镜像，保留卷：

```sh
docker compose stop gateway
git switch --detach "$(cat ../gateway-previous-commit.txt)"
docker image tag linear-agent-gateway:rollback linear-agent-gateway:local
docker compose up -d --no-build --wait
curl -fsS http://127.0.0.1:8089/health
```

旧版忽略新增 `tool-sessions.json`、`credential-sync.json`，账号、模型报告、管理员及 Key 存储继续保留。恢复升级版本时继续使用同一卷。只有运行数据确实损坏时才停服恢复备份，不要把新备份直接覆盖到运行中的服务。
