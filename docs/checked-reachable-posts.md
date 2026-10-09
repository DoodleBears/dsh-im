# Checked reachable group posts / 经校验的可达群主动发送

This unreleased optional same-Host `dshIm` Service capability is advertised as `reachable-conversations-checked` by qualified Lark, Discord and Slack accounts. It does not grant a caller authority or create a saved delivery target. The consuming application owns Binding, blocks, limits, deduplication and Outbox.

这个未发布的可选同 Host Service 能力由已验证的 Lark、Discord、Slack 账号声明。它不授权调用方，也不创建已保存投递目标；使用方仍管理绑定、屏蔽、限额、去重和 Outbox。

```js
await dshIm.listReachableConversations(accountRef, {
  expectedFingerprint, signal, cursor,
});
// { version: 1, conversations: [{ id, kind: 'group', name }], hasMore, cursor? }
await dshIm.postConversationChecked(accountRef, conversationId, text, {
  expectedFingerprint, signal, beforeSend: () => currentAuthorization(),
});
// { sent: true, receipt: { version: 1, messageId, conversationId } }
```

`beforeSend` is mandatory and must synchronously return true. Discovery is a preview: every post rechecks native reachability and the current caller fence immediately before dispatch. Registration/runtime disposal cancels unstarted effects. A returned native acceptance remains evidence even if disposal follows it. Native POST is not retried; missing or ambiguous receipts are `send-result-unknown`. Neither an inbound Source Event nor an original reply ID is invented.

`beforeSend` 必须同步返回 true。群列表只是预览；每次发送重新校验原生权限，再检查调用方当前授权。注销／连接关闭会阻止未开始的效果；平台已接受的回执仍保留。原生发送不自动重试，缺失或不确定回执为 `send-result-unknown`，不伪造收件来源或被回复消息。

| Platform / 平台 | Native qualification / 原生校验 | Bounded scope / 有界范围 |
| --- | --- | --- |
| Lark | Joined chat list and member-only moderation API; authenticated own Bot ID must appear in restricted speaking lists / 已加入群及仅群成员可调用的发言权限 API，受限群名单须包含认证的自身机器人 ID | Group/topic chats; at most ten moderation pages, fail closed on unreadable or incomplete lists / 群与话题群，最多十页名单，无法核验时拒绝 |
| Discord | Current guild member, role permissions, channel overwrites, VIEW_CHANNEL + SEND_MESSAGES, timeout / 当前服务器成员、角色及频道覆盖、可见及发言权限、禁言 | Guild text/announcement channels; 100 channels per page; existing-thread replies remain separate / 服务器文本及公告频道，每页最多 100 个；已有线程回复仍沿用原路径 |
| Slack | Bot `users.conversations`, fresh `conversations.info`, `chat:write` from authenticated OAuth scope headers, membership and posting restrictions / 机器人自己的已加入群列表、最新群信息、认证 OAuth 权限头里的写权限、成员身份及发言限制 | Joined public/private channels, 20 native candidates per page; unknown role/subteam restrictions fail closed unless own user is explicitly allowed / 已加入公开与私有群，每页 20 个；无法确认的角色／用户组限制拒绝，明确允许自身用户除外 |

Slack discovery needs `channels:read` and `groups:read`; the template includes them, but existing tokens are not silently upgraded. Older Providers retain their saved-target APIs and do not acquire this capability implicitly. Readable permission errors remain refusals; network failures after dispatch remain unknown.

Slack 群发现需要 `channels:read` 和 `groups:read`。模板包含这些权限，现有 token 不会自动升级。旧 Provider 保留保存目标接口，不隐式获得新能力。明确的权限错误为拒绝，发出请求后的网络不确定性仍为 unknown。

Primary sources: [Discord guild channels](https://docs.discord.com/developers/resources/guild#get-guild-channels), [Discord permissions](https://docs.discord.com/developers/topics/permissions), [Slack joined conversations](https://docs.slack.dev/reference/methods/users.conversations/), [Slack conversation restrictions](https://docs.slack.dev/reference/objects/conversation-object/), [official Lark SDK models](https://pkg.go.dev/github.com/larksuite/oapi-sdk-go/v3/service/im/v1). Native Lark qualification is recorded separately in the consuming application's PR; automated platform coverage is not a claim of live Discord/Slack delivery.
