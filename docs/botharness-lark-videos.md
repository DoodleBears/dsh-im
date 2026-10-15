# Checked Lark parent-video candidate

Refs [BotHarness/DeepSeekBot#1023](https://github.com/BotHarness/DeepSeekBot/issues/1023).

The exclusive external Consumer can opt into `sourceVideos` alongside `sourceFiles`. A native user text request that mentions the receiving App and replies to a native `media` message can carry the exact parent video descriptor. `sourceImages` additionally enables its native cover descriptor. Neither option downloads bytes at intake. A generic `file` remains a file even when its name ends in `.mp4`.

The original request and parent must still match the current App, actor route, conversation and topic. Resource reads re-fetch both messages, compare the exact descriptor, and use the parent message ID with its original `file_key` (`type=file`) or `image_key` (`type=image`). Existing cancellation, consumer-lifetime and 25 MiB limits remain in force. A changed/missing resource fails rather than selecting another parent or App. Native `duration` is retained as milliseconds when present; a missing duration or cover stays absent. No transcript, cover, codec or MIME is inferred from a name.

Automated qualification: 60 focused tests passed; the complete Feishu test directory passed 779 tests with five existing POSIX-only fixture skips on Windows. Build and package verification passed. **Fresh native browser intake, byte equality, playback and installed-product E2E are pending.** This is a draft candidate, not a completed audio/video qualification or publication.

## 中文

独占 external Consumer 在 `sourceFiles` 之外明确启用 `sourceVideos` 后，可关联“真正 @ 接收 App 的用户文本请求”所引用的原生 `media` 视频。启用 `sourceImages` 时还可关联同一原生消息提供的封面。入站只保存元数据，不下载资源；名称为 `.mp4` 的普通 `file` 仍是文件。

读取前重新核对原请求、原群／话题与父消息，比较完整资源描述，再用父消息 ID 和其原始 `file_key`／`image_key` 获取有界资源。继续遵守当前消费者生命周期、取消和 25 MiB 限制；来源变化或缺失时拒绝，不替换 App 或父消息。平台时长有值时保留毫秒单位，缺失时长或封面保持缺失，不根据文件名猜测转写、封面、编码或 MIME。

60 项聚焦测试、飞书目录 779 项测试、构建和包检查已通过；另有 5 项既有 POSIX 夹具测试在 Windows 跳过。**真实浏览器入站、字节一致、播放和安装包 E2E 尚待验收。** 本候选不表示音视频任务已完成，也未发布。
