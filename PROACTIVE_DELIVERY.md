# 主动投递使用指南

**简体中文** · [English](PROACTIVE_DELIVERY.en.md)

主动投递让应用在没有用户新消息的情况下，通过已经接入 DSH-IM 的机器人发送文字消息。调用方只需保存一组稳定的 `botId + targetId`，不需要保存 Harness `sessionId`、聊天引用、消息 ID 或临时 Webhook。

九个内置渠道均支持主动投递：微信、飞书、钉钉、企业微信、QQ、Slack、Telegram、Discord 和 WhatsApp。

## 快速开始

1. 打开「设置 → IM机器人」，找到需要发消息的机器人。
2. 点击机器人卡片右上角的齿轮图标。
3. 在「调用标识」中复制 `Bot ID`。
4. 点击「新建目标」，从已聊会话中选择，或点击「手动填写（高级）」填写平台原生 ID。
5. 填写或确认 `Target ID`、目标类型和平台原生 ID。
6. 点击「测试」。目标收到 `DSH-IM 主动投递测试成功。` 后，再点击「保存目标」。
7. 在已保存目标上点击「复制调用参数」，得到可供应用保存的 `{ botId, targetId }`。
8. 使用 HTTP POST、同 Host 的 `ctx.dshIm.send()` 或 Connection RPC 的 `message.send` 发送消息。

## 配置投递目标

### 1. 获取 Bot ID

`botId` 是当前已接入机器人的真实调用标识。请从设置页复制并将它视为不透明字符串，不要根据前缀推断渠道，也不要使用机器人名称、平台 App ID 或卡片中的脱敏 ID 代替。

目标配置跟随当前机器人保存。移除机器人时，它的投递目标也会被清理；重新接入后应重新复制 `botId` 并配置目标。

### 2. 新建目标

点击「新建目标」后，默认显示「从已聊过的会话选择」下拉框：

- 候选来自该机器人已经持久化的会话映射，不是平台通讯录，也不是严格按时间排序的完整最近会话列表。
- 候选只包含投递所需的目标类型和平台原生 ID，不包含 Harness `sessionId`、消息正文、消息 ID、会话名称或最后活跃时间。
- 已配置的相同目标会显示「已添加」并禁用。
- 没有候选时，先在对应平台与机器人聊一条消息，再点击「刷新」。仍未出现时可使用「手动填写（高级）」。

选择候选只会预填表单，不会自动保存。

### 3. 理解 Target ID

`targetId` 是你为调用方定义的稳定别名，不是平台用户 ID、群 ID 或频道 ID。

- 它只需在同一个机器人下唯一；不同机器人可以使用相同的 `targetId`。
- 可使用大小写字母、数字、点、下划线、冒号、`@` 或连字符，长度为 1–128 个字符。
- 新建时页面默认生成 `tgt_` 加 16 位十六进制随机串，例如 `tgt_7f3a91c8d2e64b10`。
- 首次保存前可以修改，例如改成 `daily-report` 或 `release-alerts`。
- 保存后 `targetId` 不可修改，但名称、目标类型和平台原生路由可以修改；调用方仍使用原来的 `botId + targetId`。

### 4. 测试、保存和复制

从会话新建、手动新建和编辑目标时，表单底部都会显示「测试」按钮：

- 机器人在线且当前目标所需的平台 ID 已填写完整时，测试按钮才可用。
- 测试使用当前表单中的目标类型和平台 ID，不会先创建、更新或保存目标。
- 修改测试过的平台 ID 后，旧的成功提示会清除，需要重新测试。
- 已保存目标列表中的「测试」按钮测试该目标当前保存的路由。
- 测试成功表示平台发送接口已接受请求或 SDK 成功返回，不代表消息已经被阅读。

保存后点击「复制调用参数」，页面会复制如下 JSON：

```json
{
  "botId": "bot_9577c8572d454122a4ef7fb4d8420a91",
  "targetId": "release-alerts"
}
```

### 配置示例：飞书告警群

假设飞书机器人已经在告警群中收到过消息：

1. 打开该机器人的设置页并复制 `Bot ID`。
2. 点击「新建目标」，在下拉框中选择告警群。
3. 将自动生成的 `Target ID` 改为 `release-alerts`，显示名称填为「发布告警群」。
4. 确认目标类型为「群聊」，群 Chat ID 已自动填入。
5. 点击「测试」，到飞书群中确认测试消息。
6. 点击「保存目标」，再点击「复制调用参数」。

