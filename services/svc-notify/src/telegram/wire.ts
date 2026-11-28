import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { unwrapTrpcData } from '@intafaced/contracts/action-approval-client';
import { serviceCallSigner, type ServiceAuthMode } from '@intafaced/contracts/service-auth-http';
import type { ServiceSigner } from '@intafaced/contracts/service-keys';
import { TRADE_DESK_SNAPSHOT, type TradeDeskSnapshotPort, type TradeDeskSnapshotResult } from '@intafaced/contracts/trade-desk-snapshot';
import type { TelegramTransport } from './desk.js';

/**
 * The Telegram desk's two outside parts: svc-notify's client for svc-trade's `venue.deskSnapshot`, and the bot's send.
 */

const UNAVAILABLE: TradeDeskSnapshotResult = { state: 'unavailable', code: 'trade.desk_snapshot_unavailable' };

/**
 * One bounded request to svc-trade, signed over its body: with svc-notify's own key once S2S is on, else the shared service
 * secret. A missing URL, a short secret, a non-2xx reply, a reply that does not parse, a timeout and a thrown fetch all
 * answer `unavailable`: no answer is never read as "no positions".
 */
export function createTradeDeskClient(options: {
  tradeUrl?: string | undefined;
  secret?: string | undefined;
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode } | undefined;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}): TradeDeskSnapshotPort {
  let endpoint: string | null = null;
  try {
    const url = new URL(options.tradeUrl ?? '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    endpoint = `${url.href.replace(/\/$/, '')}/trpc/${TRADE_DESK_SNAPSHOT.path}`;
  } catch {
    /* Missing or invalid transport reads nothing. */
  }
  const secret = options.secret ?? '';
  // With S2S on, the call is key-signed (and, in dual mode, also shared-secret signed); without it, the shared secret alone.
  const sign = serviceCallSigner({ service: 'svc-notify', audience: 'svc-trade', legacySecret: secret, s2s: options.s2s });
  return {
    async read(raw) {
      if (endpoint === null || (!options.s2s && secret.length < 32)) return UNAVAILABLE;
      const parsed = TRADE_DESK_SNAPSHOT.input.safeParse(raw);
      if (!parsed.success) return UNAVAILABLE;
      const body = JSON.stringify(parsed.data);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);
      try {
        const auth = sign(body, { method: 'POST', url: new URL(endpoint), contentType: 'application/json' });
        const response = await (options.fetcher ?? fetch)(endpoint, {
          method: 'POST',
          redirect: 'error',
          signal: controller.signal,
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...auth },
          body,
        });
        if (!response.ok) return UNAVAILABLE;
        const answer = TRADE_DESK_SNAPSHOT.output.safeParse(unwrapTrpcData(await response.json()));
        return answer.success ? answer.data : UNAVAILABLE;
      } catch {
        return UNAVAILABLE;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** The bot API's answer to a message it took. */
const BotReply = z.object({ ok: z.literal(true) });

/** The bot API's base; the token goes in the path, as the bot API requires, and is never logged. */
const TELEGRAM_API_BASE = 'https://api.telegram.org';

/**
 * Sends through the bot API's `sendMessage`. A non-2xx answer or a reply without `ok: true` throws, so the alert stays in
 * the outbox. Redirects are not followed, so the token never reaches another host. `null` with no token: the channel is off.
 */
export function telegramTransportFromToken(
  token: string | undefined,
  options: { fetcher?: typeof fetch; timeoutMs?: number; base?: string } = {},
): TelegramTransport | null {
  if (!token || token.trim() === '') return null;
  const endpoint = `${options.base ?? TELEGRAM_API_BASE}/bot${token.trim()}/sendMessage`;
  return {
    async send(chatId, text) {
      const response = await (options.fetcher ?? fetch)(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      });
      const reply = BotReply.safeParse(await response.json().catch(() => null));
      if (!response.ok || !reply.success) throw new Error(`the bot API did not take the message (${response.status})`);
    },
  };
}

/** The webhook's shared secret header, checked in constant time. A missing or short configured secret refuses every update. */
export function webhookSecretMatches(configured: string | undefined, presented: unknown): boolean {
  if (!configured || configured.length < 32 || typeof presented !== 'string' || presented.length !== configured.length) return false;
  let diff = 0;
  for (let i = 0; i < configured.length; i += 1) diff |= configured.charCodeAt(i) ^ presented.charCodeAt(i);
  return diff === 0;
}

/**
 * The TEST bot of a test stack (J-charts-desk-21): with no bot token and `NOTIFY_TELEGRAM_TEST_OUTBOX` naming an absolute
 * file, every message the desk sends is written there as one `LOCAL-TEST {json}` line (the chat, the text, the time),
 * labelled TEST, instead of reaching Telegram; a journey reads the file as the chat. Refused at boot unless APP_ENV is
 * exactly dev or test, so it never stands in for the owner's bot. Blank: no TEST bot.
 */
export function telegramTestBotTransport(raw: string | undefined, appEnv: string | undefined): TelegramTransport | null {
  const file = raw?.trim() ?? '';
  if (file === '') return null;
  if (appEnv !== 'dev' && appEnv !== 'test')
    throw new Error('NOTIFY_TELEGRAM_TEST_OUTBOX is allowed only when APP_ENV is exactly dev or test');
  if (!path.isAbsolute(file)) throw new Error('NOTIFY_TELEGRAM_TEST_OUTBOX must be an absolute path');
  return {
    async send(chatId, text) {
      const line = { bot: 'TEST', chatId, text, at: new Date().toISOString() };
      await mkdir(path.dirname(file), { recursive: true });
      await appendFile(file, `LOCAL-TEST ${JSON.stringify(line)}\n`, { encoding: 'utf8', mode: 0o600 });
    },
  };
}
