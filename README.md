# Linear Agent 本地对话网关

将本人 Linear 账号已经开放的内置 Agent 对话接入本地 Chat Completions 客户端。使用网页实际调用的 `client-api.linear.app/graphql`，发送 `AiConversationSendMessage`，再读取当前 assistant turn 的回复。

浏览器页面与 API Base URL 均为 `http://127.0.0.1:8089/v1`。默认模型入口为 `linear-agent`，也可选择已实测的模型请求参数。支持 Node.js 22 或更新版本直接启动，也支持 Docker Compose 部署，无第三方运行依赖。

0.11.0 新增（详见下文对应章节）：

- **客户端工具调用（实验性）**：接收标准 `tools` / `tool_choice` / `parallel_tool_calls`，返回标准 `tool_calls` 与 `finish_reason: "tool_calls"`，接受 `assistant.tool_calls` 与 `role: "tool"` 历史，可供 Cline、Roo Code 等本地编程客户端读写本地文件、执行本地命令。Linear 上游没有第三方函数接口，因此由网关把工具定义转成严格的结构化输出协议，只有通过 nonce、工具名和 JSON Schema 校验的输出才会变成 `tool_calls`。
- **工具循环续接**：同一个编程任务的多轮工具调用固定在同一个 Linear 对话和账号上，只发送新增消息；无法续接时自动用完整历史新建对话。重复请求和中断有保护。
- **逐步流式输出**：轮询期间把 Linear 已经稳定的文本立即转发为 `delta.content`；上游只在结束时给出回复时保持一次输出，不人为拆分。
- **有限并发**：全局并发、每个账号并发和排队上限均可配置，默认单账号仍串行。
- **凭证自动同步**：Chrome / Edge 扩展配对后定时检查已登录的 Linear 页面，并向指定网关同步更新后的 Cookie；具体条件见账户章节。

## 启动与客户端设置

全新安装不含任何 Linear 账号，先启动服务，再通过账户管理页导入凭证；已有的旧会话文件会自动迁入本机多账户存储。在本目录运行：

```powershell
.\scripts\start-local.ps1
```

| 客户端设置 | 值 |
| --- | --- |
| API 类型 | OpenAI Chat Completions |
| Base URL | `http://127.0.0.1:8089/v1` |
| API Key | 在 `/keys` 管理页自行创建的调用 Key |
| 模型 | `linear-agent` |