以后即使编辑并更换群 Chat ID，调用方仍可继续使用同一组 `botId + release-alerts`。

## 私聊会话双向同步

已保存的私聊目标可以在目标行开启「会话双向同步」，默认关闭。开启后：

1. DSH Web／CLI 向该私聊当前绑定的 Session 提交的用户文字，会以 `[来自 DSH]` 开头发送到私聊。
2. 该 Turn 成功完成后，按 step 合并的最终助手文字会以 `[DSH 助手]` 开头再发送一次。
3. IM 用户自己的普通提问和 `/steer` 仍走原回复链，不会被同步逻辑重复发送或转发给其他目标。
4. 定时任务（`schedule`、`deliveryMode: host`）在绑定 Session 中成功完成后，也会同步最终助手文字；内部提醒提示不会以 `[来自 DSH]` 消息回显到私聊。

开关只保存私聊目标，不保存 `sessionId`，因此会自动跟随 `/session` 切换。执行 `/new` 或切换工作区后，状态暂时显示「等待该私聊建立新会话」；该私聊下一次建立 Session 后自动恢复，无需重新开关。

开启要求目标来自该机器人已经聊过、已有当前 Session 的唯一私聊。群聊、Slack Thread、Telegram Topic、Discord 服务器频道和其他无法确认是私聊的目标显示为不可用。显式配置了远程 `harnessBaseUrl` 的渠道也不支持；首版仅同步当前 Host 的文字，不同步图片、文件、卡片、工具过程、审批或历史消息。修改目标类型或平台路由会自动关闭同步，改名不会。

## 九渠道手动填写字段

优先从已聊会话中选择。只有目标未出现在候选中时，才需要手动取得以下平台原生 ID。

| 渠道 | 目标类型 | 需要填写的字段 | 示例或说明 |
| --- | --- | --- | --- |
| 微信 | `user` | 微信用户 ID（`toUserId`） | 填写接收消息的微信用户 ID |
| 飞书 | `user` | Open ID（`openId`） | 例如 `ou_xxx` |
| 飞书 | `group` | 群 Chat ID（`chatId`） | 例如 `oc_xxx` |
| 钉钉 | `user` | 用户 ID（`userId`） | 填写钉钉用户 ID |
| 钉钉 | `group` | 群 Open Conversation ID（`openConversationId`） | 主动投递不使用临时 `sessionWebhook` |
| 企业微信 | `user` | 用户 ID（路由字段为 `chatId`） | 私聊填写用户 ID |
| 企业微信 | `group` | 群 Chat ID（`chatId`） | 群聊填写群 `chatid` |
| QQ | `user` | 用户 Open ID（`userOpenId`） | 平台提供的 `user_openid` |
| QQ | `group` | 群 Open ID（`groupOpenId`） | 平台提供的 `group_openid` |
| Slack | `conversation` | Channel ID（`channelId`） | 例如 `C0123456789` |
| Slack | `thread` | Channel ID + Thread 时间戳（`channelId`, `threadTs`） | 例如 `1712345678.123456` |
| Telegram | `chat` | Chat ID（`chatId`） | 十进制字符串，例如 `-1001234567890` |
| Telegram | `topic` | Chat ID + Topic ID（`chatId`, `messageThreadId`） | Topic ID 必须是正整数 |
| Discord | `channel` | Channel ID（`channelId`） | 私信、频道和 Thread 都使用可发消息的 Channel ID |
| WhatsApp | `user` | 用户 JID（`jid`） | 例如 `8613800000000@s.whatsapp.net` |
| WhatsApp | `group` | 群 JID（`jid`） | 例如 `1234567890-123456@g.us` |

平台 ID 字符串不能为空或带首尾空格。一个目标只接受所选渠道和类型要求的字段，额外字段会被拒绝。

## 通过 HTTP POST 发送

普通外部应用可以直接调用 Host 的主动投递接口：

```bash
curl --request POST \
  http://127.0.0.1:3080/api/dsh-im/delivery/messages \
  --header 'Content-Type: application/json' \
  --data '{
    "botId": "bot_9577c8572d454122a4ef7fb4d8420a91",
    "targetId": "release-alerts",
    "text": "构建已经完成。"
  }'
```

