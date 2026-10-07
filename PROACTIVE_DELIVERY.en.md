# Proactive Delivery Guide

[简体中文](PROACTIVE_DELIVERY.md) · **English**

Proactive delivery lets an application send a text message through a bot connected to DSH-IM without waiting for a new user message. The caller stores only a stable `botId + targetId` pair—never a Harness `sessionId`, chat reference, message ID, or temporary webhook.

All nine built-in channels support proactive delivery: Weixin, Feishu, DingTalk, WeCom, QQ, Slack, Telegram, Discord, and WhatsApp.

## Quick start

1. Open **Settings → IM Bot** and find the bot that should send the message.
2. Select the gear icon in the bot card's upper-right corner.
3. Copy the **Bot ID** under **Call identifiers**.
4. Select **New target**, then choose a known conversation or select **Enter manually (advanced)** and enter the platform-native ID.
5. Review or enter the **Target ID**, target type, and native platform ID.
6. Select **Test**. After the target receives `DSH-IM 主动投递测试成功。`, select **Save target**.
7. Select **Copy call parameters** on the saved target and store the resulting `{ botId, targetId }` in the calling application.
8. Send messages through HTTP POST, same-Host `ctx.dshIm.send()`, or the Connection RPC `message.send` endpoint.

## Configure a delivery target

### 1. Get the Bot ID

`botId` is the real call identifier of the currently connected bot. Copy it from the settings page and treat it as an opaque string. Do not infer the channel from its prefix, and do not substitute the bot name, a platform App ID, or a masked ID from a card.

Targets belong to this bot record. Removing a bot also removes its delivery targets. After connecting it again, copy its `botId` again and recreate the required targets.

### 2. Create a target

After selecting **New target**, the page opens a **Choose from conversations** dropdown:

- Suggestions come from conversation mappings already persisted for this bot. They are neither a platform address book nor a complete, strictly time-ordered recent-chat list.
- A suggestion contains only the target type and native platform ID required for delivery. It does not contain a Harness `sessionId`, message text, message ID, conversation name, or last-active time.
- A target already configured in the dropdown is marked **Added** and disabled.
- When the dropdown is empty, send the bot a message on that platform and select **Refresh**. If it still does not appear, use **Enter manually (advanced)**.

Choosing a conversation only pre-fills a draft. It does not save anything automatically.

### 3. Understand Target ID

`targetId` is the stable alias you define for callers. It is not a platform user, group, or channel ID.

- It must be unique only within one bot. Different bots may use the same `targetId`.
- It may contain uppercase and lowercase letters, numbers, dots, underscores, colons, `@`, or hyphens, with a length of 1–128 characters.
- New targets default to `tgt_` plus 16 random hexadecimal characters, such as `tgt_7f3a91c8d2e64b10`.
- You may change it before the first save—for example, to `daily-report` or `release-alerts`.
- After saving, `targetId` is read-only. You may still edit the name, target type, and native route while callers keep using the same `botId + targetId` pair.

### 4. Test, save, and copy

The **Test** button appears in conversation-filled drafts, manually entered drafts, and edit forms:

- It is enabled only while the bot is online and every native ID required by the current target type is present.
- It tests the target type and native ID currently shown in the form. It does not create, update, or save the target first.
- Changing a tested native ID clears the old success result; test the new value again.
- The **Test** button on a saved target row tests that target's currently saved route.
- A successful test means the platform accepted the send request or its SDK returned success. It does not mean the message was read.

After saving, **Copy call parameters** copies JSON in this shape:

```json
{
  "botId": "bot_9577c8572d454122a4ef7fb4d8420a91",
  "targetId": "release-alerts"
}
```

### Configuration example: a Feishu alert group

Assume the Feishu bot has already received a message in the alert group:

1. Open that bot's settings page and copy its **Bot ID**.
2. Select **New target**, then choose the alert group from the dropdown.
3. Change the generated **Target ID** to `release-alerts` and set the display name to `Release alerts`.
4. Confirm that the target type is **Group** and the group Chat ID is filled in.
5. Select **Test** and confirm the test message in the Feishu group.
6. Select **Save target**, then **Copy call parameters**.

If the group Chat ID is edited later, callers can continue using the same `botId + release-alerts` pair.

## Two-way sync for direct-message Sessions

A saved direct-message target has an opt-in **Two-way Session sync** switch. When enabled:

