# Checked QQ ordinary group text

This candidate extends the official QQ external consumer with ordinary text. It uses the same authenticated app, exclusive consumer and checked inbound Service. It does not run a standalone Harness bridge alongside that consumer.

The software capability `ordinary-text-consumer` means that the Provider can normalize a native `GROUP_MESSAGE_CREATE`. It does not prove that a particular QQ application has receive-all permission or that its current receiver delivered an ordinary event. The consuming application must qualify a fresh native event on its current lease and keep its collection preference separate from that proof.

## Contract

`consumeInbound(botId, { expectedFingerprint, onEvent, signal, ordinaryText })` accepts `ordinaryText: true`; the default is false. The flag belongs to the exclusive receiver entry and stops being effective when that entry is disposed. A replacement receiver does not reuse an old callback's authority.

A native text-only group event retains its application-scoped group, member, message identity and timestamp. A strict native self mention remains `mentionedAccount: true`. An eligible ordinary message is `mentionedAccount: false`; other members' mentions do not turn it into a direct request. Known robot senders and the authenticated robot's own sender ID are excluded. This slice does not add own-echo qualification or ordinary image/file/voice/quote intake.

Checked source reply qualification remains limited to addressed sources. An ordinary source is observation context, and its `qualifyReplyChecked` returns `capability-unavailable`. An intentional group contribution uses the separately authorized checked proactive path, including current identity, final fence and native receipt. Receiving content does not itself grant external speech.

## Qualification

Public-service regressions cover consumer opt-in/default-off, original attribution, source-reply refusal, strict self-mention semantics, own/bot exclusions and stale/disposed receivers. Existing QQ media and native-post regressions remain in the same suite.

The consuming BotHarness slice is [#1155](https://github.com/BotHarness/DeepSeekBot/issues/1155), with shared posting from [#1154](https://github.com/BotHarness/DeepSeekBot/issues/1154). Its real non-mentioned event, actual Client opt-in, ordinary-context understanding and one intentional own-app contribution still require native acceptance. No fixture, documentation statement or stored old capability substitutes for that acceptance. No remote group-history support or personal-account fallback is introduced.
