# Checked Discord managed-role mentions

The exclusive Discord Consumer recognizes native user mentions of the authenticated Bot and mentions of its own current integration-managed role. Names and arbitrary roles do not supply addressing authority.

For a role mention, the Runtime checks the original channel/guild, native guild roles and Bot member before normalization. The role's string ID must appear in `mention_roles`; its current `managed` field must be true, `tags.bot_id` must equal the authenticated Bot user ID, and the current Bot member must hold that role. The guild's everyone role never qualifies. Reuse existing native source inspection without another Gateway connection or persistent role cache.

The event preserves original text, source/reply association and user mentions. A managed role is not fabricated as a user mention. Ordinary collection remains separately opted in; unrelated role/everyone/here messages may be ordinary context only under that policy. Existing human-only, account, permission, route and receiver-lifetime checks still apply. The standalone Discord Session runner is unchanged.

Recognition does not grant Message Content intent or make Discord deliver unavailable content. Fresh native delivery and original-location replies must be qualified on the selected App; source tests are not native Discord acceptance.

References: [Role and role-tag structures](https://docs.discord.com/developers/topics/permissions#role-object), [Message mention fields](https://docs.discord.com/developers/resources/message#message-object), [BotHarness #1615](https://github.com/BotHarness/DeepSeekBot/issues/1615).
