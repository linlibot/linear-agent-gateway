# Linear Agent 本地对话网关

将本人 Linear 账号已经开放的内置 Agent 对话接入本地 Chat Completions 客户端。使用网页实际调用的 `client-api.linear.app/graphql`，发送 `AiConversationSendMessage`，再读取当前 assistant turn 的最终回复。

浏览器页面与 API Base URL 均为 `http://127.0.0.1:8089/v1`。默认模型入口为 `linear-agent`，也可选择已实测的模型请求参数。支持 Node.js 22 或更新版本直接启动，也支持 Docker Compose 部署，无第三方运行依赖。

## 启动与客户端设置

全新安装不含任何 Linear 账号，先启动服务，再通过账户管理页导入凭证；已有的旧会话文件会自动迁入本机多账户存储。在本目录运行：

```powershell
.\scripts\start-local.ps1
```

| 客户端设置 | 值 |
| --- | --- |
| API 类型 | OpenAI Chat Completions |
| Base URL | `http://127.0.0.1:8089/v1` |
| API Key | `.local-runtime/access.json` 中的 `api_key` |
| 模型 | `linear-agent` |

直接在浏览器打开 Base URL 会显示接入说明和对话测试页。测试页提供模型下拉框，需要手动输入本地 API Key；网页不会读取或保存 Key。

截至 2026-10-27，以下模型参数在原有登录账户下均已完成独立发送和回复测试，收到有效回复，已加入该账户的 `/v1/models`。新导入的账户初始仅显示默认入口，需要单独测试候选参数：

| 显示名称 | 请求中的 `model` |
| --- | --- |
| GPT-6.1 Sol | `openai/gpt-6.1-sol` |
| GPT-6 Sol | `openai/gpt-6-sol` |
| GPT-6 Astra | `openai/gpt-6-astra` |
| Claude Opus 5.5 | `anthropic/claude-opus-5-5` |
| Claude Sonnet 5.5 | `anthropic/claude-sonnet-5-5` |
| Claude Haiku 5.5 | `anthropic/claude-haiku-5-5` |
| Kimi K3 | `fireworks/accounts/fireworks/models/kimi-k3` |
| Gemini 3 Flash Preview | `google/gemini-3-flash-preview` |
| Gemini 3.1 Flash Lite | `google/gemini-3.1-flash-lite` |
| Gemini 3.1 Pro Preview | `google/gemini-3.1-pro-preview` |
| Gemini 3.5 Flash | `google/gemini-3.5-flash` |
| Gemini 3.5 Flash Lite | `google/gemini-3.5-flash-lite` |
| Gemini 3.6 Flash | `google/gemini-3.6-flash` |

2026-10-27 刷新上游模型校验枚举，共返回 74 个模型 ID；其中有两个 Kimi、六个 Gemini，没有 Grok/xAI ID。本轮对这些入口仅发送“你好”，使用默认档、全新对话、不带历史或附件。Kimi K3 和上表六个 Gemini 均收到回复；`fireworks/accounts/fireworks/models/kimi-k2p6` 两次发送均被接受，随后以通用上游错误结束，未加入可用目录。Kimi K3 本次耗时约 73.7 秒，候选探测超时已统一放宽到 180 秒。上述新增入口的其他思考档位尚未测试。

运行 `node --preserve-symlinks --preserve-symlinks-main scripts/probe-other-models.mjs` 可刷新枚举并复测 Kimi、Gemini、Grok；`--retry-failed` 保留报告并仅复核最新失败项。结果位于 `outputs/other-model-discovery.json`，包含准确模型 ID、回复、耗时、失败重试记录和当前账户标识，不包含会话凭证。

这个列表是网关按账户保存的成功测试记录，不是 Linear 全部模型目录。2026-10-27 使用不存在的模型名作为负面对照，上游以 `INVALID_INPUT` 拒绝并返回模型枚举，其中包含 13 个 `anthropic/claude-…` ID，包括旧版本、日期别名及 Fable 5、Fable 5.1。Sonnet 5.5、Haiku 5.5 的普通 Agent 短回复均成功；`anthropic/claude-fable-5` 和 `anthropic/claude-fable-5-1` 各两次请求均被接受，但随后以 `Something went wrong. Please try again.` 结束，未加入可用目录。枚举存在、普通聊天回复成功、实际底层模型身份是不同的证据层级。