成功返回：

```json
{ "sent": true }
```

请求体接受必填的 `botId`、`targetId`、`text` 和可选的 `format`（`plain` 或 `markdown`，默认 `plain`），JSON 总大小不能超过 1 MiB。不要附加平台原生路由、`sessionId`、`chatRef`、临时 Webhook 或 `idempotencyKey`。

接口路径固定为 `POST /api/dsh-im/delivery/messages`，复用当前 DSH Host 的 WebServer，不会另开端口。示例中的 `3080` 是 Web profile 的默认端口；实际地址以 Host 启动时显示的地址为准。

当前 HTTP 接口不包含鉴权，也不提供 CORS。只应在本机或可信网络中使用，不要直接暴露到公网。

## 在同一 Host 的插件中发送

消费插件声明 `dshIm` 注入后，可以直接调用共享服务，不经过 Connection RPC。

下面是一个最小示例；插件加载时会发送一次消息：

```js
export const inject = ['dshIm'];

export async function apply(ctx) {
  const result = await ctx.dshIm.send(
    'bot_9577c8572d454122a4ef7fb4d8420a91',
    'release-alerts',
    '构建已经完成。',
  );

  if (result.sent !== true) {
    throw new Error('主动投递没有返回成功结果');
  }
}
```

实际使用时，把 `ctx.dshIm.send()` 放进你的定时任务、构建回调或业务事件处理函数中。可选的第四个参数支持取消信号和文本格式：

```js
await ctx.dshIm.send(botId, targetId, text, { signal }); // 保持原有默认发送行为
await ctx.dshIm.send(botId, targetId, '# 每日报告\n\n**检查完成**', {
  signal,
  format: 'markdown',
});
```

`format` 只接受 `plain` 和 `markdown`，省略时为 `plain`。当前 Markdown 格式适配用于飞书/Lark：私聊和群聊均通过原生 Markdown 卡片发送，不启动会话或流式输出；其他渠道保留原有发送行为，不保证 Markdown 渲染。HTTP 和 `message.send` RPC 可在请求体中添加同名 `format` 字段。

Markdown 原文（含换行）完整传递，不进行静默截断或自动分段；消息仍受平台大小和 Markdown 语法限制。平台拒绝、超时或取消时沿用已有错误处理，不自动回退成纯文本重发，以免重复投递。旧版本 dsh-im 的 Host API 可能忽略这个新选项；调用方与 dsh-im 都需要加载支持该选项的代码。

同 Host 插件也可以列出某个机器人的已保存目标：

```js
const targets = await ctx.dshIm.listTargets(botId);
// [{ targetId, name?, kind, route }, ...]
```

同 Host 插件可以通过同一个服务发现已配置机器人：

```js
const bots = await ctx.dshIm.listBots();
// [{ botId, channel }, ...]
```
返回值只包含稳定的公开元数据，不包含凭据、平台路由或目标内容。

调用失败时 Promise 会拒绝，`error.code` 使用本文后面的公共错误码。

## 通过 Connection RPC 发送

Connection RPC 适合已经持有当前 DSH Host `connection` 客户端的调用方，也是设置页管理目标所使用的接口。普通外部应用优先使用上面的 HTTP POST。

先封装 RPC 成功与错误包络：

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

然后使用已复制的 `botId + targetId` 发送文字：

```js
const result = await callDelivery(connection, 'message.send', {
  botId: 'bot_9577c8572d454122a4ef7fb4d8420a91',
  targetId: 'release-alerts',
  text: '构建已经完成。',
});

// result: { sent: true }
```

`message.send` 接受 `{ botId, targetId, text, format? }`；`format` 只允许 `plain` 或 `markdown`。不要附加平台路由、`sessionId`、`chatRef`、临时 Webhook 或 `idempotencyKey`。

### 示例：投递每日报告

```js
async function sendDailyReport(connection, summary) {
  try {
    await callDelivery(connection, 'message.send', {
      botId: 'bot_9577c8572d454122a4ef7fb4d8420a91',
      targetId: 'daily-report',
      text: `今日运行摘要\n\n${summary}`,
    });
  } catch (error) {
    if (error.code === 'bot-not-connected') {
      // 等待机器人恢复连接后，由业务决定是否重试。
      return { delivered: false, reason: 'offline' };
    }
    throw error;
  }
  return { delivered: true };
}
```

