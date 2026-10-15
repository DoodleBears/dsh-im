# Checked QQ ordinary group text

The production Controller factory must carry the dynamic `ordinaryText` accessor into `QqRuntime`, as well as the Controller and Runtime classes themselves. The production-entry regression exercises `createProductionController` → public Delivery Service → actual Runtime intake; constructing Runtime directly does not qualify this wiring. A real unmentioned plain-text event exposed this missing factory argument during candidate QA; that failed event is not counted as successful qualification or replayed into canonical collection.

This candidate extends the official QQ external consumer with ordinary text. It uses the same authenticated app, exclusive consumer and checked inbound Service. It does not run a standalone Harness bridge alongside that consumer.

The software capability `ordinary-text-consumer` means that the Provider can normalize a native `GROUP_MESSAGE_CREATE`. It does not prove that a particular QQ application has receive-all permission or that its current receiver delivered an ordinary event. The consuming application must qualify a fresh native event on its current lease and keep its collection preference separate from that proof.

## Contract

`consumeInbound(botId, { expectedFingerprint, onEvent, signal, ordinaryText })` accepts `ordinaryText: true`; the default is false. The flag belongs to the exclusive receiver entry and stops being effective when that entry is disposed. A replacement receiver does not reuse an old callback's authority.

A native text-only group event retains its application-scoped group, member, message identity and timestamp. A strict native self mention remains `mentionedAccount: true`. An eligible ordinary message is `mentionedAccount: false`; other members' mentions do not turn it into a direct request. Known robot senders and the authenticated robot's own sender ID are excluded. This slice does not add own-echo qualification or ordinary image/file/voice/quote intake.

Checked source reply qualification remains limited to addressed sources. An ordinary source is observation context, and its `qualifyReplyChecked` returns `capability-unavailable`. An intentional group contribution uses the separately authorized checked proactive path, including current identity, final fence and native receipt. Receiving content does not itself grant external speech.

## Qualification

Public-service regressions cover consumer opt-in/default-off, original attribution, source-reply refusal, strict self-mention semantics, own/bot exclusions and stale/disposed receivers. Existing QQ media and native-post regressions remain in the same suite.

The consuming BotHarness slice is [#1155](https://github.com/BotHarness/DeepSeekBot/issues/1155), with shared posting from [#1154](https://github.com/BotHarness/DeepSeekBot/issues/1154). Its [2026-10-15 native record](https://github.com/BotHarness/DeepSeekBot/blob/1a33b6e1ffb1ec5642a0c580577e47be7b3f0e33/docs/research/2026-10-15-qq-ordinary-native-qualification.md) qualifies this maintained Runtime at immutable source `beaed4a6`: fresh non-mentioned QQ delivery, actual Client opt-in, timed harvest, reading two real local Sources, one scheduled own-App contribution and collection-off exclusion. The Human confirmed exactly one correct original-group summary and fresh normal replies after restoration. This is maintained-runtime qualification; upstream integration and product-package qualification remain separate. No fixture, documentation statement or stored old capability substitutes for native acceptance. No remote group-history support or personal-account fallback is introduced.
