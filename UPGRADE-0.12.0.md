# 0.12.0：实时正文通道与首字延迟优化

本版基于 0.11.0（ba152ef）。已核对补丁与源码包的 88 个文件一致，随后完成本机代码审查、协议修正与真实账户验证。未部署或修改 AWS，未上传或输出账户凭证。

**2026-10-29 已完成真实账户复测。** 原作者交付时只有模拟测试；本机使用现有账户确认实时首字改善，并修正了最终一致性校验过宽、部分 turn 订阅无正文、以及真实 delta 省略起始代码围栏的问题。

| 项目 | 状态 |
| --- | --- |
| 实时通道实现、轮询兜底、最终一致性、工具保护 | 已完成 |
| 自动化测试 | 本机 Node 22.14.0：189 项通过，包含 35 项实时专项测试；完整回归按测试文件串行运行 |
| Docker | 本机没有 Docker CLI，实际镜像构建由 GitHub Actions 验证 |
| 新增 npm 依赖 | 无（使用 Node 22+ 内置 WebSocket），Dockerfile 不变 |
| 真实账户首字延迟 | 问候 3.51 秒、长文 4.35 秒、HTML 3.67 秒；见下表 |

## 数据流

```
客户端 ──POST stream──▶ 网关
                        ├─ ① 并行：WebSocket 连接 + hshk 握手（Cookie / Origin / UA，userId、userAccountId）
                        └─ ① 并行：GraphQL aiConversationSendMessage
                        ② 收到发送确认 → streamData subscribe（AiConversation，按 assistantMessage.id 过滤 parts）
                        ③ text / textDelta → 过滤、去重、确认起点 → 暂缓不稳定字符 → SSE delta.content
                        ④ GraphQL 轮询：正文实时到达时放慢；正文停顿、完成快照、连接失效时立即读取
                        ⑤ GraphQL 完成 → 最终一致性校验 → 补发剩余文本 → 结束 chunk（timings）
                        ⑥ finally：退订、关闭 WebSocket；未完成时取消上游回合
```

完成、错误、Linear 内置工具确认（elicitation）和最终文本仍只以 GraphQL 为准；实时通道只负责更早地送出正文。已被 Linear 接受的消息在任何情况下都不会重发。

## 实际改动

新增文件：

- `realtime.mjs`：`RealtimeChannel`（连接、握手、订阅、心跳、超时、大小限制、释放）与 `TurnStream`（按 part 累积当前回合的答案正文，过滤、去重、身份继承、起点确认、快照比对），以及计时与 URL 白名单工具。
- `consistency.mjs`：字母数字骨架只用于流起点识别；最终校验与断线拼接保留代码运算符、缩进、标点、URL、小数、标识符及 emoji，只规范化明确的 Markdown 展示差异。
- `scripts/probe-realtime.mjs`：真实账户的首字计时探测，可在同一部署上对比实时与轮询。
- `test/mock-sync.mjs`、`test/realtime.test.mjs`：模拟同步服务器与 35 项专项测试，包括真实代码块事件分片回归。

修改文件：

- `upstream.mjs`：`LinearClient` 可注入实时通道工厂；`chat()` 在发送前启动连接、确认后订阅、`finally` 中释放；轮询拆为 `follow()`，用可提前唤醒的等待替代固定 sleep；结果附带 `realtime` 摘要与 `turn`。未注入工厂时行为与 0.11.0 相同。
- `progressive.mjs`：保留 `ProgressiveText`；新增 `LiveText`（实时与轮询两种来源，先发送者独占本次响应）、`liveForm`（暂缓规则）、`verifyPart`（最终校验）。
- `chat-completions.mjs`：普通对话与工具模式接入 `LiveText`；最终文本合成、工具模式优先解析经校验的原始文本、修正回合文字冲突时保留首轮文字；计时与日志；`x-linear-realtime: off`；生产装配再次校验实时地址。
- `config.mjs`、`gateway.mjs`、`server.mjs`、`compose.yaml`、`.env.example`、`package.json`（0.12.0、测试列表、`probe:realtime`）、`README.md`、`test/mock-linear.mjs`（`hold` / `release`、最终 `body` / `bodyData` 覆盖、请求头选项）。
- `sse.mjs` 已检查，未修改：开头的 role chunk 是 OpenAI 流格式要求，15 秒注释心跳用于保持连接，二者都不计入 `first_text_ms`；内容只在真实正文到达时写出。