1. User text submitted from DSH Web/CLI to the DM's current Session is sent to the DM with a `[来自 DSH]` prefix.
2. After that turn completes successfully, the final assistant text merged in step order is sent once more with a `[DSH 助手]` prefix.
3. Ordinary IM prompts and `/steer` continue through the existing reply path. They are neither duplicated nor forwarded to another target.
4. Scheduled tasks (`schedule`, `deliveryMode: host`) also sync their final assistant text after successful completion in the bound Session. Internal reminder framing is not echoed as a `[来自 DSH]` message.

The setting stores the private conversation target, never a `sessionId`, so it follows `/session` changes automatically. After `/new` or a workspace change, its status becomes **Waiting for this DM to establish a new Session** and recovers as soon as that DM creates one; the switch does not need to be toggled again.

Enabling requires one uniquely known DM that already has a current Session for this bot. Groups, Slack Threads, Telegram Topics, Discord server channels, and targets that cannot be confirmed as DMs are unavailable. A channel with an explicit remote `harnessBaseUrl` is also unsupported. The first version mirrors current-Host text only—no images, files, cards, tool progress, approvals, or history. Changing the target type or native route disables sync; renaming the target does not.

## Native fields for all nine channels

Choose a known conversation whenever possible. Obtain and enter a platform-native ID manually only when the target is missing from the suggestions.

| Channel | Target type | Required field | Example or note |
| --- | --- | --- | --- |
| Weixin | `user` | Weixin user ID (`toUserId`) | Enter the user ID that should receive messages |
| Feishu | `user` | Open ID (`openId`) | For example, `ou_xxx` |
| Feishu | `group` | Group Chat ID (`chatId`) | For example, `oc_xxx` |
| DingTalk | `user` | User ID (`userId`) | Enter the DingTalk user ID |
| DingTalk | `group` | Group Open Conversation ID (`openConversationId`) | Proactive delivery never uses a temporary `sessionWebhook` |
| WeCom | `user` | User ID (route field: `chatId`) | Enter the user ID for a direct message |
| WeCom | `group` | Group Chat ID (`chatId`) | Enter the group's `chatid` |
| QQ | `user` | User Open ID (`userOpenId`) | The platform's `user_openid` |
| QQ | `group` | Group Open ID (`groupOpenId`) | The platform's `group_openid` |
| Slack | `conversation` | Channel ID (`channelId`) | For example, `C0123456789` |
| Slack | `thread` | Channel ID + thread timestamp (`channelId`, `threadTs`) | For example, `1712345678.123456` |
| Telegram | `chat` | Chat ID (`chatId`) | A decimal string, such as `-1001234567890` |
| Telegram | `topic` | Chat ID + Topic ID (`chatId`, `messageThreadId`) | Topic ID must be a positive integer |
| Discord | `channel` | Channel ID (`channelId`) | DMs, channels, and Threads all use a messageable Channel ID |
| WhatsApp | `user` | User JID (`jid`) | For example, `8613800000000@s.whatsapp.net` |
| WhatsApp | `group` | Group JID (`jid`) | For example, `1234567890-123456@g.us` |

Native ID strings must be nonempty and have no leading or trailing whitespace. A target accepts only the fields required by the selected channel and type; extra fields are rejected.

## Send through HTTP POST

An ordinary external application can call the Host's proactive-delivery endpoint directly:

```bash
curl --request POST \
  http://127.0.0.1:3080/api/dsh-im/delivery/messages \
  --header 'Content-Type: application/json' \
  --data '{
    "botId": "bot_9577c8572d454122a4ef7fb4d8420a91",
    "targetId": "release-alerts",
    "text": "The build has completed."
  }'
```

A successful request returns:

```json
{ "sent": true }
```

The body accepts the required `botId`, `targetId`, and `text` fields, plus optional `format` (`plain` or `markdown`, default `plain`), with a maximum total JSON size of 1 MiB. Do not add a native platform route, `sessionId`, `chatRef`, temporary webhook, or `idempotencyKey`.

The fixed endpoint is `POST /api/dsh-im/delivery/messages`. It reuses the current DSH Host WebServer and does not open another port. Port `3080` is the default for the Web profile; use the address printed by the running Host when it differs.

The HTTP endpoint currently has no authentication and does not provide CORS. Use it only on the local machine or a trusted network; never expose it directly to the public internet.

## Send from a plugin in the same Host

A consumer plugin can declare the `dshIm` injection and call the shared service directly without going through Connection RPC.

