import {
  deriveTokenBotIdentity,
  maskPlatformId,
  TokenBotConfigStore,
} from '../shared/token-config-store.mjs';
import { t } from '../shared/i18n.mjs';

const IDENTITY_OPTIONS = Object.freeze({
  botPrefix: 'discord',
  tokenRefPrefix: 'DSH_DISCORD_BOT_TOKEN',
});

export function deriveDiscordBotIdentity(platformId) {
  return deriveTokenBotIdentity(platformId, IDENTITY_OPTIONS);
}

export function maskDiscordBotId(platformId) {
  return maskPlatformId(platformId, t('Discord机器人'));
}

export class DiscordConfigStore extends TokenBotConfigStore {
  constructor(path, { consumerMode } = {}) {
    if (consumerMode !== undefined && consumerMode !== 'external-consumer') throw new TypeError('Invalid Discord consumer mode');
    super(path, { channel: 'Discord', ...IDENTITY_OPTIONS,
      normalizeBotExtension: value => ({ consumerMode: consumerMode === 'external-consumer' || value.consumerMode === 'external-consumer' ? 'external-consumer' : 'standalone-session' }),
    });
  }
}