### 协议实现

按上一轮已验证的方向实现，并参考公开的 Linear 同步引擎逆向资料中旧版 `SyncWebSocket` 的 `ping` / `pong` 与 `noauth` 处理：

- 地址 `wss://sync.linear.app/`，查询参数 `userId`、`userAccountId`。升级请求头只包含该账号的 Cookie、`Origin: https://linear.app` 和采集到的 User-Agent。
- 握手 `{"cmd":"hshk","userId","userAccountId","clientType":"web","clientDatabaseId","protocolVersion":3,"clientVersion","useBinaryProtocol":false,"supportsSpectatorMode":true}`。`clientVersion` 与 `clientDatabaseId` 取自扩展采集的 `linear-client-version`、`linear-client-database-id` 请求头，没有写死 84778；缺少版本时可用 `LINEAR_REALTIME_CLIENT_VERSION` 兜底，否则该账号只轮询。
- 返回带 `sync` 对象的 `hshk` 才算认证成功；`noauth`、`error`、没有 `sync` 的 `hshk`、二进制帧、连接或握手超时（5 秒）都退回轮询。
- 默认只订阅 AiConversation + conversationId，并按当前 assistantMessage.id 过滤。可选 LINEAR_REALTIME_SUBSCRIPTION=turn；本机遇到部分 HTML 回合的 turn 订阅认证成功却无正文，因此默认采用会话订阅。
- 每 20 秒 `{"cmd":"ping","id":n}`；60 秒内收不到任何消息视为失效。单条消息 4 MiB、单请求累计 64 MiB 上限。
- 只处理 `modelName` / `modelId` / `propertyName` 与本次订阅一致的 `streamData`；`text` 与 `textDelta` 之外的类型不转发，`reasoning*` 记为非答案 part。`textDelta` 按 part ID 继承 `text` 消息（或 GraphQL 读取）中的 `phase` / `turnId`；身份未知的 part 会阻止其后的 part 输出，直到身份确定。
- **起点确认**：只有确认从开头看到的 part 才输出——空快照、无格式纯文本快照、与已缓冲增量文字一致且开头标记一致的快照，或第一条 steps 从文档开头插入。订阅晚于生成开始时，缺失开头的 part 不实时输出，结束时由 GraphQL 补全。
- **cursor / provenance / generation**：同一 cursor 的完全重复消息丢弃；可比较的 cursor（数字或 `数字-数字`）倒退时丢弃；带整数 `generation` 时丢弃旧代消息，已有文本的 part 进入新代则停止实时输出；`provenance` 的具体语义无法从当前前端代码确认（见“限制”），只记录首个值并统计变化次数，不据此丢弃数据。
- 一致性：生成中的快照与已累积文本做文字比对，矛盾时停止实时输出（`realtime_stopped: snapshot_mismatch`）；某个答案 part 在后续 part 开始后又收到增量也停止输出；结束时统一校验。真实 code_block 替换步骤已用于恢复被 delta 省略的起始围栏，覆盖语言标记与换行分开到达的情况。

### 输出格式与最终一致性