This minimal example sends one message when the plugin loads:

```js
export const inject = ['dshIm'];

export async function apply(ctx) {
  const result = await ctx.dshIm.send(
    'bot_9577c8572d454122a4ef7fb4d8420a91',
    'release-alerts',
    'The build has completed.',
  );

  if (result.sent !== true) {
    throw new Error('Proactive delivery did not return success');
  }
}
```

In a real plugin, call `ctx.dshIm.send()` from your existing scheduled job, build callback, or business-event handler. Its optional fourth argument supports an abort signal and a text format:

```js
await ctx.dshIm.send(botId, targetId, text, { signal }); // Keep existing default behavior
await ctx.dshIm.send(botId, targetId, '# Daily report\n\n**Checks complete**', {
  signal,
  format: 'markdown',
});
```

`format` accepts only `plain` and `markdown`, defaulting to `plain`. Markdown formatting is currently implemented for Feishu/Lark: both direct and group destinations receive a native Markdown card without starting a Session or a stream. Other channels retain their existing delivery behavior; Markdown rendering is not guaranteed there. HTTP and `message.send` RPC accept the same optional `format` field in their payloads.

The original Markdown, including whitespace, is preserved without silent truncation or automatic splitting; platform message-size and Markdown-syntax limits still apply. Rejection, timeout, and cancellation use the existing error handling, with no automatic plain-text resend that could duplicate delivery. Older dsh-im Host APIs may ignore this option; both the consumer and dsh-im must load the updated code.

A same-Host plugin may also list the saved targets for one bot:

```js
const targets = await ctx.dshIm.listTargets(botId);
// [{ targetId, name?, kind, route }, ...]
```

Companion plugins can discover configured bots through the same Host service:

```js
const bots = await ctx.dshIm.listBots();
// [{ botId, channel }, ...]
```
The result contains stable public metadata only; it never includes credentials, platform routes, or target data.

On failure, the Promise rejects with an Error whose `code` is one of the public error codes below.

## Send through Connection RPC

Connection RPC is for a caller that already holds a `connection` client for the current DSH Host. The settings page also uses it to manage targets. Ordinary external applications should prefer the HTTP POST endpoint above.

First unwrap the RPC success and error envelopes:

```js
const DELIVERY_CHANNEL = '/dsh-im-delivery';

async function callDelivery(connection, endpoint, payload, signal) {
  const result = await connection.rpc.call(
    DELIVERY_CHANNEL,
    endpoint,
    payload,
    signal,
  );

  if (result?.ok !== true) {
    const error = new Error(result?.error?.message || 'delivery-failed');
    error.code = result?.error?.code || 'delivery-failed';
    throw error;
  }
  return result.value;
}
```

Then send text with the copied `botId + targetId` pair:

```js
const result = await callDelivery(connection, 'message.send', {
  botId: 'bot_9577c8572d454122a4ef7fb4d8420a91',
  targetId: 'release-alerts',
  text: 'The build has completed.',
});

// result: { sent: true }
```

`message.send` accepts `{ botId, targetId, text, format? }`; `format` must be `plain` or `markdown`. Do not add a native route, `sessionId`, `chatRef`, temporary webhook, or `idempotencyKey`.

### Example: deliver a daily report

```js
async function sendDailyReport(connection, summary) {
  try {
    await callDelivery(connection, 'message.send', {
      botId: 'bot_9577c8572d454122a4ef7fb4d8420a91',
      targetId: 'daily-report',
      text: `Daily operations summary\n\n${summary}`,
    });
  } catch (error) {
    if (error.code === 'bot-not-connected') {
      // Let the application decide whether to retry after reconnection.
      return { delivered: false, reason: 'offline' };
    }
    throw error;
  }
  return { delivered: true };
}
```

## Management RPC reference

The settings page manages targets through the same Connection RPC channel. Most callers need only `message.send`; use the other endpoints only when the caller must manage targets itself.

Every response is either `{ ok: true, value }` or `{ ok: false, error: { code, message, details } }`.