## 管理 RPC 参考

设置页使用同一个 Connection RPC 通道管理目标。普通调用方通常只需要 `message.send`；需要自行管理目标时再使用其他端点。

所有响应均为 `{ ok: true, value }` 或 `{ ok: false, error: { code, message, details } }`。

| 端点 | Payload | 成功时的 `value` |
| --- | --- | --- |
| `message.send` | `{ botId, targetId, text }` | `{ sent: true }` |
| `target.list` | `{ botId }` | `{ botId, channel, targets }` |
| `target.suggestion.list` | `{ botId }` | `{ botId, channel, suggestions }` |
| `target.create` | `{ botId, target: { targetId, name?, kind, route } }` | 已创建的完整目标 |
| `target.update` | `{ botId, targetId, target: { name?, kind, route } }` | 更新后的完整目标 |
| `target.delete` | `{ botId, targetId }` | `{ deleted: true }` |
| `target.session-sync.set` | `{ botId, targetId, enabled }` | `{ enabled, state }`；仅供本机设置页管理私聊同步 |
| `target.test` | `{ botId, targetId }` | `{ sent: true }` |
| `target.test` | `{ botId, target: { kind, route } }` | `{ sent: true }`；测试草稿，不保存 |

接口严格校验字段。`target.update` 的内部 `target` 不能包含 `targetId`；草稿测试不能包含 `targetId` 或 `name`。`target.list` 返回的每个目标带只读 `sessionSync: { enabled, state }`，其中 `state` 为 `off`、`active`、`waiting` 或 `unavailable`；内部私聊键不会返回客户端。

## 错误处理

HTTP 失败响应格式为 `{ "error": { "code", "message", "details" } }`。同 Host 和 RPC 使用相同错误码，但没有 HTTP 状态码。

| 错误码 | HTTP 状态 | 含义与处理建议 |
| --- | --- | --- |
| `bad-request` | 400 | 请求结构、ID 格式、JSON 或文字无效；检查字段名并移除额外字段 |
| `unknown-bot` | 404 | `botId` 不属于当前 Host；重新从机器人设置页复制 |
| `unknown-target` | 404 | 该机器人下不存在 `targetId`；检查是否复制错误或目标已被删除 |
| `target-conflict` | 409 | 同一机器人下已经存在相同 `targetId`；更换别名 |
| `invalid-target` | 422 | 目标类型或平台原生 ID 不符合当前渠道规则；重新选择类型并核对 ID |
| `bot-not-connected` | 503 | 机器人当前离线；恢复连接后由调用方决定是否重试 |
| `target-rejected` | 422 | 平台明确拒绝目标或机器人缺少发送权限；检查平台权限和目标 ID |
| `delivery-failed` | 502 | 网络、平台或其他无法安全细分的发送失败；检查连接状态和 Host 日志 |
| `session-sync-unavailable` | — | 目标不是可确认的当前 Host 私聊，尚无当前 Session，或渠道使用远程 Harness；先从已聊私聊创建目标并建立 Session |
| `cancelled` | 408 | 调用被取消；按业务需要结束或重新发起 |

HTTP 协议层还可能返回 `method-not-allowed`（405）、`unsupported-media-type`（415）或 `payload-too-large`（413）。

## 投递语义与限制

- 当前主动投递只发送非空文字，不支持在该接口中发送图片、文件、卡片或富文本。
- HTTP JSON 请求体上限为 1 MiB。
- `{ sent: true }` 表示平台发送接口接受请求或 SDK 成功返回，不承诺最终送达或已读。
- DSH-IM 不保存主动投递历史，不生成 `deliveryHandle` 或 `idempotencyKey`，也不自动重试。
- 调用方超时后重试可能产生重复消息；需要业务幂等时，由调用方保存自己的业务事件 ID 和处理结果。
- 正式发送只使用已保存的 `botId + targetId`。平台原生路由保存在目标配置中，不应随每次消息发送。
- 一个调用只发送到一个目标。需要通知多个目标时，应分别调用并分别处理结果。
- 机器人离线时仍可编辑目标，但不能测试或主动发送。
- 微信主动投递、连接测试和延迟任务结果会使用该机器人最近收到的对应用户 `context_token`。上下文仅保存在 Host 的账号状态中，重启后恢复，不放进投递目标或返回给调用方；重新绑定并更换登录凭据后清理。升级后需要收到一次用户消息才能建立缓存。
- 微信是否接受发送仍受 iLink 服务端规则约束。长轮询在线不保证主动发送可用；若持续出现 `ret=-2 prepare failed`，不要通过反复发送心跳尝试续期。可让目标用户发一条消息后重试；这不是登录凭据失效的确定证据，也不能仅凭此错误确定上下文过期或额度耗尽。