- 发送规则：暂缓尾部空白与被拆开的代理对字符；part 开头在能判断是否为 `<!doctype html` / `<html` 之前暂缓；完整 HTML 文档放入 `html` 代码围栏逐步发送（与轮询路径 `renderAnswerPart` 的最终形式一致）；Markdown、代码围栏按模型原文发送；part 之间的 `\n\n` 随下一个 part 的首段文字发送。
- 每个 part 的实时文本在结束时依次比较：与 GraphQL `body` 完全相同 → `exact`；与 `body` 或富文本渲染经过严格展示格式规范化后一致 → `body` / `rich`。Linear 文档有代码块、标题、列表或加粗等结构而实时文本缺少对应 Markdown 语法时，视为不可信，改用 Linear 渲染。
- 最终校验不再忽略运算符、URL、标点或提及标识符。展示层可以规范化列表标记、编号、围栏语言名和配对强调。代码块与行内代码中的空白仍有意义。无法安全对齐已发送前缀时返回 linear_stream_rewritten。

### 工具调用安全

- 仍是实验性结构化输出适配。工具模式只实时发送协议代码块之前的完整文字行，遇到代码围栏、`tool_calls`、`"nonce"`、`lgw-`、以 `{` / `[` 开头的行或 HTML 文档开头即永久停止；协议 JSON 和未校验参数不会出现在 `delta.content` 中。
- `tool_calls` 仍在整个回合完成并通过 nonce、工具名、JSON 与 Schema 校验后才发送；首次输出无效时的修正回合不实时转发。修正回复带有与已发送文字冲突的说明时，保留首轮文字，避免不必要的 `linear_stream_rewritten`。
- 计时分别记录 `first_text_ms`（首个真实正文写给客户端）与 `first_tool_call_ms`（首个已校验工具调用写给客户端）。按设计，后者不早于 `upstream_complete_ms`。
- 管理员登录、凭证自动同步、多账户轮转、工具会话、派发记录与防重复执行逻辑未改动，相关既有测试全部原样通过。

### 为什么没有引入 ws 库

Node 22 起内置的 WebSocket（undici）支持 `new WebSocket(url, { headers })` 设置 Cookie、Origin 与 User-Agent；本地已在 Node 22.23.4 上用模拟服务器确认这三个头确实发送。不引入依赖可以保持 Dockerfile、`.dockerignore` 不变，不需要 `npm ci` 和锁文件，也没有新的供应链风险；本环境也无法访问 npm 仓库生成可核验的锁文件。连接通过可注入的工厂创建，如以后必须改用 `ws`，只需替换工厂，并同步提交 `package-lock.json`、在 Dockerfile 两个阶段执行 `npm ci --omit=dev`、在 `.dockerignore` 允许列表中加入锁文件。内置 WebSocket 不读取 `HTTPS_PROXY`，服务器需要能直接访问 `wss://sync.linear.app`。

## 测试

### 自动化测试（本地，模拟上游）

原作者交付 185 项模拟测试。本机首次并行运行时，一项原有的时间窗口并发断言受调度影响失败；最终使用 --test-concurrency=1 跑完整回归，189/189 通过，原并发测试的断言保留。实时专项 35/35 通过。新增回归覆盖操作符与缩进差异、显式外来 turn ID、以及真实代码围栏缺失事件。

| 要求 | 覆盖的测试 |
| --- | --- |
| 实时流 | 首个正文早于 GraphQL 完成、多个真实增量、最终完全一致；短问候；握手、订阅、退订字段；Cookie 只在升级请求中出现 |
| 断线兜底 | 中途断线后轮询同一回合补全、不重发不取消；断线后与 Linear 规范化渲染按文字对齐衔接；`noauth`、握手超时、升级被拒、无 `sync`、超大消息、静默连接均退回且不阻塞发送 |
| 重复消息 | 相同 cursor 重发与倒退 cursor 只应用一次 |
| 取消 | 客户端中途断开时取消 Linear 回合并退订、关闭连接 |
| 旧回合过滤 | 会话订阅下忽略其他对话、旧回合、错误订阅对象的消息 |
| 思考过滤 | reasoning、reasoningDelta、commentary 内容从不出现在 SSE 中 |
| 最终一致性 | HTML 围栏流式且与轮询结果相同；列表符号与围栏语言名差异按内容校验；真实矛盾时返回 `linear_stream_rewritten`；快照矛盾时停止实时输出；旧 generation 丢弃；代理对不被拆开 |
| 工具协议保护 | 只流式发送工具代码块之前的文字，不含任何协议字符；调用在校验后发送；首轮无效调用经修正后不泄露其参数 |
| 其他 | 生产装配使用账号自身凭证且拒绝非 Linear 地址；`LINEAR_REALTIME=off`、buffered、JSON 请求不建连；`x-linear-realtime: off`；计时日志不含正文；长回复分批合并且结果正确；配置解析与 URL 白名单 |