| Endpoint | Payload | Successful `value` |
| --- | --- | --- |
| `message.send` | `{ botId, targetId, text }` | `{ sent: true }` |
| `target.list` | `{ botId }` | `{ botId, channel, targets }` |
| `target.suggestion.list` | `{ botId }` | `{ botId, channel, suggestions }` |
| `target.create` | `{ botId, target: { targetId, name?, kind, route } }` | The complete created target |
| `target.update` | `{ botId, targetId, target: { name?, kind, route } }` | The complete updated target |
| `target.delete` | `{ botId, targetId }` | `{ deleted: true }` |
| `target.session-sync.set` | `{ botId, targetId, enabled }` | `{ enabled, state }`; manages DM sync from the local settings UI |
| `target.test` | `{ botId, targetId }` | `{ sent: true }` |
| `target.test` | `{ botId, target: { kind, route } }` | `{ sent: true }`; tests a draft without saving it |

Payloads are validated with exact fields. The inner `target` in `target.update` must not contain `targetId`; a draft test must not contain `targetId` or `name`. Every target returned by `target.list` includes read-only `sessionSync: { enabled, state }`, where `state` is `off`, `active`, `waiting`, or `unavailable`; the internal private-conversation key is never returned to the client.

## Error handling

An HTTP failure returns `{ "error": { "code", "message", "details" } }`. Same-Host and RPC calls use the same error codes without an HTTP status.

| Error code | HTTP status | Meaning and suggested action |
| --- | --- | --- |
| `bad-request` | 400 | Invalid request shape, ID format, JSON, or text; check field names and remove extra fields |
| `unknown-bot` | 404 | The current Host does not own this `botId`; copy it again from bot settings |
| `unknown-target` | 404 | The bot has no such `targetId`; check the copied pair or whether the target was deleted |
| `target-conflict` | 409 | The same bot already has this `targetId`; choose another alias |
| `invalid-target` | 422 | The target type or native ID violates this channel's rules; select the correct type and verify the ID |
| `bot-not-connected` | 503 | The bot is offline; let the caller decide whether to retry after reconnection |
| `target-rejected` | 422 | The platform explicitly rejected the target or the bot lacks permission; check platform permissions and the target ID |
| `delivery-failed` | 502 | A network, platform, or other safely redacted delivery failure; check bot state and Host logs |
| `session-sync-unavailable` | — | The target is not a confirmed current-Host DM, has no current Session, or uses a remote Harness; create it from a known DM and establish a Session first |
| `cancelled` | 408 | The call was cancelled; stop or start a new call as required by the application |

The HTTP protocol layer may also return `method-not-allowed` (405), `unsupported-media-type` (415), or `payload-too-large` (413).

## Delivery semantics and limits

- Proactive delivery currently accepts nonempty text only. This API does not send images, files, cards, or rich content.
- The maximum HTTP JSON request body is 1 MiB.
- `{ sent: true }` means the platform accepted the send request or its SDK returned success. It does not guarantee final delivery or a read receipt.
- DSH-IM stores no proactive-delivery history, generates no `deliveryHandle` or `idempotencyKey`, and performs no automatic retry.
- Retrying after a caller timeout can create duplicate messages. When business idempotency matters, the caller must store its own event ID and processing result.
- Normal delivery uses only a saved `botId + targetId`. Keep the native route in target configuration instead of sending it with every message.
- One call sends to one target. Notify multiple targets with separate calls and handle each result separately.
- Targets remain editable while a bot is offline, but testing and delivery require a connected bot.
- WeChat proactive sends, connection tests, and deferred task results use the latest `context_token` received from the corresponding user by that bot. Context is stored only in the Host account state and restored after restart; it is never included in delivery targets or returned to callers. Rebinding with a different login credential clears it. After upgrading, an inbound user message is needed to populate the cache.
- iLink server rules still govern whether WeChat accepts a send. Healthy long polling does not guarantee proactive delivery. If `ret=-2 prepare failed` persists, avoid repeated heartbeat messages as a renewal strategy; ask the recipient to send a message before retrying. This error alone does not establish login expiry, context expiry, or exhausted quota.

- Failed WeChat proactive sends remain visible in the account’s latest message error, with sanitized diagnostics including the provider code and whether context was included. Healthy polling does not clear this error; a successful outbound send does. HTTP/RPC still return the existing `delivery-failed` error, with no automatic retry or disconnection of healthy long polling.

## HTTP and RPC reachability

The HTTP endpoint is registered only when the current Host provides a WebServer, and it uses that server's existing listen address and port. A Web profile normally defaults to `127.0.0.1:3080`, which is reachable only from the same machine. To call it from another machine, bind the WebServer to a reachable address in that profile's `cordis.patch.yml`, then restart the Host. For example:

```yaml
- id: webserver
  config:
    host: '0.0.0.0'
```