- 微信主动发送失败会保留在账号的最近消息错误中，包含平台错误码和是否携带上下文等脱敏诊断；健康轮询不会清除此错误，后续成功投递会清除。HTTP/RPC 仍返回既有的 `delivery-failed`，不会自动重试或断开正常的长轮询连接。

## HTTP 与 RPC 可达范围

HTTP 接口只在当前 Host 提供 WebServer 时注册，并使用同一个监听地址和端口。默认 Web profile 地址通常是 `127.0.0.1:3080`，只能由本机访问。若要从其他机器调用，需要在对应 profile 的 `cordis.patch.yml` 中把 WebServer 绑定到可达地址并重启 Host，例如：

```yaml
- id: webserver
  config:
    host: '0.0.0.0'
```

这会同时扩大该 WebServer 上其他页面和路由的网络可达范围。当前主动投递 HTTP 接口没有鉴权，因此只能配合可信局域网、防火墙或反向代理使用，不能直接暴露到公网。

Connection RPC 默认只允许当前 Host 的回环调用。若 Web profile 明确运行在受信任局域网，可在该 profile 的 `cordis.patch.yml` 中复用现有 Host authority：

```yaml
- id: xmanrui-dsh-im
  config:
    rpcAuthority: trusted-host
```

`trusted-host` 只是 Host／Origin 可达性边界，不是用户认证。启用后，能访问该受信网络 authority 的调用方也能访问机器人管理接口；只应在可信网络中使用。

## 常见问题

### 下拉框找不到目标会话

先在对应平台向该机器人发送一条消息，再返回设置页刷新。候选不是平台的完整会话目录；仍然找不到时使用「手动填写（高级）」。

### 测试按钮不可点击

确认机器人在线，并填写当前目标类型要求的全部平台原生 ID。Slack Thread 和 Telegram Topic 都需要两个字段。

### 保存后能否修改 Target ID

不能。你可以编辑名称、类型和平台路由而保持调用参数不变；若必须更换 `targetId`，请新建目标并让调用方切换后再删除旧目标。

### 为什么不用 sessionId

`sessionId` 标识 Harness 会话，不是九个平台统一、稳定的消息投递地址。主动投递只使用机器人和已保存目标的稳定组合。

### 测试成功但对方没有看到消息

测试成功只证明平台接口接受发送。请继续检查机器人权限、平台限制、目标是否正确，以及客户端侧的消息过滤或归档设置。

## Companion Plugin 的条件主动发送

same-Host `dshIm` Service 新增 `contractVersion:1`、`describeBot(botId)` 和 `sendChecked(botId,targetId,text,options)`。首版认证账号实现只支持飞书/Lark；其他渠道在实现此契约前明确返回 `capability-unavailable`。现有 `send`、HTTP 与管理 RPC 不变。

`describeBot` 返回 `{version:1,botId,channel,account:{fingerprint,name?},connected,capabilities}`；`proactive-text-checked` capability 不是用户授权。飞书/Lark 通过 credentials service 解析凭据，并向平台验证当前 Bot Open ID。fingerprint 为按固定字段顺序 `JSON.stringify({provider:'feishu',domain,appId,botOpenId})` 的 UTF-8 小写 SHA-256，不返回凭据或 token；平台身份与已配置的 verified bot 不同则拒绝。Host 启动时账号异步初始化，需要后续刷新 discovery。

options 必须包含 `expectedFingerprint`、`expectedTargetDigest`，可选 `signal`、`format`。目标 digest 为 `JSON.stringify({kind,route})` 的 UTF-8 小写 SHA-256，route keys 按 JavaScript 字符串 code-unit 升序排列；名称和 alias 不参与。发送检查当前 saved target，冻结规范化 route，再在账号 transition 内重新验证认证身份后使用此 route；验证期间编辑 alias 不会改投。lookup 前删除或改址会拒绝；请求已经开始后，修改不能撤销外部效果。

