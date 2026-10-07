import { TokenBotController } from '../shared/token-bot-controller.mjs';
import { deriveDiscordBotIdentity, maskDiscordBotId } from './config-store.mjs';
import { DiscordApi, inspectDiscordToken } from './discord-api.mjs';
import { verifiedDiscordAccount, discordRefusal } from './external-consumer.mjs';
import { DISCORD_DESCRIPTOR } from './discord-bridge.mjs';

export class DiscordController extends TokenBotController {
  constructor(options) {
    super({
      ...options,
      descriptor: DISCORD_DESCRIPTOR,
      inspectToken: options.inspectToken ?? inspectDiscordToken,
      deriveIdentity: deriveDiscordBotIdentity,
      maskPlatformId: maskDiscordBotId,
      checkedDelivery: {
        capabilities: ['proactive-text-checked', 'exclusive-text-consumer', 'ordinary-text-consumer', 'reply-text-checked',
          'reply-context-checked', 'reply-receipt-checked', 'reply-fence-checked',
          'history-text-checked', 'thread-history-text-checked', 'source-file-checked', 'reply-file-checked'],
        inspectAccount: async (token, config, { signal }) => {
          const api = (options.createApi ?? (args => new DiscordApi(args)))({ token });
          const [user, app] = await Promise.all([api.getCurrentUser({ signal }), api.getCurrentApplication({ signal })]);
          const account = verifiedDiscordAccount(user, app);
          if (account.userId !== config.platformId) throw discordRefusal('account-changed');
          return account;
        },
      },
    });
  }
}