This also expands network reachability for the other pages and routes on that WebServer. Because the proactive-delivery HTTP endpoint currently has no authentication, use it only with a trusted LAN, firewall, or reverse proxy, and never expose it directly to the public internet.

Connection RPC accepts loopback callers by default. If a Web profile is deliberately served on a trusted LAN, it can reuse the existing Host authority in that profile's `cordis.patch.yml`:

```yaml
- id: xmanrui-dsh-im
  config:
    rpcAuthority: trusted-host
```

`trusted-host` is only a Host/Origin reachability boundary, not user authentication. Callers that can reach that trusted-network authority can also access bot-management endpoints. Enable it only on a trusted network.

## Troubleshooting

### The target conversation is missing from the dropdown

Send that bot a message on the platform, return to settings, and refresh. Suggestions are not a complete platform conversation directory. Use **Enter manually (advanced)** if the target still does not appear.

### The Test button is disabled

Make sure the bot is online and every native ID required by the current target type is present. A Slack Thread and a Telegram Topic both require two fields.

### Can Target ID be changed after saving?

No. You can edit its name, type, and native route without changing call parameters. If the alias itself must change, create a new target, migrate callers, and then delete the old target.

### Why not use sessionId?

A `sessionId` identifies a Harness Session. It is not a uniform, stable message address across the nine platforms. Proactive delivery uses the stable bot and saved-target pair instead.

### The test succeeded, but the recipient cannot see the message

A successful test proves only that the platform accepted the send. Check bot permissions, platform restrictions, target accuracy, and client-side filtering or archive settings.

## Checked proactive sending for companion plugins

The same-Host `dshIm` Service exposes `contractVersion: 1`, `describeBot(botId)` and `sendChecked(botId, targetId, text, options)`. The initial authenticated-account implementation supports Feishu/Lark; other channels explicitly report `capability-unavailable` until they implement the contract. Existing `send`, HTTP and management RPC behavior remains unchanged.

`describeBot` returns `{version: 1, botId, channel, account: {fingerprint, name?}, connected, capabilities}`. The `proactive-text-checked` capability is not a user grant. Feishu/Lark resolves credentials through the credentials service and verifies the current platform Bot Open ID. Its lowercase SHA-256 fingerprint is derived from UTF-8 `JSON.stringify({provider:'feishu', domain, appId, botOpenId})` in that field order. It never returns credentials or tokens and rejects a principal different from the configured verified bot. Discovery is asynchronous during Host startup; refresh after channel initialization.

Options require `expectedFingerprint` and `expectedTargetDigest` and optionally accept `signal` and `format`. Derive the target digest from lowercase SHA-256 of UTF-8 `JSON.stringify({kind, route})`, with route keys sorted by ascending JavaScript string code-unit order. Names and aliases do not affect this digest. The service checks the currently saved target, freezes its normalized route, revalidates the authenticated account inside the account transition and sends that frozen route. Editing an alias during verification cannot redirect the request. Removing or changing a target before lookup rejects the request; after a request starts, changes cannot undo its external effect.

`account-unverified`, `account-changed`, `target-changed` and `capability-unavailable` are pre-send refusals. `{sent:true}` still means platform acceptance, not delivery/read. SDK cancellation after start, timeout and other ambiguous outcomes are not proof that nothing was sent. The caller owns durable authorization, intent/attempt records and reconciliation and must not blindly retry. Provider Registration disposal rejects subsequent preflight; it cannot unsend an already started SDK request.

## Checked external source files (temporary qualification)

The additive `dshIm.fileVersion: 1` Service exposes `readSourceFile(botId, route, attachment, options)` and `replyFileChecked(botId, route, file, options)`. Options retain `expectedFingerprint` and `signal`; account description advertises `source-file-checked` and `reply-file-checked`. Legacy text contracts remain version 1.

For an authenticated text mention replying to a file message, the exclusive consumer resolves exactly that parent through the account's SDK and retains `{id,messageId,resourceKey,name}`. It does not fetch arbitrary history or download bytes at receipt. Parent and mention must belong to the same conversation and topic; a later read rechecks the exact original reply route and parent resource association. The resource stream stops on cancellation, account/runtime replacement or 25 MiB of received bytes. The consumer decides canonical persistence and current authorization; these capabilities do not grant access themselves.