探测报告位于 `outputs/claude-model-discovery.json`，包含允许的模型 ID、全新对话测试和失败重试记录，不含会话 Cookie。使用 `scripts/probe-claude-models.mjs` 复测本轮 Claude 候选；`--retry-failed` 只复核报告里的失败项。此脚本需要同一账户已有的 `.local-runtime/claude-discovery-validation.json` 负面对照记录，不进行权限受限的 schema introspection，也不会启动 coding session。

这些名称会原样传入上游 `AiConversationSendMessageInput.model`。测试只确认请求被接受并收到回复，尚未核验实际底层模型身份。因此响应中的 `model` 保留为 `linear-agent`，额外用 `requested_model` 标明请求参数，`model_selection_verified` 为 `false`。

首次启动会生成独立的本地 API Key。本地启动默认只监听 `127.0.0.1`；Docker 容器内监听 `0.0.0.0`，Compose 默认仍只将端口映射到宿主机的 `127.0.0.1`。本地 Key 与 Linear 的会话 Cookie 分开存放；日志不输出 Cookie 或 Key。

```powershell
$linearAccess = Get-Content .\.local-runtime\access.json -Raw | ConvertFrom-Json
$linearBody = @{
    model = 'linear-agent'
    messages = @(@{ role = 'user'; content = '你好' })
} | ConvertTo-Json -Depth 10
Invoke-RestMethod -Uri 'http://127.0.0.1:8089/v1/chat/completions' `
    -Method Post -ContentType 'application/json; charset=utf-8' `
    -Headers @{ Authorization = 'Bearer ' + $linearAccess.api_key } `
    -Body ([Text.Encoding]::UTF8.GetBytes($linearBody))
```

停止：`./scripts/stop-local.ps1`。可用环境变量：`LINEAR_HOST`（默认 `127.0.0.1`，须为 IPv4 或 IPv6 地址）、`LINEAR_PORT`（默认 8089）、`LINEAR_SESSION_FILE`（首次迁移使用的旧会话文件绝对路径）、`LINEAR_POLL_MS`（默认 1500，最小 500）、`LINEAR_TIMEOUT_MS`（默认 180000）。

## Docker 部署

0.6.0 起提供 Dockerfile 和 Compose 配置，使用官方 `node:24-alpine` 镜像，以非 root 用户运行。构建过程中执行全部本地测试；不需要在宿主机安装 Node.js。安装 Docker Engine / Docker Desktop 及 Compose 插件后运行：

```sh
git clone https://github.com/linlibot/linear-agent-gateway.git
cd linear-agent-gateway
docker compose up -d --build
docker compose ps
```

打开 [对话页](http://127.0.0.1:8089/v1) 或 [账户管理](http://127.0.0.1:8089/accounts)。首次启动会创建空账户存储和新的本地 API Key。下面的命令在你自己的终端显示 Key，复制到客户端或管理页使用：

```sh
docker compose exec gateway node -p "JSON.parse(require('node:fs').readFileSync('/app/.local-runtime/access.json','utf8')).api_key"
```

通过账户管理页导入 HAR / 会话 JSON，即可添加账号。API Base URL 仍是 `http://127.0.0.1:8089/v1`。镜像不包含开发者账号、Cookie、本地密钥、HAR 或生成结果；全新数据卷的模型目录初始只有 `linear-agent`，导入账号后可在容器内运行 `docker compose exec gateway node scripts/test-models.mjs`，按该账号的真实测试结果开放其他模型。

账户、API Key、模型成功记录、对话绑定、轮转策略和冷却状态全部保存在 `linear-data` 命名卷中，挂载到 `/app/.local-runtime`。更新、重启或执行 `docker compose down` 后重新启动均会保留这些数据。请勿给有用数据的 `down` 命令添加 `--volumes` / `-v`，该选项会删除数据卷。Docker 的健康检查验证本地服务是否响应，不代表 Linear 登录仍然有效。