### Docker

本机未安装 Docker CLI，未声称本机完成镜像构建。生产代码没有引入第三方运行依赖；Node 22.14.0 的内置 WebSocket 在模拟服务器和真实 Linear 连接上均已验证。实际 Node 24 镜像构建、启动与持久化检查由仓库现有 Docker 工作流执行。

### 真实测试与首字数据

同一账户、默认模型参数 linear-agent、auto 档，逐次新建独立对话。下表是少量样本，不是同一生成的双路比较，也不是所有模型的延迟保证；首个正文与 role/心跳分开统计。

| 场景 | 实时模式客户端首字 | 关闭实时的独立对照 | 结果 |
| --- | --- | --- | --- |
| 短问候 | 3.509 秒 | 4.909 秒 | 实时 15 个正文片段，正常结束 |
| 长文 | 4.354 秒 | 22.943 秒 | 实时 624 个正文片段，1,385 字符；最终校验 exact |
| HTML（修正后） | 3.674 秒 | 早期轮询样本 8.556 秒；提示词不同，不做倍数比较 | 848 个片段，输出含围栏共 4,534 个 UTF-16 代码单元，与同一回复的最终 body 和渲染逐字一致；HTML 完整、1 个内联脚本语法通过 |
| write_file 工具 | 4.153 秒（首个已校验工具调用） | 4.955 秒 | 均返回一次有效调用，探测不执行工具 |

初轮 HTML 请求曾遇到 connect_timeout，已验证继续轮询同一回合；另一次 turn 订阅连接成功但无正文。后续会话订阅暴露 delta 省略起始三个反引号的问题，已依据 ProseMirror replace 步骤恢复，并加入分片测试。修正后的真实 HTML 输出完整通过。

本次没有使用 New API 或 Caddy 转发，尚不能确认用户部署的中间层是否缓冲 SSE。未更换模型或思考档位来制造提速。原始计时和生成代码保存在本机忽略的 outputs 目录，凭证未纳入 Git。

最初同一回复的诊断仍成立：WebSocket 首正文 4.345 秒，GraphQL 首正文 16.760 秒，差距来自读取方式；这些数字与本版客户端复测分别记录。
## 最少验证步骤（真实账户，约 8 次 Agent 回复）

1. 部署 0.12.0（由部署者执行，步骤同 0.11.0 文档）。启动日志应有 `Realtime body channel: on (conversation subscription, falls back to polling).`。
2. 确认账号凭证包含 `useraccount` 与 `linear-client-version`：用扩展重新同步一次，或重新导入网页发送消息时的 HAR。否则结束 chunk 的 `fallback_reason` 会显示 `missing_user_account` / `missing_client_version`。
3. 在服务器上运行（Key 只从终端读入，不写入命令历史）：

   ```sh
   read -rs LINEAR_GATEWAY_KEY && export LINEAR_GATEWAY_KEY
   docker compose exec -e LINEAR_GATEWAY_KEY gateway node scripts/probe-realtime.mjs \
     --base http://127.0.0.1:8089/v1 --compare --out outputs/realtime-probe.json
   unset LINEAR_GATEWAY_KEY
   ```

   会依次测试短问候、约 1000 字正文、HTML/代码和一次工具调用，每项实时与轮询（`x-linear-realtime: off`）各一次。工具调用只校验，不执行。输出表格与 JSON 只含计时、长度和哈希。