A result file is an explicitly selected `{id,name,bytes}` with at most 25 MiB. Checked reply reuses the existing native file uploader and validates the original source again after upload and before replying. The exact source message determines the topic. There is no fallback recipient, original-file replacement or automatic retry after an uncertain result. `file-upload-failed` and explicit `file-provider-rejected` indicate that a message was not accepted; other interrupted or uncertain sends require reconciliation rather than retry. The package remains a temporary Git-qualified artifact, not an upstream release or production enablement.

File metadata is opt-in through `consumeInbound(..., {sourceFiles: true})`; legacy consumers receive their unchanged version 1 text envelope. / 文件元信息通过 `sourceFiles: true` 明确协商，旧 consumer 的文本 envelope 保持原样。

### Personal WeChat paired-owner files

WeChat external-consumer mode accepts an opt-in single native type-4 file, with optional text, only from the QR-paired owner. It retains native decimal message IDs without precision loss. Canonical metadata includes a source-bound opaque resource key, filename, optional declared size and generic MIME type; CDN tickets, AES keys and continuation tokens remain in private source state (1,000 sources / 30 days) and are excluded from public snapshots. Files download lazily through the trusted WeChat CDN with an actual 25 MiB plaintext limit, including ciphertext padding and misleading or missing size headers. A declared oversized file remains inspectable but cannot be downloaded. This is retained source qualification, not a remote history or source reread API.

The account additionally advertises `reply-file-fence-checked`. The caller must pass a synchronous `beforeSend: () => boolean` on `replyFileChecked`; the runtime requires it to return true before preparation and again immediately after encrypted CDN upload, before the final native send. Revocation, account replacement, consumer disposal or missing/expired continuation refuses the final effect. The selected result is sent as a native file in the same paired-owner DM, using that Bot's own identity. An accepted result is a client acknowledgement, not a native server ID, delivery or read proof. An uncertain final send is not retried. Images, voice, video, other contacts, groups and proactive sending are separate qualifications.

## Bounded Feishu/Lark context reads (same Host)

An active exclusive consumer may call the optional `dshIm.historyChecked(botId, source.reply, query, {expectedFingerprint, signal})`. Check `history-text-checked`, and also `thread-history-text-checked` for a thread. Query is `{scope: 'group' | 'nearby' | 'thread', limit: 1..20, cursor?: string}`. There is no browser/HTTP history endpoint. The verified account and live consumer lease are required; standalone accounts cannot read through this contract.

Each call re-fetches the source and compares its author, chat, thread, root and parent IDs before listing. `group` lists the source chat; `nearby` uses a bounded five-minute-before/after chat time window, not a native around-message API; `thread` lists the native thread. The response is `{version:1, scope, events, omitted, hasMore, nextCursor?, window?, coverage:'provider-visible-human-text'}`. At most `limit` provider records are inspected; unsupported, deleted, application-sent or invalid text is counted as omitted. Pagination is explicit, one page per call. The caller binds its continuation to the same source/query. History-derived events use `history:<messageId>` as event ID; deduplicate with the native message ID alongside received events.

Only visible Human text is returned, with the same normalized event shape. Optional platform `sender_name` and mention `name` are display labels, never identity or authorization; missing names remain absent. No directory lookup or Human token fallback is performed. A read does not admit ordinary messages to an Inbox, wake an agent, reply, mark a message read, or synchronize withdrawal. The companion application owns those decisions and canonical persistence.

Missing Bot permissions return `history-permission-denied`; missing/changed source IDs return `stale-route`; an anchor without a thread returns `thread-unavailable`; provider failures or malformed pagination return `history-unavailable`. Unrelated chat/thread records fail with `untrusted-source`. Caller cancellation, consumer release, Host close and Provider replacement discard in-flight results. The consumer must retain its lifetime until the read completes. This capability is neither a complete transcript guarantee nor provider-wide search.

```js
const page = await ctx.dshIm.historyChecked(botId, event.reply,
  { scope: 'thread', limit: 10 },
  { expectedFingerprint: account.account.fingerprint, signal: lifecycleSignal });
// Persist/reconcile only after application authorization. Do not turn reads into intake.
```

### Nearby context count minima

`historyChecked` nearby traverses the five-minute window on each side of the checked source, then supplements sparse sides to `beforeCount` (default 10) and `afterCount` (default 5), each integer 0–20. Counts exclude the anchor and count only supported Human text. Dense windows are never truncated by those minima: callers must follow every `nextCursor` under their own budget. Each request still fetches at most `limit` records. Supplement phases use nearest older / newer Chat listing; second-resolution boundary overlaps are filtered by actual timestamps. No future message is awaited. Cursor count settings and the original anchor cannot change between pages. Existing group and Thread listing is unchanged; this is an application-defined checked contract, not a native around-message API.

