[BotHarness #863](https://github.com/BotHarness/BotHarness/issues/863)

## Why the change

An external Consumer can now post a checked Slack report with its native receipt so the application can associate a Human's subsequent thread reply without mirroring the report into local chat.

## Special things to note

- Merge risk: **two-way door** — revert this commit and restore the previous qualified Provider pin; **medium blast radius** — checked Slack sends and shared delivery Registration cancellation. Review focus: own-account/lease/public-membership fences, exact receipt correspondence and unknown outcomes; an already sent external message remains external.
- Root reports in joined public Slack channels only; no new scopes, standalone Session, self echo intake or automatic retry. Existing legacy proactive sends remain unchanged.
- Full Provider regression: **3,561 passed**, package verification passed. The BotHarness consumer PR will include real Slack/model report and thread follow-up evidence.

## Change outline

```text
sendChecked(account fingerprint + frozen target digest)
  → Slack Controller rechecks authenticated identity and exclusive lease
  → Runtime verifies joined public channel + cancellation/generation
  → chat.postMessage(channel, text, retry:false)
  → receipt {version:1, conversationId:channel, messageId:ts}
```

```diff
- Receipt correspondence assumes Feishu group.route.chatId
+ Feishu group → chatId; Slack conversation → channelId
+ Registration disposal aborts sends waiting in Provider preflight
```

Issue: BotHarness/BotHarness#863
Agent-Task: codex/local/01a0f14c-5338-7020-853b-0fe54b87aa95
Agent-Claim: https://github.com/BotHarness/BotHarness/issues/863#issuecomment-5992078103
