import { createHash } from 'node:crypto';
import { t } from '../shared/i18n.mjs';

const DEFAULT_BASE_URL = 'https://discord.com/api/v10/';
const DEFAULT_FILE_UPLOAD_TIMEOUT_MS = 120_000;
const DISCORD_PERMISSION_ERRORS = new Set([50001, 50013]);
const DISCORD_TOO_LARGE_ERRORS = new Set([40005]);

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function requestSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function abortReason(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError');
}

function positiveTimeout(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function preserveProviderMetadata(target, source) {
  if (source?.providerCode !== undefined) target.providerCode = source.providerCode;
  if (source?.retry_after !== undefined) {
    target.retry_after = source.retry_after;
    target.retryAfter = source.retry_after;
  }
  if (Number.isInteger(source?.status)) target.status = source.status;
  return target;
}

function discordArtifactProviderError(cause) {
  const providerCode = Number(cause?.providerCode);
  const status = Number(cause?.status);
  const message = cleanString(cause?.message) ?? '';
  let code = 'artifact-provider-rejected';
  let summary = 'Discord rejected the attachment.';
  if (status === 401 || status === 403 || DISCORD_PERMISSION_ERRORS.has(providerCode)) {
    code = 'artifact-permission-required';
    summary = 'Discord denied permission to send the attachment.';
  } else if (status === 413 || DISCORD_TOO_LARGE_ERRORS.has(providerCode)
    || /(?:request|attachment|file).{0,24}too large/i.test(message)) {
    code = 'artifact-too-large';
    summary = 'The attachment exceeds Discord\'s size limit.';
  } else if (status === 429) {
    code = 'artifact-rate-limited';
    summary = 'Discord rate-limited attachment delivery.';
  } else if (status >= 500) {
    code = 'artifact-delivery-uncertain';
    summary = 'Discord attachment delivery result is uncertain.';
  }
  const error = new Error(summary, { cause });
  error.code = code;
  return preserveProviderMetadata(error, cause);
}

function uncertainDiscordDelivery(cause) {
  const error = new Error('Discord attachment delivery result is uncertain', { cause });
  error.code = 'artifact-delivery-uncertain';
  return preserveProviderMetadata(error, cause);
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    timer?.unref?.();
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

function snowflake(value, name) {
  const id = cleanString(value);
  if (!id || !/^\d{5,30}$/.test(id)) throw new TypeError(`Invalid Discord ${name}`);
  return id;
}

function reactionEmoji(value) {
  const emoji = cleanString(value);
  if (!emoji) throw new TypeError('A Discord reaction emoji is required');
  return emoji;
}

export function validDiscordToken(value) {
  return typeof value === 'string'
    && /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}$/.test(value.trim());
}

export class DiscordApi {
  #token;
  #fetch;
  #baseUrl;
  #fileUploadTimeoutMs;

  constructor({
    token,
    fetchImpl = fetch,
    baseUrl = DEFAULT_BASE_URL,
    fileUploadTimeoutMs = DEFAULT_FILE_UPLOAD_TIMEOUT_MS,
  }) {
    if (!validDiscordToken(token)) throw new TypeError('Discord Bot Token is invalid');
    if (typeof fetchImpl !== 'function') throw new TypeError('DiscordApi requires fetch');
    this.#token = token.trim();
    this.#fetch = fetchImpl;
    this.#baseUrl = new URL(baseUrl);
    this.#fileUploadTimeoutMs = positiveTimeout(fileUploadTimeoutMs, 'fileUploadTimeoutMs');
  }

  getCurrentUser(options = {}) {
    return this.#request('users/@me', { ...options, method: 'GET' });
  }

  getCurrentApplication(options = {}) {
    return this.#request('applications/@me', { ...options, method: 'GET' });
  }

  getGuild({ guildId, signal } = {}) {
    return this.#request(`guilds/${snowflake(guildId, 'guild id')}`, { method: 'GET', signal });
  }

  getGuildMember({ guildId, userId, signal } = {}) {
    return this.#request(`guilds/${snowflake(guildId, 'guild id')}/members/${snowflake(userId, 'user id')}`, { method: 'GET', signal });
  }

  getGatewayBot(options = {}) {
    return this.#request('gateway/bot', { ...options, method: 'GET' });
  }

  getChannel({ channelId, signal } = {}) {
    return this.#request(`channels/${snowflake(channelId, 'channel id')}`, {
      method: 'GET',
      signal,
    });
  }

  getMessage({ channelId, messageId, signal } = {}) {
    return this.#request(
      `channels/${snowflake(channelId, 'channel id')}/messages/${snowflake(messageId, 'message id')}`,
      { method: 'GET', signal },
    );
  }

  getMessages({ channelId, before, limit, signal } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Invalid Discord history limit');
    const query = new URLSearchParams({ limit: String(limit) });
    if (before !== undefined) query.set('before', snowflake(before, 'history boundary'));
    return this.#request(`channels/${snowflake(channelId, 'channel id')}/messages?${query}`, { method: 'GET', signal });
  }

  startThreadFromMessage({ channelId, messageId, name, signal } = {}) {
    const threadName = cleanString(name);
    if (!threadName || [...threadName].length > 100) {
      throw new TypeError('Discord thread name must contain 1-100 characters');
    }
    if (signal?.aborted) throw abortReason(signal);
    return this.#request(
      `channels/${snowflake(channelId, 'channel id')}/messages/${snowflake(messageId, 'message id')}/threads`,
      {
        method: 'POST',
        signal,
        body: { name: threadName },
      },
    );
  }

  createMessage({ channelId, content, replyToMessageId, mentionUserIds = [], signal, retry = true, failIfNotExists = false }) {
    const users = mentionUserIds.map(id => snowflake(id, 'user id'));
    return this.#request(`channels/${snowflake(channelId, 'channel id')}/messages`, {
      method: 'POST',
      signal,
      retry,
      body: {
        content: users.length ? `${users.map(id => `<@${id}>`).join(' ')} ${content}` : content,
        allowed_mentions: { parse: [], replied_user: false, ...(users.length ? { users } : {}) },
        ...(replyToMessageId ? {
          message_reference: {
            message_id: snowflake(replyToMessageId, 'message id'),
            channel_id: snowflake(channelId, 'channel id'),
            fail_if_not_exists: failIfNotExists,
          },
        } : {}),
      },
    });
  }

  async createFileMessage({ channelId, file, replyToMessageId, signal, retry = true, failIfNotExists = false }) {
    if (!file || typeof file !== 'object'
      || typeof file.fileName !== 'string' || !file.fileName
      || !Buffer.isBuffer(file.bytes)) {
      throw new TypeError('A Discord attachment is required');
    }
    const deliverySeed = cleanString(file.deliveryKey) ?? cleanString(file.artifactId);
    const nonce = deliverySeed
      ? createHash('sha256').update(deliverySeed).digest('hex').slice(0, 25)
      : undefined;
    const payload = new FormData();
    payload.append('payload_json', JSON.stringify({
      allowed_mentions: { parse: [], replied_user: false },
      attachments: [{ id: 0, filename: file.fileName }],
      ...(nonce ? { nonce, enforce_nonce: true } : {}),
      ...(replyToMessageId ? {
        message_reference: {
          message_id: snowflake(replyToMessageId, 'message id'),
          channel_id: snowflake(channelId, 'channel id'),
          fail_if_not_exists: failIfNotExists,
        },
      } : {}),
    }));
    payload.append(
      'files[0]',
      new Blob([file.bytes], { type: file.mediaType ?? 'application/octet-stream' }),
      file.fileName,
    );
    const targetChannelId = snowflake(channelId, 'channel id');
    if (signal?.aborted) throw abortReason(signal);
    const uploadSignal = requestSignal(signal, this.#fileUploadTimeoutMs);
    try {
      return await this.#request(`channels/${targetChannelId}/messages`, {
        method: 'POST',
        signal: uploadSignal,
        timeoutMs: this.#fileUploadTimeoutMs,
        body: payload,
        multipart: true,
        retry,
      });
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      if (error?.code?.startsWith?.('discord-')) {
        throw discordArtifactProviderError(error);
      }
      throw uncertainDiscordDelivery(error);
    }
  }

  /** A refreshed native attachment URL is private and never receives Bot credentials. */
  async downloadFileStream({ url, channelId, attachmentId, fileName, signal }) {
    const refused = () => Object.assign(new Error('resource-unavailable'), { code: 'resource-unavailable' });
    let target;
    try { target = new URL(url); } catch { throw refused(); }
    if (target.protocol !== 'https:' || target.hostname !== 'cdn.discordapp.com'
      || target.username || target.password || target.port || target.hash
      || !/^\d{5,30}$/.test(channelId ?? '') || !/^\d{5,30}$/.test(attachmentId ?? '')) throw refused();
    const parts = target.pathname.split('/');
    try {
      if (parts.length !== 5 || parts[1] !== 'attachments' || parts[2] !== channelId
        || parts[3] !== attachmentId || decodeURIComponent(parts[4]) !== fileName) throw refused();
    } catch { throw refused(); }
    const downloadSignal = requestSignal(signal, this.#fileUploadTimeoutMs);
    downloadSignal.throwIfAborted();
    let response;
    try { response = await this.#fetch(target, { method: 'GET', signal: downloadSignal, redirect: 'error' }); }
    catch { downloadSignal.throwIfAborted(); throw refused(); }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw refused();
    }
    const length = response.headers.get('content-length');
    const reader = response.body.getReader();
    let closed = false;
    const cancel = async () => {
      if (closed) return;
      closed = true;
      downloadSignal.removeEventListener('abort', onAbort);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    };
    const onAbort = () => { void cancel(); };
    downloadSignal.addEventListener('abort', onAbort, { once: true });
    if (downloadSignal.aborted) void cancel();
    return { length, cancel, stream: (async function* () {
      try {
        while (true) {
          downloadSignal.throwIfAborted();
          const result = await reader.read();
          downloadSignal.throwIfAborted();
          if (result.done) break;
          yield result.value;
        }
      } catch { downloadSignal.throwIfAborted(); throw refused(); }
      finally { await cancel(); }
    })() };
  }

  editMessage({ channelId, messageId, content, signal }) {
    return this.#request(
      `channels/${snowflake(channelId, 'channel id')}/messages/${snowflake(messageId, 'message id')}`,
      {
        method: 'PATCH',
        signal,
        body: { content, allowed_mentions: { parse: [], replied_user: false } },
      },
    );
  }

  sendTyping({ channelId, signal }) {
    return this.#request(`channels/${snowflake(channelId, 'channel id')}/typing`, {
      method: 'POST',
      signal,
      expectBody: false,
    });
  }

  async addOwnReaction({ channelId, messageId, emoji, signal } = {}) {
    const normalizedEmoji = reactionEmoji(emoji);
    await this.#request(
      `channels/${snowflake(channelId, 'channel id')}/messages/${snowflake(messageId, 'message id')}`
        + `/reactions/${encodeURIComponent(normalizedEmoji)}/@me`,
      {
        method: 'PUT',
        signal,
        expectBody: false,
        retry: false,
      },
    );
    return normalizedEmoji;
  }

  removeOwnReaction({ channelId, messageId, emoji, signal } = {}) {
    const normalizedEmoji = reactionEmoji(emoji);
    return this.#request(
      `channels/${snowflake(channelId, 'channel id')}/messages/${snowflake(messageId, 'message id')}`
        + `/reactions/${encodeURIComponent(normalizedEmoji)}/@me`,
      {
        method: 'DELETE',
        signal,
        expectBody: false,
        retry: false,
      },
    );
  }

  async #request(path, {
    method,
    body,
    signal,
    timeoutMs = 15_000,
    expectBody = true,
    retry = true,
    multipart = false,
  }) {
    let response;
    try {
      response = await this.#fetch(new URL(path, this.#baseUrl), {
        method,
        headers: {
          authorization: `Bot ${this.#token}`,
          ...(multipart ? {} : { 'content-type': 'application/json' }),
          'user-agent': 'DeepSeek-Harness-dsh-im (https://github.com/xmanrui/dsh-im, 1.1.0)',
        },
        ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }),
        signal: requestSignal(signal, timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw error;
      throw new Error(`Discord ${method} transport failed`, { cause: error });
    }

    let parsed = null;
    if (expectBody || response.status === 429 || !response.ok) {
      try {
        parsed = await response.json();
      } catch (cause) {
        if (expectBody) {
          const error = new Error(`Discord ${method} returned invalid JSON`, { cause });
          error.status = response?.status;
          throw error;
        }
      }
    }
    if (response.status === 429 && retry) {
      const retryAfterMs = Math.min(10_000, Math.max(50, Number(parsed?.retry_after) * 1_000 || 1_000));
      await delay(retryAfterMs, signal);
      return this.#request(path, {
        method, body, signal, timeoutMs, expectBody, retry: false, multipart,
      });
    }
    if (!response.ok) {
      const error = new Error(cleanString(parsed?.message) ?? `Discord API failed with HTTP ${response.status}`);
      error.code = `discord-${response.status}`;
      error.status = response.status;
      if (Number.isInteger(parsed?.code) || typeof parsed?.code === 'string') {
        error.providerCode = parsed.code;
      }
      const retryAfter = Number(parsed?.retry_after);
      if (Number.isFinite(retryAfter) && retryAfter >= 0) {
        error.retry_after = retryAfter;
        error.retryAfter = retryAfter;
      }
      throw error;
    }
    return expectBody ? parsed : null;
  }
}

export async function inspectDiscordToken(token, options = {}) {
  const api = new DiscordApi({ token, ...options });
  const bot = await api.getCurrentUser();
  if (!bot?.id || bot?.bot !== true) throw new Error('Discord token does not belong to a bot');
  return {
    platformId: String(bot.id),
    name: cleanString(bot.global_name) ?? cleanString(bot.username) ?? t('Discord机器人'),
    username: cleanString(bot.username),
  };
}
