# Checked posts without saved targets

The same-Host public delivery Service keeps `contractVersion: 1` and optionally advertises `reachableConversationVersion: 1`. This main-line slice implements `reachable-conversations-checked` for connected Feishu/Lark accounts. Other platforms retain their saved-target APIs. Discord/Slack expansion, Host policy/Client integration and a qualified Provider release remain separate work under BotHarness #1115.

`listReachableConversations(botId, { expectedFingerprint, signal, cursor? })` returns `{ version: 1, conversations: [{ id, kind: 'group', name }], hasMore, cursor? }`. A page contains at most 100 conversations; an opaque cursor is at most 2048 characters. Each adapter qualifies native membership and speaking permission; discovery never substitutes for a fresh send preflight.

`postConversationChecked(botId, conversationId, text, { expectedFingerprint, signal, beforeSend })` needs no saved target. The synchronous `beforeSend` callback is mandatory. Current membership and speaking permission are checked again, followed by the caller and registration fence immediately before the native message create. A success returns `{ sent: true, receipt: { version: 1, messageId, conversationId } }` with exact group correspondence.

The consumer owns local Binding, blocks, limits, conversation entries and Outbox. A proven preflight read failure is `send-preflight-unavailable`; native permission refusal is `send-permission-denied`. An unqualified result after sending is `send-result-unknown`, with no automatic retry. Disposing a registration fences unstarted effects; a native acceptance receipt is retained even if disposal happens after the effect.

Relevant platform contracts: [membership list](https://open.feishu.cn/document/server-docs/group/chat/list), [chat moderation](https://open.feishu.cn/document/server-docs/group/chat/get-3), and [send message](https://open.feishu.cn/document/server-docs/im-v1/message/create). The application needs the scopes required by these endpoints in its published version; a failed permission lookup never authorizes a send.

Lark discovery reads one native membership page of at most 100 chats, excludes private/dissolved chats, and checks each group's current speaking scope. `all_members` permits a member; `only_owner`/`moderator_list` require the authenticated Bot OpenID in the native `open_id` list. Moderation pagination is capped at ten pages with repeated/invalid cursor refusal. The caller's cancellation signal spans native reads; a stopped/replaced runtime cannot return even an empty stale page or dispatch a post.

Automated SDK fixtures verify this boundary, including cancellation, closure, revocation and exact native receipts. Historical first-post evidence on the old feature branch does not qualify this rebuilt revision. It advertises no new QQ proactive or own-Echo capability and changes no platform permissions.