4. 判断：实时行的 `source` 应为 `realtime`，`fallback` 为空，`ok` 为 `true`；对比两行的 `first_text_client`。HTML 行的正文应以 `html` 代码围栏开头；工具行的 `first_tool_client` 不早于完成时间属正常。
5. 通过 New API 等实际客户端再发一次流式请求，确认中间层没有缓冲 SSE。`docker compose logs gateway | grep chat_timing` 可查看每次请求的计时与退回原因。

| `fallback_reason` | 含义与处理 |
| --- | --- |
| `missing_user_account` / `missing_client_version` | 凭证缺少握手所需请求头：重新同步凭证，或设置 `LINEAR_REALTIME_CLIENT_VERSION` |
| `noauth` / `handshake_rejected` | Linear 拒绝握手：检查 Cookie 是否有效、版本号是否过旧 |
| `connect_failed` / `connect_timeout` / `closed_before_ready` | 服务器无法直连 `wss://sync.linear.app`：检查出站网络和代理 |
| `disconnected` / `idle_timeout` | 生成中断开：已自动轮询补全；频繁出现时检查网络 |
| `message_too_large` / `binary_protocol` / `server_error` | 协议或体积与预期不同：可增大上限或关闭实时通道，并反馈计数 |

若 `realtime.answer_deltas` 大于 0 但 `anchors` 为 `none`，说明 Linear 没有发送可确认起点的 `text` 消息，需要按实际消息调整起点规则；若频繁出现 `linear_stream_rewritten`，先设置 `LINEAR_REALTIME=off`，并提供结束 chunk 中的 `streaming` 计数（不含正文）以便分析。

## 关闭实时模式与回滚

- 只关闭实时通道：`.env` 中设置 `LINEAR_REALTIME=off`，执行 `docker compose up -d` 重新创建服务；日志显示 `off (polling only)`，行为回到 0.11.0 的轮询流式。
- 只对单个请求关闭：请求头 `x-linear-realtime: off`。
- 回滚代码与镜像（保留数据卷）：

  ```sh
  docker compose stop gateway
  git switch --detach "$(cat ../gateway-previous-commit.txt)"   # 升级前记录的 0.11.0 提交
  docker image tag linear-agent-gateway:rollback linear-agent-gateway:local
  docker compose up -d --no-build --wait
  curl -fsS http://127.0.0.1:8089/health
  ```

0.12.0 不新增持久化文件，也不改变账户、Key、管理员、凭证同步、工具会话的存储格式，回滚后数据卷可直接使用。不要执行 `docker compose down -v`。

## 限制与未完成

- 已用本机账户验证握手、会话订阅、active/completed 事件、正文增量、代码围栏步骤及最终输出。复杂节点、协议变更和其他账号配置仍可能触发安全校验失败；可用 LINEAR_REALTIME=off 回退。
- 已读取当日官网公开前端资源并观察真实事件；cursor/provenance 的完整语义仍未穷举。不认识的 cursor 不假设顺序，provenance 变化只计数。
- 生成中断线后不重连，改为轮询补全；断线后的剩余正文要等 GraphQL 完成才发送。
- 非流式请求和 `LINEAR_STREAM_MODE=buffered` 不使用实时通道。
- 特殊格式转换（如用户提及替换为显示名）可能触发严格不一致错误；不再通过删除标识符来放宽最终校验。工具参数仍在完整校验后才发送。
- 每个流式请求单独建立一条 WebSocket；默认单账号串行，并发连接数受原有并发设置限制。
- 未验证 New API、Caddy 等中间层对实时 SSE 的转发。

## 补丁

无推送权限时使用随交付提供的完整补丁（基于 `ba152ef`）：

```sh
git switch -c realtime-body-channel ba152ef
git am linear-agent-gateway-0.12.0.patch
npm test
```