`account-unverified`、`account-changed`、`target-changed`、`capability-unavailable` 是发送前拒绝。`{sent:true}` 仍只代表平台接受，不代表送达/已读。SDK 开始后的取消、超时和含糊失败不能证明没有发送；调用者持有 durable authorization／intent／attempt 与 reconciliation，不得盲重试。Provider Registration 撤销阻止后续 preflight，但不能撤回已开始的 SDK 请求。

## 经校验的外部来源文件（临时验证契约）

增量的 `dshIm.fileVersion: 1` Service 提供 `readSourceFile(botId, route, attachment, options)` 与 `replyFileChecked(botId, route, file, options)`；选项沿用 `expectedFingerprint` 与 `signal`，账号声明 `source-file-checked` 和 `reply-file-checked` 能力。现有文本契约仍为 version 1。

对回复文件消息的真实文本 @，独占 consumer 仅使用该账号 SDK 查询准确父消息，保留 `{id,messageId,resourceKey,name}`。收到消息时不下载正文，不读取任意历史。下载前重新核对原回复路线和父消息资源关联；同一会话／话题、当前账号、取消和 25 MiB 实际字节上限均受校验。能力自身不授予权限，canonical 持久化和即时授权仍由 consumer 负责。

结果使用明确选择的 `{id,name,bytes}`。沿用原生文件上传器，上传后、实际发送前重新核对原来源，只回复准确原话题，不改远端原件、不回退到其他目标、不自动重试不确定结果。上传失败或明确平台拒绝会给出未被接受的结果；中断／不确定发送需核实后再决策。本包仍是临时 Git 验证 artifact，并非上游发布或生产启用。

File metadata is opt-in through `consumeInbound(..., {sourceFiles: true})`; legacy consumers receive their unchanged version 1 text envelope. / 文件元信息通过 `sourceFiles: true` 明确协商，旧 consumer 的文本 envelope 保持原样。

### 个人微信扫码者文件

微信 external-consumer 模式通过 `sourceFiles: true` 接收扫码绑定者的一份原生 type-4 文件，可同时带文字；原生十进制消息 ID 不丢精度。公开元数据仅含来源绑定的不可解释资源键、文件名、可选声明大小和通用 MIME。CDN 票据、AES 密钥及回复续接信息保留在私有来源状态（1,000 条／30 天），不出现在公开快照。下载通过受信任的微信 CDN 惰性解密，按实际字节限制 25 MiB 明文，考虑密文填充及错误或缺失的大小头。声明超限文件仍可查看元数据，但不能下载。这是保留来源校验，不是远端历史或重读 API。

账号还声明 `reply-file-fence-checked`；调用 `replyFileChecked` 时必须提供同步的 `beforeSend: () => boolean`。运行时在准备前和加密 CDN 上传后、原生最终发送前都要求其返回 true。撤销授权、账号替换、Consumer 释放或续接信息失效会拒绝最终发送。选中的结果以原生文件使用 Bot 自己的身份回复同一扫码者私聊。平台接受仍只表示客户端确认，不是原生服务端 ID、送达或已读证明；最终发送结果不确定时不自动重试。图片、语音、视频、其他联系人、群和主动发送独立资格验证。

## 完整 fork 的上下文读取生命周期

有界群／话题读取必须持有当前账号的独占 Consumer。释放 Consumer、Host 关闭或 Provider Registration 被替换后，不返回正在读取的结果。每次请求最多检查 20 条平台记录；无效或不支持的文字计入 omitted，跨群／话题记录拒绝。保留已有附件、发送回执、自身回显和独立回复身份契约。此 fork 的可用性不依赖上游 PR 合并。

### 附近上下文的条数保底

`historyChecked` 的 nearby 先分页覆盖可信来源前后各五分钟窗口，再为稀疏侧补齐 `beforeCount`（默认 10）／`afterCount`（默认 5），每侧整数 0–20。只计入受支持的 Human 文字，锚点自身不计数。条数不截断密集窗口；调用方在自身预算内跟随所有 `nextCursor`，每次仍最多读取 `limit` 条。补充阶段按最近更早／更晚的 Chat 记录读取，按原始时间过滤秒级边界重叠。不等待未来消息，翻页不能更换锚点或条数配置。群与话题历史语义保持不变；这是应用定义的受校验契约，并非原生 around-message API。

