Linear 凭证提取扩展（Chrome / Edge）

首次安装：
1. 将 ZIP 解压到一个固定目录。
2. Chrome 打开 chrome://extensions；Edge 打开 edge://extensions。
3. 开启“开发者模式”，点击“加载已解压的扩展程序”，选择包含 manifest.json 的目录。
4. 将“Linear 凭证提取”固定到浏览器工具栏。

使用：
1. 在同一个 Chrome / Edge 浏览器中登录 Linear，进入要导入的工作区。
2. 保存页面中尚未提交的内容，再打开扩展，点击“一键提取并下载 JSON”。
3. 扩展会刷新当前标签页，最多等待 90 秒，读取一条包含 Cookie、user、organization 的完整 GraphQL 请求。
4. 捕获后自动生成 linear-session-日期.json。若弹窗已关闭，5 分钟内重新打开扩展并点击“下载已提取的 JSON”。
5. 用管理员账号密码登录网关，在“账户管理 → 导入账户凭证”选择此 JSON 文件。
6. 添加其他账号时，在浏览器切换 Linear 登录账号后重新提取；切换工作区也需重新提取。

边界：
只支持 https://linear.app 和 https://client-api.linear.app 的请求。
只在主动点击后读取选定标签页的凭证，不读取其他站点、聊天内容或浏览器历史。
不会发送 Agent 消息、修改请求、上传凭证或自动访问网关。
临时凭证保存在扩展的 session 内存存储中，导出、取消、关闭选定标签页时清除，最迟在结果生成 5 分钟后过期清除。
JSON 含登录 Cookie，应保存在自己可访问的位置。扩展不支持隐身窗口。
缺少任一必需字段时不导出不完整的凭证，也不会从不同请求拼接账户身份。

源码：https://github.com/linlibot/linear-agent-gateway/tree/main/browser-extension
