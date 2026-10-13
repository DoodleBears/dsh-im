import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
const observerModule = resolve(sourceRoot, 'src/channels/qq/sdk-frame-observation.mjs');
const inputs = {
  'QQBot.js': '0ee621d964824a41690827936f86b383e51e603dc19aa9e5a9492f77ca44a7d6',
  'gateway-connection.js': '4ee50dc8670de41089b593181df3fc2e17ef574aec3c04c73da54a7be7c79555',
};

function replace(source, before, after) {
  if (source.split(before).length !== 2) throw Error('QQ SDK observation patch seam differs');
  return source.replace(before, after);
}

export function patchQqObservationSource(name, source) {
  if (!inputs[name] || createHash('sha256').update(source).digest('hex') !== inputs[name])
    throw Error('QQ SDK observation patch requires the exact reviewed SDK 1.0.4 input');
  if (name === 'QQBot.js') return replace(source, 'intents: this.opts.intents,',
    'intents: this.opts.intents,\n            onGatewayObservation: this.opts.onGatewayObservation,');
  source = replace(source, '\n    shouldRefreshToken = false;',
    '\n    shouldRefreshToken = false;\n    observationConnection = 0;\n    observationFrame = 0;');
  source = replace(source, 'this.currentWs = ws;',
    'this.currentWs = ws;\n            const connection = ++this.observationConnection;');
  source = replace(source, 'ws.on("message", async (data) => {\n                try {',
    `ws.on("message", async (data) => {
                const frame = ++this.observationFrame;
                const observer = !this.isAborted && this.currentWs === ws ? this.opts.onGatewayObservation : undefined;
                const evidence = { connection, frame, bytes: typeof observer === 'function' ? frameBytes(data) : null };
                observeFrame(observer, { ...evidence, phase: 'received' });
                let decoded = false;
                try {`);
  source = replace(source, 'const { op, d, s, t } = payload;',
    `const { op, d, s, t } = payload;
                    decoded = true;
                    observeFrame(observer, { ...evidence, phase: 'decoded', ...frameEnvelope(op, t, s) });`);
  source = replace(source, 'catch (err) {\n                    log?.error(`[${account.accountId}] Message parse error:',
    'catch (err) {\n                    observeFrame(observer, { ...evidence, phase: decoded ? "processing-refused" : "parse-refused" });\n                    log?.error(`[${account.accountId}] Message parse error:');
  return `import { frameBytes, frameEnvelope, observeFrame } from ${JSON.stringify(observerModule)};\n${source}`;
}

export const qqSdkObservationPatch = {
  name: 'qq-sdk-1.0.4-metadata-observation',
  setup(build) {
    build.onLoad({ filter: /[/\\]qqbot-nodejs[/\\]dist[/\\](?:QQBot\.js|protocol[/\\]gateway[/\\]gateway-connection\.js)$/ }, async args => {
      const name = args.path.split(/[/\\]/).at(-1);
      const source = await readFile(args.path, 'utf8');
      return { contents: patchQqObservationSource(name, source), loader: 'js', resolveDir: resolve(args.path, '..') };
    });
  },
};
