# Checked posts without saved targets

The same-Host public delivery Service keeps `contractVersion: 1` and optionally advertises `reachableConversationVersion: 1`. The first adapter slice is Feishu/Lark: qualified connected accounts advertise `reachable-conversations-checked`. Other accounts retain their saved-target APIs.

`listReachableConversations(botId, { expectedFingerprint, signal, cursor? })` returns `{ version: 1, conversations: [{ id, kind: 'group', name }], hasMore, cursor? }`. A page contains at most 100 conversations; an opaque cursor is at most 2048 characters. The native chat list proves membership and the native moderation query qualifies speaking permission. This initial slice includes `all_members` groups. Restricted moderator groups are not yet included.

`postConversationChecked(botId, conversationId, text, { expectedFingerprint, signal, beforeSend })` needs no saved target. The synchronous `beforeSend` callback is mandatory. Current membership and speaking permission are checked again, followed by the caller and registration fence immediately before the native message create. A success returns `{ sent: true, receipt: { version: 1, messageId, conversationId } }` with exact group correspondence.

The consumer owns local Binding, blocks, limits, conversation entries and Outbox. A proven preflight read failure is `send-preflight-unavailable`; native permission refusal is `send-permission-denied`. An unqualified result after sending is `send-result-unknown`, with no automatic retry. Disposing a registration fences unstarted effects; a native acceptance receipt is retained even if disposal happens after the effect.

Relevant platform contracts: [membership list](https://open.feishu.cn/document/server-docs/group/chat/list), [chat moderation](https://open.feishu.cn/document/server-docs/group/chat/get-3), and [send message](https://open.feishu.cn/document/server-docs/im-v1/message/create). The application needs the scopes required by these endpoints in its published version; a failed permission lookup never authorizes a send.