可将 `.env.example` 复制为 `.env`，修改宿主机端口、轮询间隔或总超时。例如 `LINEAR_PORT=8090` 会将宿主机 `8090` 映射到容器 `8089`；容器内部端口保持不变。如果本机已经运行旧网关，可改用其他宿主机端口，或先停止旧网关再使用 8089。

服务器上部署时，默认端口仍只对服务器本机开放。可以通过 SSH 转发，在自己的电脑继续使用上述本地地址：

```sh
ssh -L 8089:127.0.0.1:8089 user@your-server
```

查看日志、更新和停止：

```sh
docker compose logs --tail=100 -f gateway
git pull --ff-only
docker compose up -d --build
docker compose down
```

备份或迁移现有账户时，先停止网关以取得一致快照。下面把容器中的整个运行目录备份到本机；这个目录已被 Git 忽略，仍应只在自己的机器之间传递：

```sh
docker compose stop gateway
docker compose cp gateway:/app/.local-runtime ./linear-data-backup
docker compose up -d
```

将旧的本地 `.local-runtime` 迁入已经创建的 Docker 服务时，先停止旧网关及容器，再复制并修正卷内文件所有者：

```sh
docker compose stop gateway
docker compose cp ./.local-runtime/. gateway:/app/.local-runtime/
docker compose run --rm --no-deps --user root gateway chown -R node:node /app/.local-runtime
docker compose up -d
```

替换目标卷前先备份其中原有数据。不要让两个网关实例同时写入同一份运行目录。`.dockerignore` 采用允许列表，账户运行目录、备份、HAR、`.env`、Git 历史和生成结果均不会进入构建上下文。GitHub Actions 的 Docker 工作流会验证镜像构建、端口映射、鉴权、非 root 运行和容器重建后的状态持久化。

## 对话方式

- `GET /health`：本地进程健康检查，不验证上游会话是否仍有效。
- `GET /v1` 或 `/`：浏览器接入说明与对话测试页，无需 Key 即可查看。
- `GET /accounts`：账户导入、校验、默认账户及轮转策略管理页面；查看和修改账户时需要本地 Key。
- `GET /v1/models`：轮转策略下返回参与自动选号的账户已实测模型的并集；固定策略下返回默认账户的模型目录。可用 `?account_id=acct-…` 查询指定账户，需要本地 Key。暂时冷却或登录失效不会删除已保存的模型记录，发送时仍会跳过不可用账户。
- `POST /v1/chat/completions`：支持文本 JSON 响应及 `stream: true` 的 SSE 格式。
- 未提供 `conversation_id` 时，新建 Linear 对话；多条 `messages` 会按角色转换为文本历史后发送。
- JSON 响应带 `conversation_id`。后续携带它，并且只传一条新的 user 消息，即可原生续聊。SSE 响应通过 `X-Linear-Conversation-Id` 响应头返回对话 ID。
- 可选扩展字段 `account_id` 指定账户，取值来自 `GET /v1/accounts`。新对话未指定时按账户策略自动选号，默认轮转；响应体 `account_id` 与 `X-Linear-Account-Id` 响应头标明实际使用的账户。
- 对话接受后持久保存账户绑定；修改默认账户不会改变已有对话。对已绑定对话显式提供另一个账户会返回 409。迁移前未登记的旧对话会先用原账户做只读访问校验，再发送消息。

续聊请求：

```json
{
  "model": "linear-agent",
  "conversation_id": "上一条响应里的 UUID",
  "messages": [{"role": "user", "content": "接着解释上一条回答"}]
}
```

## 思考强度

0.4.0 起，浏览器对话页可选择默认、低、中、高；API 可传 `reasoning_effort: "low" | "medium" | "high"`。省略、`null` 或 `"auto"` 时不向上游传强度，跟随 Linear 默认配置。具体档位会映射为上游 `AiConversationSendMessageInput.reasoningEffort`，不改写为“多想一会”之类提示词。

```json
{
  "model": "openai/gpt-6.1-sol",
  "reasoning_effort": "high",
  "messages": [{"role": "user", "content": "分析这段代码"}]
}
```

