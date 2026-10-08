# Optional checked Lark reactions (candidate)

The `dshIm` Service exposes `reactionVersion: 1` and `reactionChecked(botId, route, kind, options)` in this candidate. A connected Feishu/Lark account advertises `reaction-write-checked`. Other platforms do not implement it. Existing messaging contracts and the qualified BotHarness pin are unchanged.

`kind` is `received` or `answered`, mapped to the official native `GLANCE` and `DONE` emoji types. `route` is the original trusted reply context: message, conversation, actor and optional thread/root/parent IDs. `options` requires `expectedFingerprint`, a synchronous `beforeSend` authorization fence, and optional cancellation `signal`. Success is `{accepted: true}` only after a successful platform response with matching app operator, emoji type and nonempty reaction ID.

The operation requires a current adapter Registration, matching authenticated account, live exclusive external Consumer and connected runtime. It fetches the original message to check conversation/thread/actor and refuses deleted or stale sources. The final caller fence runs before the platform write. The network reaction write does not occupy the account transition queue. Revocation and Consumer disposal cancel in-flight work.

The caller owns durable Admission/reply correspondence, attempt deduplication and a deadline. This Provider never retries the reaction write. Permission refusal is distinct from unknown transport/result; Lark code `231015` (still processing) stays unknown. Creating a reaction needs the app's reviewed reaction-write permission or an existing broader message permission and access to the source conversation. This code does not modify scopes, app subscriptions or credentials.

Real platform permission and rendering qualification are pending a newly authorized Human QA window under [BotHarness #1040](https://github.com/BotHarness/BotHarness/issues/1040). No reaction-read subscription or extra reaction-read permission is needed. The existing source-read permission used by checked replies remains necessary for source validation.

Provider verification:

```sh
npm ci --ignore-scripts
npm run build
node scripts/verify-package.mjs
node --test test/delivery-service.test.mjs test/channels/feishu/external-reactions.test.mjs test/channels/feishu/multi-bot-controller.test.mjs test/channels/feishu/feishu-runtime.test.mjs
```

可选候选通过 checked Service 写入原生 `GLANCE`／`DONE`；调用者负责 Admission／已接受回复对应关系、持久去重与时限。Provider 重查账户、独占 Consumer、Registration、原消息会话／Thread／发送者及最终授权，不自动重试、不扩大权限。平台真实权限与样式仍待 #1040 的新 Human QA 窗口；此候选不是发布或 pin 提升。