### Slack 受校验的上下文读取（BotHarness #819）

独占 Slack Consumer 通过同一 delivery service 提供 `history-text-checked`、
`thread-history-text-checked`。每页复查当前 Bot 账号 fingerprint、Consumer lease、
已加入的公开频道，以及精确 Human 来源的作者和原生话题。仅使用该 Bot 的令牌，
不使用 Human 凭据、不允许模型指定任意频道，也不把历史读取作为 Inbox 收件。

`historyChecked` 查询支持 `group | thread | nearby`、1–20 条原生分页及不透明 cursor。
附近查询完整翻页读取前后各五分钟的可见 Human 文本，稀疏时补齐最近的前 10／后 5 条；
`beforeCount`、`afterCount` 可各设为 0–20。频道历史倒序、话题页内回复正序，而时间限定的原生游标可向旧消息块翻页，分别适配。root 可能额外附加且重复，适配器为它预留空间并只保留一次。
频道／附近查询遵循 Slack 频道历史的可见范围，不宣称含全部子话题内容；读取子话题使用 thread。

游标由运行实例签名，绑定账号／来源／查询，并在停止后失效；仅含有界原生时间戳和计数，
不含正文或凭据。补齐后侧消息时，Slack 倒序接口可能需要多次空结果续页，直到找到最近消息；
最多暂存 20 个候选 ID，返回前重新读取。每次最多返回 20 条事件并明确省略、覆盖范围和续页。
权限不足、来源改变、取消或运行实例失效时拒绝返回结果；调用方仍须遵守 Slack 限流。


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

## 经校验的 Discord 原文件与原位置结果回复（开发候选）

Discord 仅为已验证的独占 consumer 增加 `source-file-checked`、`reply-file-checked`。明确设置 `sourceFiles: true` 后，服务器文字频道或已有公开 thread 中直接提及自身 Bot 的 Human 消息可携带一个托管附件的安全 `{id,messageId,resourceKey,name,sizeBytes,mediaType?}` 元信息。多附件、临时附件、非法或超过 20 MiB 的文件明确拒绝；签名 URL 不离开 Provider。旧 consumer 保留原文本 envelope。直接提及的来源无需开启 Message Content；普通文件收件和图片视觉能力仍未启用。

读取重新查询准确原消息，核对全部保留元信息，并使用刷新后的 HTTPS CDN 附件地址下载，不转发 Bot 凭据、不跟随跳转。下载受当前 lease、取消、声明／实际字节校验及 20 MiB 上限约束。canonical 持久化和 Workspace Grant 权限仍由 consumer 负责。

明确选择的新结果最多 20 MiB；发送前重查来源身份、频道／thread 归属及 VIEW_CHANNEL、READ_MESSAGE_HISTORY、SEND_MESSAGES(_IN_THREADS)、ATTACH_FILES。Host 的 `beforeSend` 校验在唯一一次不自动重试的 multipart 请求前执行，`fail_if_not_exists=true`。返回的原生作者、频道、原消息引用、附件身份／名称／大小必须一致。明确拒绝与 `reply-result-unknown` 分开记录；未知结果不得盲目重试。结果只回原生原频道／thread，无回退目标或新 thread。本候选不升级产品 pin、不发布版本。验收见 [BotHarness #1002](https://github.com/BotHarness/BotHarness/issues/1002)。

## QQ 群通知原生观察（BotHarness #1154）

通过官方 SDK 的 raw-event hook，把 `GROUP_MSG_RECEIVE`、`GROUP_MSG_REJECT` 记录为有界开发诊断。每次连接最多记录 64 次观察，仅包含本地 Bot 身份、群定位的 SHA-256 摘要、本地观察时间及开启／关闭提示；不记录群／成员 OpenID、原始事件内容或凭据，忽略非法事件与已停止／替换连接的回调。这些事件不进入 Source／Inbox，不改变能力或授权，不触发发送或重试保留结果，也不能证明当前主动发送资格；仍需不依赖来源的实际 API 接收回执及原群确认。连接开始前发生的开关变化不能补查。

第一方依据：[QQ 事件订阅与群通知事件](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html)。