### Checked Slack context reads (BotHarness #819)

The exclusive Slack consumer exposes `history-text-checked` and
`thread-history-text-checked` through the same delivery service. Every page checks the
current Bot account fingerprint and consumer lease, joined public channel, and the
exact Human source author/native thread. It uses that Bot's token; Human credentials,
private conversations, arbitrary model-selected channels and historical Inbox admission
are outside this contract.

`historyChecked(botId, route, query, { expectedFingerprint, signal })` accepts
`scope: group | thread | nearby`, `limit: 1..20` and an optional opaque cursor.
Nearby accepts `beforeCount` (default 10) and `afterCount` (default 5), each 0..20.
All supported Human text in the inclusive five-minute window on each side is paginated;
sparse sides supplement the nearest visible messages. Channel history is newest-first;
native thread replies are chronological within each page; time-bounded cursor pages can traverse older chunks. The pinned root is additional to the requested reply count and may repeat, so it is counted once and each request reserves its place. Channel/nearby reads have Slack's channel-history
coverage, not the complete contents of every child thread. Use thread scope for that.

Continuations are signed by the runtime, bound to source/account/query, and invalidated
when it stops. They contain bounded native timestamps/counts, not message bodies or
credentials. Because channel history is newest-first, finding the nearest after-window
messages may return empty continuation pages while scanning towards the boundary; only
at most 20 candidate IDs are retained, and selected messages are re-read before returning.
Each call returns at most 20 events with coverage/omission/continuation evidence. Missing
permissions, source changes, cancellation and stale runtime results fail closed.