直接在浏览器打开 Base URL 会显示接入说明和对话测试页。测试页提供模型下拉框，需要手动输入调用 Key；网页不会自动读取或持久保存 Key。首次安装或从旧版本升级时，打开 [管理员登录](http://127.0.0.1:8089/login)，使用 `.local-runtime/access.json` 中的 `api_key` 作为初始化密钥，自行设置管理员账号密码，然后进入 `/keys` 创建调用 Key。

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

首次启动会生成独立的初始化密钥，不提供默认管理员账号密码。本地启动默认只监听 `127.0.0.1`；Docker 容器内监听 `0.0.0.0`，Compose 默认仍只将端口映射到宿主机的 `127.0.0.1`。管理员认证、调用 Key 与 Linear 的会话 Cookie 分开存放；日志不输出密码、Cookie 或 Key。

```powershell
$linearClientKey = Read-Host '输入你创建的调用 Key'
$linearBody = @{
    model = 'linear-agent'
    messages = @(@{ role = 'user'; content = '你好' })
} | ConvertTo-Json -Depth 10
Invoke-RestMethod -Uri 'http://127.0.0.1:8089/v1/chat/completions' `
    -Method Post -ContentType 'application/json; charset=utf-8' `
    -Headers @{ Authorization = 'Bearer ' + $linearClientKey } `
    -Body ([Text.Encoding]::UTF8.GetBytes($linearBody))
```

停止：`./scripts/stop-local.ps1`。可用环境变量：`LINEAR_HOST`（默认 `127.0.0.1`，须为 IPv4 或 IPv6 地址）、`LINEAR_PORT`（默认 8089）、`LINEAR_SESSION_FILE`（首次迁移使用的旧会话文件绝对路径）、`LINEAR_POLL_MS`（默认 1500，最小 500）、`LINEAR_TIMEOUT_MS`（默认 180000，包含排队时间）、`LINEAR_PUBLIC_URL`（可选的浏览器访问源，例如 `https://gateway.example.com`，不含路径）。

0.11.0 新增的环境变量（均可省略，括号内为默认值）：

| 变量 | 作用 |
| --- | --- |
| `LINEAR_CLIENT_TOOLS`（`structured`） | `structured` 启用客户端工具调用适配；`off` 恢复旧版文本模式：忽略 `tools`，`required`/指定函数及工具历史返回 400 |
| `LINEAR_STREAM_MODE`（`incremental`） | `incremental` 轮询期间转发已稳定文本；`buffered` 回到旧版的一次性输出 |
| `LINEAR_TOOL_CONTINUATION`（`native`） | `native` 工具循环续接同一 Linear 对话；`replay` 每次请求都用完整历史新建对话 |
| `LINEAR_TOOL_REPAIR_ATTEMPTS`（`1`） | 模型输出的工具调用无效时，在同一对话内要求它修正的次数（0–3） |
| `LINEAR_PROMPT_FORMAT`（`rich`） | `rich` 用代码块逐字携带客户端内容；`plain` 退回单段文本（仅在上游拒绝富文本时使用） |
| `LINEAR_MAX_CONCURRENCY`（`4`） | 全局同时执行的请求数（1–64） |
| `LINEAR_ACCOUNT_CONCURRENCY`（`1`） | 每个 Linear 账号同时执行的请求数（1–16） |
| `LINEAR_MAX_QUEUE`（`8`） | 执行中与排队中的请求总数上限，超出返回 429 `queue_full` |
| `LINEAR_MAX_BODY_BYTES`（8 MiB） | 聊天请求体上限；编程客户端每次都发送完整历史，体积会随任务增长 |
| `LINEAR_MAX_PROMPT_CHARS`（1000000） | 发给 Linear 的单条消息字符上限，超出返回 413 `prompt_too_large` |
| `LINEAR_STRICT_PARAMETERS`（`0`） | 设为 `1` 时像旧版一样拒绝 `temperature`、`max_tokens` 等采样参数 |
| `LINEAR_TOOL_SESSION_TTL_SECONDS`（86400） | 工具循环会话记录的保留时间 |
| `LINEAR_IDEMPOTENCY_SECONDS`（300） | 已完成的工具结果请求在多长时间内按重复请求直接返回原结果，0 关闭 |

## 管理员账号密码

0.8.0 起，`/accounts`、`/keys`、`/admin/security` 以及对应的管理 API 均要求管理员密码登录。未初始化时，后台跳转到 `/setup`；设置完成后，未登录访问会跳转到 `/login`。原 `access.json` 密钥无法绕过后台登录，已有调用 Key 可继续读取模型和发送聊天。

首次设置需要初始化密钥，以免其他访客抢先注册管理员。在自己的电脑打开 `.local-runtime/access.json`，将其中的 `api_key` 填入初始化页面，再设置账号和密码。账号为 3–64 个字母、数字、中文、下划线、点或连字符，登录时不区分大小写；密码为 15–128 个字符，支持空格和 Unicode。初始化完成后，此密钥不能用于远程重置账号或密码。

密码以带随机盐的 scrypt 摘要保存，参数为 `N=32768, r=8, p=3`；不保存明文密码。会话有效期为 8 小时，Cookie 使用 `HttpOnly`、`SameSite=Strict`，服务端仅保存会话摘要。退出登录立即撤销当前会话；在后台“修改密码”验证当前密码后，会撤销全部管理员会话，调用 Key 不受影响。密码长度与存储参数参考 [OWASP 身份认证](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html) 和 [密码存储建议](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)。

管理写请求要求 JSON、同源检查及会话绑定的 `X-CSRF-Token`。每个直接连接来源 IP 在 15 分钟内累计 5 次认证失败后暂停尝试；不信任客户端提供的 `X-Forwarded-For`。反向代理后的请求会共享代理来源的失败计数。登录验证另有并发限制。CSRF 处理参考 [OWASP CSRF 建议](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)。

程序管理接口使用相同登录流程：

- `GET /auth/session`：读取初始化及登录状态；已登录时返回用户名、过期时间和 CSRF Token。
- `POST /auth/setup`：仅首次接受 `{ "bootstrap_key": "初始化密钥", "username": "账号", "password": "密码" }`，设置成功后返回会话 Cookie 和 CSRF Token。
- `POST /auth/login`：接受 `{ "username": "账号", "password": "密码" }`，成功后返回新的会话 Cookie 和 CSRF Token。
- 管理 API 读取需携带该 Cookie；写入还需携带 `X-CSRF-Token` 请求头。所有管理 API 拒绝仅用 Bearer Key 鉴权。
- `POST /auth/logout`：请求体 `{}`，撤销当前会话。
- `POST /auth/password`：请求体 `{ "current_password": "当前密码", "new_password": "新密码" }`，更新密码并撤销所有会话。

管理员 Cookie 只授权管理操作；模型及聊天接口仍要求调用 Key，不能仅凭浏览器登录态触发 Agent。管理员认证文件为 `.local-runtime/admin-auth.json`，损坏时后台拒绝访问，不会自动覆盖已有配置。忘记密码时需由拥有服务器文件权限的维护者停服，将该文件备份到受保护的位置后移出运行目录，再启动并用初始化密钥重新设置；这会清除原管理员会话，账号池及调用 Key 不变。

## 创建自己的 API Key

0.8.0 的凭证用途如下：

1. **管理员账号密码**：首次通过初始化页面自行设置，用于管理账号池、轮转策略和调用 Key。`access.json` 中原称“管理员 Key”的密钥仅用于首次设置，并保留旧客户端聊天兼容；不能直接管理后台。Docker 初始化密钥的读取命令见下节。
2. **调用 Key**：由你在 [调用 Key 管理](http://127.0.0.1:8089/keys) 页面创建。可以只填写名称，由网关生成随机 Key；也可以填写自己的 Key，长度为 32–256 个字母、数字、下划线或连字符。创建后将其填入 Cherry 等客户端的 API Key 栏。
3. **Linear 登录凭证**：在账户管理页导入 HAR / 会话 JSON，供网关调用 Linear。它与管理员密码、调用 Key 分开保存。

调用路径为：`客户端调用 Key → 本地网关 → 已导入的 Linear 账号池 → Linear Agent`。调用 Key 使用账号池原有的权限和可用调用额度；新建更多 Key 不会增加上游额度，各 Key 也不对应独立的 Linear 余额。Linear 未返回可读取的剩余额度或 Token 用量，因此 `usage` 仍为 `null`，管理页不显示虚构的积分余额。

调用 Key 仅能读取模型目录和发送聊天，不能管理账号、改变轮转策略或创建其他 Key。它们遵循相同的选号、模型验证、续聊绑定和换号重试规则。管理页可按名称查看调用次数，并停用或重新启用某把 Key；停用后新的调用会被拒绝，已排队但尚未开始执行的请求也不会继续发送，已经执行的请求不强制中断。

Key 原文只在创建响应中返回一次，列表和后续读取均不返回原文或摘要；本地 `client-keys.json` 仅保存 SHA-256 摘要及名称、状态、调用计数等元信息。原文丢失后请新建 Key，并停用旧 Key。Docker 使用同一个运行数据卷保存 Key 和统计，容器更新或重建后保留。

统计中的“请求”是开始执行的有效聊天请求数，一次请求即使换号重试也只计一次；“成功”“失败”记录该请求的执行结果。模型列表读取、请求校验拒绝及未执行的排队请求不计数，这些数字不等于上游实际扣费、Token 或积分。旧管理员 Key 仍可用于聊天，以兼容已有客户端；它的请求不计入某把调用 Key 的统计。

Key 管理 API 均需要管理员登录会话，写请求另需 CSRF Token：

- `GET /v1/keys`：只返回名称、ID、启用状态和调用计数。
- `POST /v1/keys`：请求体 `{ "name": "Cherry" }`，可另加 `"key": "自己填写的 Key"`；201 响应中的 `api_key` 是唯一一次返回原文。
- `POST /v1/keys/{id}/status`：请求体 `{ "enabled": false }` 停用，改为 `true` 重新启用。

普通调用 Key 可访问 `GET /v1/models` 和 `POST /v1/chat/completions`；访问上述管理接口、`/v1/accounts` 或 `/v1/routing` 会返回 403。

## Docker 部署

0.6.0 起提供 Dockerfile 和 Compose 配置，使用官方 `node:24-alpine` 镜像，以非 root 用户运行。构建过程中执行全部本地测试；不需要在宿主机安装 Node.js。安装 Docker Engine / Docker Desktop 及 Compose 插件后运行：

```sh
git clone https://github.com/linlibot/linear-agent-gateway.git
cd linear-agent-gateway
docker compose up -d --build
docker compose ps
```

打开 [管理员登录](http://127.0.0.1:8089/login)。首次启动会创建空账户存储和新的初始化密钥。下面的命令在你自己的终端显示初始化密钥，用它完成首次管理员账号密码设置，再登录账户与调用 Key 管理页，自行创建客户端使用的调用 Key：

```sh
docker compose exec gateway node -p "JSON.parse(require('node:fs').readFileSync('/app/.local-runtime/access.json','utf8')).api_key"
```

通过账户管理页导入 HAR / 会话 JSON，即可添加账号。API Base URL 仍是 `http://127.0.0.1:8089/v1`。镜像不包含开发者账号、Cookie、本地密钥、HAR 或生成结果；全新数据卷的模型目录初始只有 `linear-agent`，导入账号后可在容器内运行 `docker compose exec gateway node scripts/test-models.mjs`，按该账号的真实测试结果开放其他模型。

账户、初始化密钥、管理员密码及会话摘要、调用 Key 摘要及统计、模型成功记录、对话绑定、轮转策略和冷却状态全部保存在 `linear-data` 命名卷中，挂载到 `/app/.local-runtime`。更新、重启或执行 `docker compose down` 后重新启动均会保留这些数据。请勿给有用数据的 `down` 命令添加 `--volumes` / `-v`，该选项会删除数据卷。Docker 的健康检查验证本地服务是否响应，不代表 Linear 登录仍然有效。

可将 `.env.example` 复制为 `.env`，修改宿主机端口、轮询间隔或总超时。例如 `LINEAR_PORT=8090` 会将宿主机 `8090` 映射到容器 `8089`；容器内部端口保持不变。如果本机已经运行旧网关，可改用其他宿主机端口，或先停止旧网关再使用 8089。通过 HTTPS 反向代理访问时，将 `LINEAR_PUBLIC_URL` 设为实际浏览器访问源（例如 `https://gateway.example.com`）；网关会校验该 Origin，并为管理员 Cookie 设置 `Secure`，不依赖可伪造的转发头。直接本机或 SSH 转发访问时留空即可。

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

### 升级到 0.11.0 与回滚

完整步骤、测试证据及文件清单见 [UPGRADE-0.11.0.md](UPGRADE-0.11.0.md)。本次只修改本地项目，未连接或更新 AWS 服务；更新时保留数据卷与现有 Caddy 配置。

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
- `GET /accounts`：账户导入、校验、默认账户及轮转策略管理页面，要求管理员账号密码登录。
- `GET /keys`：自行创建、命名、启停调用 Key 及查看调用计数，要求管理员账号密码登录。
- `GET /v1/models`：轮转策略下返回参与自动选号的账户已实测模型的并集；固定策略下返回默认账户的模型目录。可用 `?account_id=acct-…` 查询指定账户，需要调用 Key（或兼容旧客户端的原密钥）。暂时冷却或登录失效不会删除已保存的模型记录，发送时仍会跳过不可用账户。
- `POST /v1/chat/completions`：支持文本 JSON 响应及 `stream: true` 的 SSE 格式；支持客户端工具调用（见下节）。
- 未提供 `conversation_id` 且不带工具时，新建 Linear 对话；多条 `messages` 会按角色转换为文本历史后发送（与旧版相同）。带 `tools` 或工具历史的请求按工具循环处理：能识别为同一任务的后续请求时续接原对话，只发送新增消息。
- JSON 响应带 `conversation_id`。后续携带它，并且只传一条新的 user 消息，即可原生续聊。带工具时也可以只传上一条 assistant `tool_calls` 消息及其 `tool` 结果。SSE 响应通过 `X-Linear-Conversation-Id` 响应头返回对话 ID。
- `temperature`、`top_p`、`max_tokens`、`max_completion_tokens`、`stop`、`seed`、`user`、`metadata` 等采样或标记参数会被接受但不会传给 Linear（上游没有这些控制），响应体 `ignored_parameters` 与响应头 `X-Linear-Ignored-Parameters` 列出被忽略的参数。`n` 只能为 1，`response_format` 只能为 `text`，未知参数仍返回 400。
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

## 客户端工具调用（实验性）

### 上游能力核实

2026-10-28 使用已有账号直接校验 client-api：AiConversationSendMessageInput 明确拒绝 tools、clientTools、toolDefinitions、functions、toolChoice、toolResults、toolResult、functionResults、systemPrompt、instructions、mcpServers、stream 共 12 个字段；6 个猜测的工具结果提交 mutation 均返回字段不存在。详细读取 body、endedAt、工具名称字段获接口接受。HTTP 订阅探测返回 INTERNAL_SERVER_ERROR，未验证 WebSocket。以上限定于本次接口和字段，不代表枚举了所有内部能力。

同日真实工具测试通过：5 个 Agent 回合、约 25 秒，客户端执行 write_file → read_file → replace_in_file → read_file，隔离目录中的 index.html 标题确实变为 Final Title，后四轮续接同一个 Linear 对话。报告与完整边界见 [验证交付说明](UPGRADE-0.11.0.md)。这仍是实验性结构化适配，不是 Linear 原生外部函数接口。

### 工作方式

```text
Cline / Roo Code ──tools + messages──▶ 网关 ──工具说明 + 逐字历史──▶ Linear Agent
      ▲                                  │
      │◀── 已校验的标准 tool_calls ───────┘  解析回复末尾的 ```tool_calls 代码块
      │
  在本机执行（客户端授权） ── role:"tool" 结果 ──▶ 网关 ──只发送新增结果──▶ 同一 Linear 对话
```

1. 网关把工具定义（名称、说明、JSON Schema）写入发给 Linear 的消息。系统提示、历史消息、文件内容和工具结果放在代码块中逐字传递，避免被 Markdown 转换改写。
2. 模型需要调用工具时，在回复末尾输出一个 ```` ```tool_calls ```` 代码块，内容为 `{"nonce":"本轮随机值","tool_calls":[{"name":"...","arguments":{...}}]}`。
3. 只有同时满足以下条件，才会转换成 OpenAI `tool_calls`：代码块位于回复最后；JSON 严格合法；`nonce` 与本轮一致（防止把示例、旧回复或文件内容误认成调用）；工具名存在且符合 `tool_choice`；参数通过该工具 JSON Schema 校验（必填、类型、枚举、长度、`additionalProperties` 等）。
4. 不满足时，网关在同一个 Linear 对话中把具体问题告诉模型，要求修正（默认 1 次，`LINEAR_TOOL_REPAIR_ATTEMPTS`）。仍然无效则返回 502 `tool_call_invalid`，不会把任何调用交给客户端。普通文字、示例代码、不带本轮 nonce 的 JSON 一律按文本处理。
5. 每个调用分配唯一 ID（`call_` + 24 位随机字符），多个调用保持模型给出的顺序。`parallel_tool_calls: false` 时只转发第一个调用，并在下一轮告诉模型其余调用没有执行。
6. 网关从不执行工具，也不会在服务器上运行模型生成的命令。读写文件、执行命令都由本地客户端完成，并沿用客户端自己的授权确认。

| 字段 | 行为 |
| --- | --- |
| `tools` | 仅 `function` 类型；名称符合 `^[a-zA-Z0-9_-]{1,64}$` 且不重复；`parameters` 必须是 object 类型的 JSON Schema；接受 `strict` |
| `tool_choice` | `auto`（有工具时默认）、`none`、`required`、`{"type":"function","function":{"name":…}}`、`{"type":"allowed_tools",…}` |
| `parallel_tool_calls` | 默认 `true`；`false` 时每轮最多一个调用 |
| `assistant.tool_calls` | 按 OpenAI 规则校验：ID 唯一，之后必须紧跟每个调用的 `tool` 结果 |
| `role: "tool"` | `tool_call_id` 必须对应前一条 assistant 中尚未回答的调用；内容为字符串或文本 parts；结果后可以再跟用户消息 |
| `finish_reason` | 返回调用时为 `tool_calls`，否则为 `stop` |

JSON 响应中，`message.content` 为模型写在代码块之前的说明文字（没有时为 `null`），`message.tool_calls` 为标准数组，`arguments` 为 JSON 字符串。SSE 依次发送：`role` → 代码块之前的文字 → 每个调用一个含 `index`、`id`、`type`、`function.name` 的首个 delta，随后分段发送 `function.arguments` → `finish_reason: "tool_calls"` → 可选的 usage（`null`）→ `[DONE]`。

附加元数据（非 OpenAI 标准字段，客户端可以忽略）：`client_tools`（适配模式及 `tool_session`: `new` / `native` / `replay`）、`tool_protocol`（Linear 回合数、修正次数、调用数、因 `parallel_tool_calls: false` 未转发的调用数）、`linear_internal_tool_calls`（Linear 自己执行的内置工具名称，只列名称，不输出参数和结果）。响应头 `X-Linear-Client-Tools: structured-output; experimental` 与 `X-Linear-Tool-Session`。

### Linear 内置工具与本地文件

- Linear 自己的工具调用（Bash、CreateSandbox、编码会话等）只出现在 `linear_internal_tool_calls`，永远不会变成客户端的 `tool_calls`。
- 本轮没有客户端工具调用，但 Linear 使用了云端文件、沙箱或编码类内置工具时，回复末尾会追加 `[网关提示] 本轮没有发出任何客户端工具调用，你的本地文件没有被创建或修改……`，并说明回复中的路径属于 Linear 云端环境。
- 请求带有文件写入类客户端工具时，如果模型声称“已创建 / 已修改文件”，而本轮和历史里都没有任何文件写入类工具调用，也会追加同样的提示。
- 提示词要求模型不要使用 Linear 内置工具，但网关无法从上游关闭它们。Linear 若为自身的内置操作请求确认，仍返回 409 `linear_action_required`。

### 工具循环与对话续接

- 编程客户端每次都会发送完整历史。网关记录“到本次 assistant 回复为止的历史哈希 → Linear 对话与账号”。下一次请求的历史前缀与记录一致时（只比较哈希，assistant 文本容忍空白差异），续接同一个 Linear 对话，只发送新增的工具结果和用户消息（`X-Linear-Tool-Session: native`），工具说明每个对话只发送一次。
- 无法匹配续接记录时，把完整历史作为新对话发送（`replay`），例如客户端编辑或压缩历史、会话账号冷却或登录失效、显式指定另一个 `account_id`。完整历史包含此前所有调用和结果。同一个会话正在处理另一请求时返回 409，避免并发写入它。
- 续接固定使用会话所在的账号，不参与轮转，也不换号重试；只有改为完整历史重放时才会按策略重新选号。
- 会话记录保存在 `.local-runtime/tool-sessions.json`，只含哈希、调用 ID、账号 ID、对话 ID、客户端 Key ID、派发记录与时间戳，不含消息内容或凭证。损坏文件原样保留并另存 `.corrupt-时间戳` 副本，工具请求停止以保护重复请求记录，普通聊天仍可使用。恢复备份后重启。
- 不带工具的普通聊天保持旧行为：每次新建对话，或用 `conversation_id` 原生续聊。

### 中断、超时与重复请求

- 客户端断开或请求超时时，网关尽力取消 Linear 上已接受的回合，并废弃未完整交付的会话。已经派发或结果不确定的同一工具请求返回 409 `tool_request_already_dispatched`，不会自动重放。先检查上一轮工具执行结果，再用新消息继续；取消不能撤销已发生的 Linear 内部操作。
- 完全相同的请求仍在处理时，新请求返回 409 `duplicate_request_in_progress`（`Retry-After: 5`），防止同一步被执行两次。
- 以工具结果结尾的请求成功后，在 `LINEAR_IDEMPOTENCY_SECONDS`（默认 300 秒）内完全相同的重试返回原结果和相同的调用 ID，响应头 `X-Linear-Idempotent-Replay: true`。缓存只在内存中保存并有容量限制；重启、缓存过期或请求 `no-cache` 后，派发记录仍会阻止重复发送，默认保留 24 小时（`LINEAR_TOOL_SESSION_TTL_SECONDS`）。客户端仍须按调用 ID 防止重复执行工具。初始用户消息成功后可重新生成；未完成的请求仍受保护。

### 限制

- 这是由提示词约束、由网关严格校验的结构化输出，不是 Linear 原生函数调用。可靠性取决于所选模型对协议的遵守程度，以及 Linear Agent 是否仍优先使用自身工具。严格校验保证不会产生不合规的调用，但可能出现修正后仍失败的 502。
- 调用参数不是逐 token 生成后转发的：Linear 回合结束、完成校验后再分段发送。
- JSON Schema 支持明确的子集：类型、必填、枚举、对象/数组约束、本地引用及逻辑组合等。未知约束、远程引用、`format` 与不受支持的正则在请求阶段返回 400；复杂正则或超长待匹配字符串不会被静默跳过。此处接受 `strict` 并执行本地校验，未启用上游原生 strict 解码。
- 每个工具步骤都是一次完整的 Linear Agent 回合（含 Linear 自身的系统提示和轮询开销），延迟高于普通模型 API，额度按 Linear 规则消耗。
- 图片、音频、文件 parts 不支持（返回 400），请在 Cline / Roo Code 的模型设置中关闭图片支持。`usage` 仍为 `null`。
- Responses API 与 Anthropic Messages 协议尚未实现，请使用 Chat Completions。

## 流式输出

- 网关使用轮询（`LINEAR_POLL_MS`）；HTTP 订阅探测报上游错误，WebSocket 尚未验证。
- 每次轮询时，网关把当前回合中已经不会再变化的文本立即作为 `delta.content` 发送：已结束的 part 全部发送，生成中的 part 只发送最后一个块之前的内容；分隔符随后续块一起发送；完整 HTML 文档保留到结束再整体发送；带工具时，代码块之前的文字可以提前发送，代码块及之后的内容等回合结束并校验后再发送。
- 上游如果只在结束时给出回复，就只有一个内容 delta。2026-10-28 实测短文及 11,957 字符的 HTML 回复均只在结束时发布正文，长回复期间 44 次运行中轮询无正文，因此当前实测仍是缓冲式 SSE。`streaming.progressive_chunks` 表示完成前已转发的次数。若上游改写已转发前缀，返回 `linear_stream_rewritten` 错误，不拼接重复段落；丢弃该轮部分文本后可切换 `buffered`。
- 不输出 reasoning 与 commentary 阶段的内容；Linear 内置工具只输出名称。
- 每 15 秒发送一次 SSE 注释心跳；客户端断开时取消上游回合。`LINEAR_STREAM_MODE=buffered` 恢复旧版的一次性输出。
- 上游在生成过程中是否逐步发布文本，以 `scripts/probe-upstream-tools.mjs --send` 输出的 `incremental_text_observed` 为准。

## 并发与排队

- 默认全局最多 4 个请求同时执行，每个 Linear 账号最多 1 个，执行中和排队中合计最多 8 个，超出返回 429 `queue_full`。因此单账号部署仍与旧版一样串行；多个账号时，不同账号的请求可以并行。
- 仍在请求开始执行时选号：轮转顺序不变，忙碌的账号会被跳过，改用同一计划中的其他就绪账号；全部忙碌时等待最先空闲的账号。限流冷却、登录失效判断和换号重试规则不变。
- 排队时间计入 `LINEAR_TIMEOUT_MS`；在排队中超时的请求不会发送到 Linear。
- 工具会话的续接请求会等待所属账号空闲，不会换到其他账号。
- 调高 `LINEAR_ACCOUNT_CONCURRENCY` 可能触发 Linear 限流，建议保持 1。

## 接入 Cline / Roo Code

| 设置 | Roo Code | Cline |
| --- | --- | --- |
| API Provider | OpenAI Compatible | OpenAI Compatible |
| Base URL | `https://你的网关域名/v1`，本机为 `http://127.0.0.1:8089/v1` | 同左 |
| API Key | 在 `/keys` 创建的调用 Key | 同左 |
| 模型 | `linear-agent` 或 `/v1/models` 中已验证的模型参数 | 同左（Model ID） |
| 图片 | 关闭 Image Support | 关闭 Supports Images，不启用 Computer Use / 浏览器 |
| 思考强度 | 默认，或 low / medium / high | 默认 |

- 按 [Cline 官方配置](https://docs.cline.bot/provider-config/openai-compatible) 和 [Roo Code 提供商说明](https://github.com/RooCodeInc/Roo-Code/blob/main/apps/docs/docs/providers/openai-compatible.md) 填写地址、Key 与模型 ID。标准工具请求及 SSE 累积格式已通过测试；尚未在这台电脑运行桌面扩展联调。
- 如果 HTTPS 证书由内部 CA 或自签名签发，需把根证书加入客户端信任，或在启动 VS Code 前设置 `NODE_EXTRA_CA_CERTS` 指向它；也可以使用受信任证书的域名。
- 编程任务的每一步都是一次 Linear Agent 回合，请适当调大客户端的请求超时时间，并按需设置 `LINEAR_TIMEOUT_MS`。

### 验证顺序（小额度）

1. 零消耗探测，在服务器上运行：`docker compose exec gateway node scripts/probe-upstream-tools.mjs`。查看 `send_input_fields.unknown` 是否包含 `tools`、`toolResults` 等字段（确认上游不接受原生工具）、`detailed_read.accepted`、`tool_result_mutations`，以及 `suggestions` 中列出的相近字段名。
2. 少量真实回合（约 4–5 次 Agent 回复）：`docker compose exec gateway node scripts/probe-upstream-tools.mjs --send`。查看 `streaming.incremental_text_observed`、`code_block_fidelity.exact`，以及 `tool_protocol` 两轮是否都得到有效调用、`linear_internal_tools` 是否为空。报告写入容器内 `outputs/upstream-tool-probe.json`，不含 Cookie。可加 `--size 20000,60000` 测试长消息。
3. 在你自己的电脑上、本仓库目录中运行本地客户端端到端测试（需要 Node.js 22+）。它在新的临时目录中让模型创建 `index.html`、读取、改标题、再次读取验证，所有工具都在本机执行：

   ```powershell
   $env:LINEAR_GATEWAY_KEY = Read-Host '调用 Key'
   node scripts/local-coding-client.mjs --base https://你的网关域名/v1 --model linear-agent --stream
   ```

   客户端逐项显示工具名和参数，输入 `y` 才在本机执行。`run_command` 仅接受 Node 命令格式，但被批准执行的 JS 仍拥有本机进程权限，这不是操作系统沙箱。输出末尾 `index_has_final_title: true` 表示本地文件实际通过校验；每一步的 `session: native` 表示续接了同一 Linear 对话。
4. 在 Cline 或 Roo Code 中打开一个空的测试文件夹，依次发送：
   - `在当前目录创建 index.html，标题为 Draft；读取它，把标题改为 Final Title，再读取确认，最后总结改动。`
   - `创建 sum.js 和 sum.test.js，用 node --test 运行；如果失败就修复后再运行。`

   应依次看到写文件、读文件、修改文件、执行命令的审批请求，文件实际出现在你的 Windows 目录中。

### 验证状态（0.11.0）

| 功能 | 模拟上游自动化测试 | 真实 Linear 上游 |
| --- | --- | --- |
| 普通聊天、模型/思考参数、多账号轮转、管理员、Key、凭证同步 | 通过 | 聊天及既有模型参数已实测；本版并发和浏览器同步仅模拟验证 |
| 工具定义、选择、Schema、多调用、结果、失败恢复、三轮循环 | 通过 | 标准 SSE 工具调用与本地 HTML 读写修改闭环通过 |
| 固定原对话及账号、重启、重复请求保护 | 通过 | 真实工具闭环后四轮为 native；重启和失败重试仅模拟验证 |
| 详细读取字段 | 通过 | 接口接受，真实回复可读取 |
| 实时正文增量 | 模拟增量通过 | 本次短文和长 HTML 均只在结束发布正文，仍为缓冲 SSE |
| Cline / Roo Code 桌面扩展 | 请求格式及本地测试客户端通过 | 未进行桌面扩展 UI 联调 |

## 能力边界

- 选择 `linear-agent` 时不传上游 `model` 参数，使用上游默认配置。选择其他已测试条目时原样传递参数，不自动降级到默认入口。上游实际采用的模型身份仍未核验；候选条目通过请求及回复测试不等于模型身份已经验证。
- `system` / `developer` 历史会作为调用方文本发送，不能替换 Linear 自己的系统指令。
- 通过轮询读取回复。SSE 先发送 role，再转发轮询时已经稳定的文本；上游只在结束时给出回复则一次输出。没有实现 Linear 同步引擎 / WebSocket 的逐 token 流（见“流式输出”）。
- 上游没有提供 Token 用量，因此 `usage` 为 `null`。
- 暂不支持图片、文件、Responses 或 Messages 协议。`temperature`、`max_tokens` 等采样参数会被接受但不生效，并在 `ignored_parameters` 中列出；`LINEAR_STRICT_PARAMETERS=1` 时改为返回 400。未知字段仍返回 400。
- 客户端工具调用为实验性结构化输出适配，不是上游原生函数调用；限制见“客户端工具调用”一节。
- Cherry 等客户端自动附带的 `tools` 现在会作为真实的客户端工具提供给模型：模型可以返回 `tool_calls`，由 Cherry 执行后回传结果；不需要工具时直接返回文本，网关不会伪造工具结果。设置 `LINEAR_CLIENT_TOOLS=off` 可恢复旧版文本兼容行为：`tool_choice: auto`、`none` 或省略时忽略工具定义并直接返回文本，响应体 / SSE 带 `compatibility.client_tools: "unavailable"` 与被忽略的工具定义数量，响应头为 `X-Linear-Client-Tools: unavailable; text-only`；`required` 或指定函数返回 `client_tools_unavailable`，带 `tool_calls` / `role: tool` 的历史返回 400。Linear 自带工具由上游执行，与客户端工具分开报告。
- 这是带有工作区工具的 Linear Agent；用户消息仍可能触发它自身的工具或 coding session。网关不能关闭上游工具，也不改变账号权限或额度。
- 默认全局最多 4 个、每个账号最多 1 个请求同时执行，最多容纳 8 个执行中或排队请求（见“并发与排队”）。仅在发送尚未被接受、且明确因登录失效或限流被拒绝时按策略换号；已接受的请求及结果不明的网络错误不重放。所有尝试共用原请求的超时，包含排队时间；轮询超时或客户端断开时，会尽力取消已确认的上游会话。
- 使用网页内部协议，上游更新或登录失效后可能需要更新会话或实现。
- 0.4.1 修复了完整 HTML 未放在单一代码块时的富文本还原：保留 CSS 的通配选择器和 JavaScript 模板字面量，避免在脚本内部插入 Markdown 代码围栏。27 项本地测试通过；Astra 默认档成品已验证动画和暂停正常。绘图、布局与动画逻辑不作人工改写。

## 添加多个账户或更新凭证

打开 [本地账户管理](http://127.0.0.1:8089/accounts)，用管理员账号密码登录，然后导入每个账户的 HAR 或会话 JSON，可以分别命名为“个人账户”“工作账户”。管理员密码用于登录后台；Linear 登录凭证用于网关向 Linear 鉴权，两者不能互换。页面不持久保存管理员密码，也不会读取浏览器其他账户的 Cookie。

0.9.0 提供 **Chrome / Edge 一键提取扩展**，免去导出 HAR 或手工复制字段：

1. 登录账户后台，点击“下载 Chrome / Edge 提取扩展”，解压 ZIP。也可以直接使用仓库的 `browser-extension` 目录。
2. Chrome 打开 `chrome://extensions`，Edge 打开 `edge://extensions`，开启“开发者模式”，点击“加载已解压的扩展程序”，选择包含 `manifest.json` 的目录。首次安装后可将扩展固定到工具栏。[Chrome 官方安装说明](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked)
3. 在安装扩展的浏览器中登录 Linear，进入目标工作区。保存未提交的输入后，打开扩展，点击“一键提取并下载 JSON”。扩展会刷新当前标签页，等待包含完整身份字段的请求；无需发送 Agent 消息。若没有捕获，可在目标工作区打开任一页面，90 秒后仍无结果则重新提取。
4. 捕获后生成 `linear-session-日期.json`。若弹窗关闭，5 分钟内重新打开扩展下载。回到账户后台，选择 JSON 并点击“导入并校验”。
5. 添加其他账号时，在浏览器切换 Linear 登录账号后重新提取；其他工作区也需分别提取。扩展不支持隐身窗口。

0.11.0 起支持**浏览器自动刷新与同步**。先导入账号，在该账号下点击“配对自动刷新”，将网关地址和一次性配对码填入扩展，点击“配对并启用自动刷新”。配对码有效 10 分钟，只能使用一次；浏览器会按需请求连接你填写的网关站点权限。首次配对会提取并校验凭证，此后无需反复下载或导入 JSON。

配对后，扩展会观察已绑定身份在 Linear 页面发出的登录请求，发现新 Cookie 时向绑定网关同步，并每 15 分钟在已打开的目标工作区标签页做一次只读身份查询。定时检查不会刷新页面、修改页面输入或发送 Agent 消息。浏览器需要运行，目标 Linear 工作区标签页需保持打开且已登录；浏览器关闭、电脑休眠或标签页不可用时不会伪造刷新。重新启动后会恢复定时检查，休眠可能推迟执行。Linear 要求重新登录时，仍须你在浏览器完成。定时行为使用 [Chrome Alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms)，只读查询通过 [Chrome Scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting) 在对应页面执行。

网关只接受该配对绑定的账号与工作区，先向 Linear 核对身份，再原子更新凭证；失效 Cookie、身份不符或检查期间发生了新的手动导入，均不会覆盖当前凭证。有效同步后该账号可恢复自动选号。账号名称、模型记录、调用 Key 和对话绑定保留。失败会退避重试；令牌失效或被撤销时停止同步。后台显示各浏览器配对的最近同步时间和失败代码，可以逐个撤销。扩展中移除配对也会尽力撤销服务端授权，网关离线时请稍后在后台撤销。已接受的在途检查可能完成。

配对授权只允许更新对应账号或撤销自身，不能聊天、创建调用 Key 或管理后台。服务端在 `.local-runtime/credential-sync.json` 中仅保存一次性配对码及同步令牌的 SHA-256 摘要；扩展将同步令牌保存在仅扩展上下文可读的本地存储，不保存管理员账号密码或持久保存 Linear Cookie。每次同步至少间隔 30 秒，相同 Cookie 在 15 分钟内不重复同步。自动更新的是网关中的凭证；以前下载的 JSON 仍是静态备份。

扩展申请 `webRequest`、`storage`、`alarms`、`scripting` 及两个 Linear 站点权限。网关站点通过[可选权限](https://developer.chrome.com/docs/extensions/reference/api/permissions)在配对时单独申请；远程网关须用 HTTPS，本机可用 HTTP。手动捕获结果保留在 `storage.session`，有效 5 分钟，导出、取消或关闭选定标签页时清除；自动同步仅在配对后向指定网关传送凭证，不拼接不同请求中的账户身份。下载的 JSON 含实际登录 Cookie，应妥善保管。扩展 ZIP 只包含固定清单内的 8 个源码文件，后台下载接口 `/admin/capture-extension.zip` 同样要求管理员登录。

**OAuth 边界：** Linear 的[官方 OAuth](https://linear.app/developers/oauth-2-0-authentication)支持 access token 与 refresh token 轮换；但当前网关使用网页会话和内置 Agent 的 `aiConversationSendMessage` 接口。2026-10-28 检查[官方发布的 Schema](https://raw.githubusercontent.com/linear/linear/refs/heads/master/packages/sdk/src/schema.graphql)，其中未找到这个发送字段；现有网页凭证中未发现独立 RT，同日只读请求也未返回 `Set-Cookie`。这些观察不能证明私有接口必定拒绝 OAuth，但目前尚未用正常 OAuth 授权得到的令牌验证其内置聊天能力。此版本实现浏览器会话同步，不承诺凭证永不过期。

如果不安装扩展，仍可使用 HAR 或会话 JSON：

每个账户分别登录 Linear，打开 Agent；按 F12 → Network，清空记录，发送一句简单消息，再导出包含此次请求及 Cookie 的 HAR。Chrome 默认脱敏 HAR 不包含 Cookie：在开发者工具 Settings → Preferences → Network 启用 `Allow to generate HAR with sensitive data`，再选择 `Export HAR (with sensitive data)`。[Chrome 官方说明](https://developer.chrome.com/docs/devtools/network/reference/#save-as-har)

导入后自动读取 Linear 身份并显示校验结果。不同用户或工作区单独保存；同一用户、同一工作区再次导入只更新该账户。管理员在同一浏览器登录后，对话页点击“刷新账户”可手动选择；未登录的普通调用 Key 使用已配置的账号池自动选号。默认账户用于固定策略的首选账户；轮转策略按账户顺序分配新对话。

也可在网关运行时使用命令行导入。先在 `/login` 完成管理员设置，将密码放入仅自己可读的 UTF-8 文本文件（例如被 Git 忽略的 `.private/admin-password.txt`；末尾可带一个换行），再设置以下环境变量。脚本会登录、携带会话与 CSRF Token 导入，最后退出该会话。第二个参数是可选名称：

```powershell
$env:LINEAR_ADMIN_USERNAME = '你设置的管理员账号'
$env:LINEAR_ADMIN_PASSWORD_FILE = 'C:\受保护目录\admin-password.txt'
node --preserve-symlinks --preserve-symlinks-main .\scripts\import-har.mjs 'C:\本地路径\linear.har' '工作账户'
```

导入器只提取准确指向 Linear 客户端 GraphQL 地址的 Agent 请求，保存必要请求头，不保存整个 HAR。缺少 Cookie 的脱敏 HAR 会被拒绝。导入和切换默认账户无需重启。

账户文件是 `.local-runtime/accounts.json`，对话绑定是 `.local-runtime/conversation-accounts.json`。首次升级自动导入旧 `.local-runtime/linear-session.json`，原文件保留。账户管理 API 返回名称和身份等元信息，不返回 Cookie。所有会话文件、HAR 和本地 Key 都应留在本机；运行目录与根目录 `.private/` 已在 `.gitignore` 中排除。

账户管理接口都需要管理员登录会话，写请求另需 CSRF Token：`GET /v1/accounts`；`POST /v1/accounts/import` 请求体 `{ "credential": "HAR 或会话 JSON 字符串", "label": "名称" }`；`POST /v1/accounts/{id}/check`；`POST /v1/accounts/{id}/default`。

## 轮转与换号重试

0.5.0 默认启用按新对话轮转、换号重试、最多尝试 3 个账户（含首次）、限流冷却 60 秒。在账户管理页可以改成固定默认账户、关闭重试、调整尝试上限（1–5）和冷却时间（1–3600 秒），并单独设置每个账户是否参与自动选号。设置立即生效，重启后保留。

轮转在请求开始执行时选号，跳过未参与、登录失效、冷却中及未实测所选模型的账户。仅有一个合适账户时仍使用该账户；要分摊指定模型的请求，至少需要两个参与选号且分别通过该模型测试的账户。新导入账户的默认入口可直接参与轮转，其他模型的成功记录不从原账户复制。手动选号和续聊会记录使用次数，但不改变新对话的轮转顺序。

自动换号只处理上游明确返回的登录失效（`linear_session_expired`）或限流（`linear_rate_limit`），且必须发生在消息被接受之前。同一请求不会重复尝试同一个账户，模型、提示词、思考档位与总超时保持不变。Linear 接受消息后可能已执行原生工具，因此之后的任何错误均不换号重放；结果不明的网络错误、超时和普通 Agent 生成错误也不重试。手动指定 `account_id` 或携带 `conversation_id` 时始终固定原账户，不跨账户重试。

登录失效账户会暂停自动选号，更新凭证或成功执行“检查凭证”后恢复。限流账户冷却到期后自动恢复，也可点击“结束冷却”；结束冷却不能解除登录失效状态。多个账户属于不同工作区时，新对话会进入实际选中账户的工作区，已有对话不会迁移。0.11.0 起不同账号的请求可以并行，同一账号默认仍串行；工具循环的续接请求固定在原账号，不计入新对话的轮转位置。

所有策略接口均需要管理员登录会话，写请求另需 CSRF Token：

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
# 下面会真实创建测试聊天，并验证原生续聊及 SSE：
# 先按上节设置 LINEAR_ADMIN_USERNAME 和 LINEAR_ADMIN_PASSWORD_FILE。
node --preserve-symlinks --preserve-symlinks-main .\scripts\smoke-test.mjs
# 客户端工具与流式能力探测（默认零消耗；--send 会产生约 4–5 次 Agent 回复）：
npm run probe:tools
# 本地编程客户端端到端测试（在临时目录中执行工具，需要调用 Key）：
npm run e2e:client -- --base http://127.0.0.1:8089/v1 --stream
```

可设置 `LINEAR_TEST_MODEL=openai/gpt-6.1-sol` 让 smoke test 验证指定模型参数；`LINEAR_TEST_EFFORT=high` 验证指定强度及 JSON、原生续聊、SSE 的档位标识。真实测试均可用 `LINEAR_ACCOUNT_ID=acct-…` 指定账户；未指定时，候选模型探测使用默认账户，smoke test 的新对话遵循当前选号策略，续聊固定原账户。模型列表按账户读取 `.local-runtime/model-validations/{account_id}.json`，不存在或读取失败时仅开放默认入口；原模型报告只迁移到原账户。

2026-10-28 验证：71 项本地测试通过，覆盖多账户导入、凭证校验、存储恢复、模型证据隔离、默认账户切换、续聊绑定、鉴权、取消、SSE、Cherry 自动附带工具的 HTML 生成请求、强度参数透传，以及三账户轮转、换号重试、冷却恢复、凭证刷新、策略持久化和已接受请求不重放。0.6.0 新增监听配置校验、无凭证首次启动及重启后密钥和策略保留测试。0.7.0 新增自建调用 Key、权限隔离、摘要存储、按 Key 计数、停用排队请求及统计故障不重放测试。0.8.0 新增管理员初始化与登录、旧 Key 无法绕过、密码及会话摘要、CSRF 和来源校验、退出与改密撤销、失败限流、重启持久化、认证文件损坏拒绝访问、HTTPS Cookie 和命令行密码会话测试。0.9.0 新增凭证提取、跨标签页和账户隔离、过期清除、worker 恢复、弹窗来源校验及扩展 ZIP 的测试，使用模拟 Chrome API；尚未完成安装扩展后的真实 Linear 捕获验证。多账户轮转与故障转移使用独立临时目录中的模拟账户验证。真实聊天记录保存在本机 `.local-runtime/live-validation.json`，强度原始测试位于 `.local-runtime/reasoning-validation.json`；轮转上线验证记录见 `.local-runtime/routing-live-validation.json`。Docker 的实际构建、启动与重建测试结果见 [Docker 工作流](https://github.com/linlibot/linear-agent-gateway/actions/workflows/docker.yml)。

2026-10-28（0.11.0）：135 项自动化测试全部通过。原有 71 项中，4 项改为显式验证 `LINEAR_CLIENT_TOOLS=off` 旧模式（默认已启用工具调用），3 项因返回值和配置项扩展改为只比较原有字段，轮转测试固定串行并发以保持原有断言，其余未改动；新增 64 项。新增测试使用模拟 Linear 上游（`test/mock-linear.mjs`，实现发送、读取、取消三个操作，把模型 Markdown 转成 Linear 富文本，可分多次轮询逐步发布回复），不连接 Linear、不消耗额度，覆盖：

- `test/tool-protocol.test.mjs`：JSON Schema 校验、工具定义与 `tool_choice` 校验、协议解析（合法调用、示例与普通文字不误判、12 类格式错误、上游丢失代码块语言名、tool_choice 约束、`parallel_tool_calls: false`）、OpenAI 消息规则、历史哈希、逐字代码块文档。
- `test/tool-calling.test.mjs`：普通聊天兼容、单次 / 多个调用、结果回传与原生续接、连续三轮、工具失败后恢复、协议与 Schema 问题的修正及修正耗尽、`tool_choice` 五种模式、SSE 事件顺序与大参数分段、客户端中断后不续接、超时取消且不重放、并发重复请求 409 与已完成重复请求缓存、Linear 内置工具与“未修改本地文件”提示、详细查询退回、采样参数报告与严格模式、`conversation_id` 续接、Roo Code 与 Cline 的实际请求格式、上游拒绝富文本输入时自动改用纯文本。
- `test/tool-sessions.test.mjs`：多账号下工具循环固定原账号且不影响轮转、显式 `account_id` 与冷却时的完整重放、修正回合仍只计一次调用 Key 请求、会话文件只含哈希并在重启后续接、损坏文件不阻断聊天。
- `test/streaming.test.mjs`：只转发稳定块、HTML 与工具代码块保留、改写后的补发、逐步 SSE 与 JSON 结果一致、上游只给最终结果时不拆分、buffered 模式、断开取消、空回复快速失败、Linear 云端工具只在涉及文件时提示。
- `test/concurrency.test.mjs`：排队上限、全局 FIFO、每账号槽位、多账号并行与轮转顺序、单账号串行、排队超时不发送。
- `test/e2e-coding-client.test.mjs`：本地编程客户端（`scripts/local-coding-client.mjs`）在临时目录完成“创建 index.html → 读取 → 改标题 → 验证”，并在完整重放模式下重复；编写代码与测试、本地运行 `node --test`、按失败输出打补丁并重跑；用户拒绝授权；路径不能逃出工作区。

以上均为模拟上游结果，真实上游状态见“验证状态（0.11.0）”。

Cherry 提示 `Parameter tools is not supported` 时，升级至 0.3.1 或更新版本并重启网关。0.11.0 起 Cherry 附带的工具（文件读取、联网搜索、MCP）会作为客户端工具提供给模型，由 Cherry 执行；如只需要旧版的纯文本 / HTML 代码生成，设置 `LINEAR_CLIENT_TOOLS=off`。HTML 代码可以在 Cherry 中复制或预览，只有客户端执行了写文件工具时才会写入本机文件。