如果 Cherry 输入框的思考下拉仍只有“默认”，可在编辑助手 → 模型 → 自定义参数中添加：名称 `reasoning_effort`、类型文本、值 `high`，需要其他档位时改成 `low` 或 `medium`；恢复默认时移除参数或填 `auto`。自定义参数会进入请求体，具体入口随 Cherry 版本可能不同。[Cherry 官方说明](https://github.com/CherryHQ/cherry-studio-docs/blob/main/cherrystudio/preview/chat.md)

2026-10-27 在现有账户的普通 Agent 聊天上，`low`、`medium`、`high` 均被接受并收到 `EFFORT_OK`，无效档位被 `INVALID_INPUT` 拒绝。没有创建 Loops 或修改工作区默认配置。上游未提供可读取的实际推理预算或该会话的强度字段，因此确认的是请求参数校验和回复链路，实际计算分配仍未独立核验。

响应体和 SSE 的 `requested_reasoning_effort` 返回请求档位，默认时为 `null`，`reasoning_effort_verified` 为 `false`；响应头 `X-Linear-Requested-Reasoning-Effort` 返回档位或 `auto`。模型列表额外包含 `supported_reasoning_efforts` 与 `default_reasoning_effort`。网关暂不开放 `xhigh` 等未验证档位。

默认是省略参数、跟随上游配置，可能与低、中、高中的某一档重合，并非已确认的第四种独立推理策略。参数被接受和收到回复，不能证明实际推理预算、正确率或耗时存在差异。

若要复测行为差异，可运行 `node --preserve-symlinks --preserve-symlinks-main scripts/compare-reasoning.mjs`。默认固定同一账户和 `openai/gpt-6.1-sol` 模型请求参数，用三道本地构造、可自动核对答案的题，每档各测两次，共 24 个独立对话；档位顺序按固定随机种子打乱。不会读取工作区业务内容。`LINEAR_TEST_MODEL`、`LINEAR_ACCOUNT_ID` 可指定模型参数和账户，`LINEAR_COMPARE_REPEATS` 可设为 1、2 或 3。

对照报告保存在 `outputs/reasoning-comparison.json` 与 `.local-runtime/reasoning-comparison.json`，记录题目、标准答案、每次回复、正确性、耗时及上游工具调用数量。耗时含网络和约 1.5 秒轮询开销，不能当作纯思考时长；本对照不控制上游随机采样，也不能核验实际模型身份或隐藏推理 Token 数。有限样本只能描述观察结果，不能保证四个选项一定表现不同。

2026-10-27 完成 24 次行为对照：默认与中档各有一次因“不承接独立推理测试”而拒答，其余 22 次全部答对，全部请求均无工具调用。报告将拒答单独记为 `non_answer`，不记为数学错误。在四档都作答的 4 组相同题目上，端到端耗时中位数依次为默认 10.6 秒、低 10.7 秒、中 14.1 秒、高 9.8 秒。未观察到稳定的低→中→高正确性或耗时递增关系；该小样本不能证明四档存在独立的性能差异，因此仍保持 `reasoning_effort_verified: false`。

## 能力边界

- 选择 `linear-agent` 时不传上游 `model` 参数，使用上游默认配置。选择其他已测试条目时原样传递参数，不自动降级到默认入口。上游实际采用的模型身份仍未核验；候选条目通过请求及回复测试不等于模型身份已经验证。
- `system` / `developer` 历史会作为调用方文本发送，不能替换 Linear 自己的系统指令。
- 当前通过轮询读取最终回复。SSE 会先发送 role，再在最终回复完成后输出内容，属于缓冲 SSE；没有实现原生 WebSocket 的逐 token 流。
- 上游没有提供 Token 用量，因此 `usage` 为 `null`。
- 暂不支持图片、文件、客户端工具调用、Responses 或 Messages 协议，也不支持指定 temperature、max_tokens 等采样参数；不支持的字段会明确返回 400。
- 兼容 Cherry 自动附带的 `tools`：使用 `tool_choice: auto`、`none` 或省略时，允许直接返回文本，外部工具定义不会传给 Linear，也不会伪造工具结果。响应体 / SSE 带 `compatibility.client_tools: "unavailable"` 与被忽略的工具定义数量，响应头为 `X-Linear-Client-Tools: unavailable; text-only`。`required` 或指定函数仍返回 `client_tools_unavailable`；带客户端 `tool_calls` / `role: tool` 的历史仍不支持。Linear 自带工具由上游执行，不受这个兼容处理影响。
- 这是带有工作区工具的 Linear Agent；用户消息仍可能触发它自身的工具或 coding session。网关不能关闭上游工具，也不改变账号权限或额度。
- 每个实例串行处理请求，最多容纳 8 个执行中或排队请求。仅在发送尚未被接受、且明确因登录失效或限流被拒绝时按策略换号；已接受的请求及结果不明的网络错误不重放。所有尝试共用原请求的超时，包含排队时间；轮询超时或客户端断开时，会尽力取消已确认的上游会话。
- 使用网页内部协议，上游更新或登录失效后可能需要更新会话或实现。
- 0.4.1 修复了完整 HTML 未放在单一代码块时的富文本还原：保留 CSS 的通配选择器和 JavaScript 模板字面量，避免在脚本内部插入 Markdown 代码围栏。27 项本地测试通过；Astra 默认档成品已验证动画和暂停正常。绘图、布局与动画逻辑不作人工改写。

## 添加多个账户或更新凭证

打开 [本地账户管理](http://127.0.0.1:8089/accounts)，填写 `.local-runtime/access.json` 中的 `api_key`，然后导入每个账户的 HAR 或会话 JSON，可以分别命名为“个人账户”“工作账户”。本地 Key 用于访问网关；Linear 登录凭证用于网关向 Linear 鉴权，两者不能互换。页面不保存本地 Key，也不会读取浏览器其他账户的 Cookie。

每个账户分别登录 Linear，打开 Agent；按 F12 → Network，清空记录，发送一句简单消息，再导出包含此次请求及 Cookie 的 HAR。Chrome 默认脱敏 HAR 不包含 Cookie：在开发者工具 Settings → Preferences → Network 启用 `Allow to generate HAR with sensitive data`，再选择 `Export HAR (with sensitive data)`。[Chrome 官方说明](https://developer.chrome.com/docs/devtools/network/reference/#save-as-har)

导入后自动读取 Linear 身份并显示校验结果。不同用户或工作区单独保存；同一用户、同一工作区再次导入只更新该账户。回到对话页填写本地 Key，点击“刷新账户”可手动选择，也可以保持自动选号。默认账户用于固定策略的首选账户；轮转策略按账户顺序分配新对话。

也可在网关运行时使用命令行导入，第二个参数是可选名称：

```powershell
node --preserve-symlinks --preserve-symlinks-main .\scripts\import-har.mjs 'C:\本地路径\linear.har' '工作账户'
```

导入器只提取准确指向 Linear 客户端 GraphQL 地址的 Agent 请求，保存必要请求头，不保存整个 HAR。缺少 Cookie 的脱敏 HAR 会被拒绝。导入和切换默认账户无需重启。

账户文件是 `.local-runtime/accounts.json`，对话绑定是 `.local-runtime/conversation-accounts.json`。首次升级自动导入旧 `.local-runtime/linear-session.json`，原文件保留。账户管理 API 返回名称和身份等元信息，不返回 Cookie。所有会话文件、HAR 和本地 Key 都应留在本机；运行目录与根目录 `.private/` 已在 `.gitignore` 中排除。

账户管理接口都需要本地 Bearer Key：`GET /v1/accounts`；`POST /v1/accounts/import` 请求体 `{ "credential": "HAR 或会话 JSON 字符串", "label": "名称" }`；`POST /v1/accounts/{id}/check`；`POST /v1/accounts/{id}/default`。

## 轮转与换号重试

0.5.0 默认启用按新对话轮转、换号重试、最多尝试 3 个账户（含首次）、限流冷却 60 秒。在账户管理页可以改成固定默认账户、关闭重试、调整尝试上限（1–5）和冷却时间（1–3600 秒），并单独设置每个账户是否参与自动选号。设置立即生效，重启后保留。

轮转在请求开始执行时选号，跳过未参与、登录失效、冷却中及未实测所选模型的账户。仅有一个合适账户时仍使用该账户；要分摊指定模型的请求，至少需要两个参与选号且分别通过该模型测试的账户。新导入账户的默认入口可直接参与轮转，其他模型的成功记录不从原账户复制。手动选号和续聊会记录使用次数，但不改变新对话的轮转顺序。

自动换号只处理上游明确返回的登录失效（`linear_session_expired`）或限流（`linear_rate_limit`），且必须发生在消息被接受之前。同一请求不会重复尝试同一个账户，模型、提示词、思考档位与总超时保持不变。Linear 接受消息后可能已执行原生工具，因此之后的任何错误均不换号重放；结果不明的网络错误、超时和普通 Agent 生成错误也不重试。手动指定 `account_id` 或携带 `conversation_id` 时始终固定原账户，不跨账户重试。

登录失效账户会暂停自动选号，更新凭证或成功执行“检查凭证”后恢复。限流账户冷却到期后自动恢复，也可点击“结束冷却”；结束冷却不能解除登录失效状态。多个账户属于不同工作区时，新对话会进入实际选中账户的工作区，已有对话不会迁移。全局请求队列仍然串行，轮转用于分摊账户使用。

所有策略接口均需要本地 Bearer Key：

- `GET /v1/routing`：读取策略和各账户的状态、使用计数。
- `POST /v1/routing`：更新下列策略字段，可只提交其中一部分；未知字段和超出范围的值会被拒绝。
- `POST /v1/accounts/{id}/routing`：请求体 `{ "enabled": true }` 或 `false`，设置是否参与自动选号。
- `POST /v1/accounts/{id}/reset-cooldown`：结束该账户的限流冷却。

```json
{
  "strategy": "round_robin",
  "failover_enabled": true,
  "max_attempts": 3,
  "cooldown_seconds": 60
}
```

JSON 与 SSE 响应的 `routing` 包含 `strategy`、`attempt_count`、`failover_count` 和 `attempted_account_ids`；响应头 `X-Linear-Attempts` 与 `X-Linear-Routing-Strategy` 可用于排查。账户标识始终指向实际接受请求的账户。策略、轮转位置和健康计数保存在 `.local-runtime/routing.json`，不包含会话 Cookie。

## 验证

```powershell
npm test
# 下面会依次真实测试候选模型参数，更新本机模型列表：
npm run test:models
# 下面会真实创建测试聊天，并验证原生续聊及缓冲 SSE：
node --preserve-symlinks --preserve-symlinks-main .\scripts\smoke-test.mjs
```

可设置 `LINEAR_TEST_MODEL=openai/gpt-6.1-sol` 让 smoke test 验证指定模型参数；`LINEAR_TEST_EFFORT=high` 验证指定强度及 JSON、原生续聊、SSE 的档位标识。真实测试均可用 `LINEAR_ACCOUNT_ID=acct-…` 指定账户；未指定时，候选模型探测使用默认账户，smoke test 的新对话遵循当前选号策略，续聊固定原账户。模型列表按账户读取 `.local-runtime/model-validations/{account_id}.json`，不存在或读取失败时仅开放默认入口；原模型报告只迁移到原账户。

2026-10-27 验证：45 项本地测试通过，覆盖多账户导入、凭证校验、存储恢复、模型证据隔离、默认账户切换、续聊绑定、鉴权、取消、SSE、Cherry 自动附带工具的 HTML 生成请求、强度参数透传，以及三账户轮转、换号重试、冷却恢复、凭证刷新、策略持久化和已接受请求不重放。0.6.0 新增监听配置校验、无凭证首次启动及重启后密钥和策略保留测试。多账户轮转与故障转移使用独立临时目录中的模拟账户验证。真实聊天记录保存在本机 `.local-runtime/live-validation.json`，强度原始测试位于 `.local-runtime/reasoning-validation.json`；轮转上线验证记录见 `.local-runtime/routing-live-validation.json`。Docker 的实际构建、启动与重建测试结果见 [Docker 工作流](https://github.com/linlibot/linear-agent-gateway/actions/workflows/docker.yml)。

Cherry 提示 `Parameter tools is not supported` 时，升级至 0.3.1 并重启网关即可兼容普通文本 / HTML 代码生成，不需要删除自动附带的工具定义。这个兼容处理不会启用 Cherry 的文件读取、联网搜索或 MCP；需要这些外部工具时，应使用支持完整工具往返的后端。HTML 代码可以在 Cherry 中复制或预览，不会自动写入本机文件。