Slack API references: [history](https://docs.slack.dev/reference/methods/conversations.history/)
and [replies](https://docs.slack.dev/reference/methods/conversations.replies/).
Provider rate limits still apply; the caller must not assume unlimited history access.


## Checked Slack source files / Slack 原消息附件

An exclusive Slack Consumer explicitly opts in with `sourceFiles: true`. A Human mention
may contain one hosted file belonging to that exact message (not a fabricated parent).
The checked Provider re-reads the current public-channel source and retains only native
file ID, message ID, safe name and optional `sizeBytes` / `mediaType`; private file URLs
stay inside the Provider. Unsupported modes or multiple files refuse in this slice.

`readSourceFile` revalidates own account, current Consumer lease, membership, author,
thread and exact file association, then privately streams `files.info`'s hosted resource.
Declared and actual bytes are bounded to 25 MiB and checked for completeness. Cancellation
or runtime replacement interrupts the read; redirects and untrusted hosts refuse.

`replyFileChecked` uses the native external-upload flow in the original thread. After
preparing bytes, it requalifies the source and runtime immediately before
`files.completeUploadExternal`. Final completion is not automatically retried; malformed
or ambiguous results remain uncertain. App scopes `files:read` / `files:write` require an
explicitly authorized reinstall. This does not subscribe to ordinary, DM or private messages.

Slack 独占 Consumer 通过 `sourceFiles: true` 明确接收一个 hosted 附件。附件属于 @ 原消息，
不制造 parent ID；安全文件身份与可选大小／类型进入上层，私有 URL 仅在 Provider 内部使用。
读取与发送复查自身账号、lease、群成员资格、发送人、原生话题和文件关联。下载最多 25 MiB，
校验实际大小，拒绝跳转；连接停止或授权撤销取消下载。文件完成上传可见前再次验证来源，
不盲目重试结果不明的完成请求。文件权限须单独授权后重新安装，普通／私聊／私有频道收件不变。

## Ordinary Slack channel text (BotHarness #837)

The checked Slack account advertises `ordinary-text-consumer`. An exclusive Consumer
can opt in with `ordinaryText: true`; the default remains false. Fresh Human
`message` events with `channel_type: channel` use the same account, App, joined-public-
channel and current-lease checks as mentions. Consumer acceptance still precedes ACK.
This requires the App's `message.channels` Bot event subscription under the existing
`channels:history` scope. BotHarness separately controls each explicitly authorized
channel's collection and existing count/time or immediate wake policy.

Own mentions observed through `message.channels` are discarded here and delivered only
through `app_mention`, avoiding duplicate canonical intake. Bot/self messages, private/DM
events, edits/deletions, other subtypes and ordinary file shares are excluded. No new
Session, message store, scheduler, historical backfill or automatic reply is introduced.
Stopping/disposal removes the opt-in; standalone consumers retain their previous path.

Slack 账号提供 `ordinary-text-consumer`，独占 Consumer 通过 `ordinaryText: true`
明确启用普通文字投递，默认关闭。仅接收已加入公开频道的实时 Human 文字，复用账号、App、
lease 与收件确认检查；应用需订阅 `message.channels`，使用已有 `channels:history` 权限。
BotHarness 仍按明确授权的频道分别控制收件与现有数量／时间汇总或逐条唤醒。自己的 @
只走 `app_mention`，不因两种订阅重叠而重复收件；不接收私聊、私有频道、Bot 回显、
编辑／撤回或普通文件分享。无新 Session、队列、历史补收或强制回复，lease 释放撤销 opt-in。

## Checked Discord source file and original-location result (development candidate)

Discord adds `source-file-checked` and `reply-file-checked` only to its verified exclusive consumer. With `sourceFiles: true`, one directly mentioned Human message in a guild text channel or existing public thread carries one hosted attachment's safe `{id,messageId,resourceKey,name,sizeBytes,mediaType?}` metadata. Multiple/ephemeral/malformed or over-20-MiB files refuse; signed URLs stay private. Legacy consumers retain their text envelope. Message Content remains unnecessary for this directly mentioned source; this does not enable ordinary file intake or image vision.

Reading re-fetches that exact original message, matches all retained metadata and downloads its refreshed signed HTTPS CDN attachment route without Bot credentials or redirects. Cancellation/current lease and declared/actual byte checks bound the stream to 20 MiB. The consumer owns canonical persistence and Workspace Grant authorization.

A selected new result of at most 20 MiB rechecks native source identity, parent/thread ancestry and VIEW_CHANNEL, READ_MESSAGE_HISTORY, SEND_MESSAGES(_IN_THREADS) and ATTACH_FILES. The Host `beforeSend` fence runs before one non-retrying multipart request with `fail_if_not_exists=true`. Native author/channel/original-message reference and attachment identity/name/size must match the returned receipt. Definite rejection differs from `reply-result-unknown`; never blindly retry unknown results. The result stays in the original native channel/thread with no fallback or new thread. This candidate does not promote a product pin or publish a release. Qualification: [BotHarness #1002](https://github.com/BotHarness/BotHarness/issues/1002).

## Ordinary Discord guild text (BotHarness #1012)

The checked Discord account advertises `ordinary-text-consumer`. An exclusive Consumer
opts in with `ordinaryText: true` (default false). At connection time the verified native
Application must allow Message Content (`GATEWAY_MESSAGE_CONTENT` or its LIMITED flag);
only then does this external runtime request Gateway `MESSAGE_CONTENT`. With approval
OFF or opt-in absent it requests only GUILDS and GUILD_MESSAGES, retaining direct mentions.
Approval is read again before admitting each unmentioned text, with current identity,
runtime and lease checks. Native rejection does not fall back to standalone processing.

Only fresh, nonempty Human text in a guild text channel or existing public thread is
normalized; the native parent channel, child thread, author and `mentionedAccount` are
retained. Bot/self/webhook messages, DM, private/unsupported channels and empty content
are excluded. Ordinary attachment resources are not promoted into the mentioned-file
capability. The companion application still owns explicit per-channel grants, collection,
canonical Inbox admission, deduplication and count/time harvest; capability discovery is
not proof of actual ordinary delivery or authority to enable new native access.

Discord 普通文字需要独占 Consumer 明确选择 `ordinaryText: true`，并且当前原生 App 已授权
Message Content；关闭时保留直接 @，不请求该特权 Intent。每条非 @ 文字再次检查 App 身份、
权限、runtime 和 lease，仅支持群文字频道及已有公开 thread 的非空 Human 文字。
保留原生发送人／频道／thread，不创建会话或转发到其他位置，普通附件不会获得 @ 文件能力。
BotHarness 仍拥有逐频道授权、收集范围、Inbox 与数量／时间唤醒；需真实普通消息证明可投递。

Native references: [Gateway intents](https://github.com/discord/discord-api-docs/blob/main/developers/events/gateway.mdx)
and [Application flags](https://github.com/discord/discord-api-docs/blob/main/developers/resources/application.mdx).
