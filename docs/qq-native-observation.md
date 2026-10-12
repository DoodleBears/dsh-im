# Maintained QQ transport observation

This candidate extends the existing QQ metadata diagnostics to the WebSocket `message` boundary, before SDK decode/JSON parsing. It supports investigation of missing own-send reflection; it does not qualify QQ own Echo or provide intake/reply authority.

The Host build checks the SHA-256 of the published SDK 1.0.4 `QQBot.js` and `gateway-connection.js` before applying a narrow source patch. The patch adds the proposed public `onGatewayObservation` constructor option, forwards it to the Gateway and bundles the patched SDK into the maintained Provider. A changed SDK input or patch anchor refuses the build. This option is a maintained extension, not an existing upstream SDK guarantee; upstream SDK 1.0.4 remains the exact dependency. The already-locked `ws` 8.21.3 is explicit because the bundled SDK still imports the ordinary WebSocket implementation externally. No runtime monkeypatch, second receiver or authentication request is added.

Each WebSocket message has a process-local connection/frame counter, byte length and a `received` observation before decode. A successful parse reports `decoded` with a fixed opcode/event-type allowlist and a safe native sequence number. Parse failures report `parse-refused`; synchronous processing failures after successful parsing report `processing-refused`. There are no raw payloads, message text, identifiers, credentials, session IDs or error text in these observations. The existing decoded Gateway metadata adds the same transport counter to permit exact boundary comparison. Node's parser can quote payloads in its error message, so the Runtime suppresses that raw SDK error text and retains the coded observation instead.

The Provider observer emits at most 128 records per minute, reports suppression on the next allowed record, and retains only one current decoded context. Existing Gateway/callback/receipt budgets remain independent. Observer exceptions and rejected Promises cannot stop dispatch. Runtime cancellation/current-controller guards reject old observations. Counts, missing phases, truncation and capture capacity must be inspected for each new qualification window; these are process evidence, not durable history or platform guarantees.

Tests exercise the same build plugin and real installed SDK through public Runtime intake/checked reply, plus malformed JSON, unknown opcodes, sink failures and artifact drift. Fixtures establish the new observation boundary; only a distinct real QQ window can establish native behavior.

## 维护版 QQ 传输观测

此候选把既有 QQ 元数据诊断延伸到 WebSocket `message` 进入 SDK decode／JSON parse 之前，用来调查自身消息回推缺失。它不声明 QQ own Echo 资格，也不增加收件或发送权限。

Host 构建先校验已发布 SDK 1.0.4 的两个输入文件 SHA-256，再应用小范围源码补丁。补丁增加候选公开构造选项 `onGatewayObservation`，转交 Gateway，并把维护版 SDK 编入 Provider。SDK 内容或补丁锚点变化会拒绝构建。此选项属于维护扩展，不是上游 1.0.4 已有保证；依赖仍精确保持 1.0.4。编入的 SDK 显式使用已经锁定的依赖 `ws` 8.21.3。不修改运行时私有对象、不启动第二接收器、不增加认证请求。

每条 WebSocket message 在 decode 前报告进程内 connection／frame 计数、字节长度和 `received`。解析成功报告 `decoded`、白名单 opcode／event type 和安全原生序号；解析失败报告 `parse-refused`；解析后的同步处理失败报告 `processing-refused`。元数据不包含 raw payload、正文、实体定位、凭据、session ID 或错误正文。既有 Gateway 元数据带上相同传输计数，用于精确比较边界。Node 的解析错误可能包含原文，因此 Runtime 屏蔽该原始错误文字，保留固定结果码。

Provider 每分钟最多输出 128 条，下一条允许记录报告抑制数量，只保留当前一个 decoded context。既有 Gateway／callback／receipt 各自预算不变。观测器抛错或 Promise 拒绝不影响 dispatch；旧 Runtime／取消状态拒绝继续观测。每个新验收窗口必须检查计数、缺失 phase、截断和采集容量。诊断仅为进程证据，不是第二份持久历史或平台能力保证。

测试通过同一个构建插件和实际安装的 SDK，覆盖公开 Runtime 收件／checked reply、错误 JSON、未知 opcode、sink 失败和 artifact 漂移。Fixtures 证明观测边界有效；真实 QQ 行为仍须独立新窗口验收。
