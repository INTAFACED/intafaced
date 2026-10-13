import { isIP } from 'node:net';
import { z } from 'zod';
import { relaySettingsSchema } from './relay.js';

const integer = (minimum: number, maximum: number) =>
  z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(minimum).max(maximum));
const databaseUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return ['postgres:', 'postgresql:'].includes(url.protocol) && !!url.hostname && url.pathname.length > 1 && !url.hash;
  });
const environmentSchema = z.object({
  NOTIFY_RELAY_DATABASE_URL: databaseUrl,
  NOTIFY_RELAY_TOKEN: z.string(),
  NOTIFY_RELAY_SEND_URL: z.string(),
  NOTIFY_RELAY_SEND_TOKEN: z.string(),
  NOTIFY_RELAY_TIMEOUT_MS: integer(100, 10000),
  NOTIFY_RELAY_PORT: integer(1, 65535),
  NOTIFY_RELAY_HOST: z
    .string()
    .refine((value) => isIP(value) !== 0)
    .default('127.0.0.1'),
});

export function readRelayEnvironment(environment: NodeJS.ProcessEnv) {
  const result = environmentSchema.safeParse(environment);
  if (!result.success) throw new Error('notify.relay.configuration_invalid');
  const parsed = result.data;
  const settings = relaySettingsSchema.safeParse({
    credential: parsed.NOTIFY_RELAY_TOKEN,
    sendUrl: parsed.NOTIFY_RELAY_SEND_URL,
    sendToken: parsed.NOTIFY_RELAY_SEND_TOKEN,
    timeoutMs: parsed.NOTIFY_RELAY_TIMEOUT_MS,
  });
  if (!settings.success) throw new Error('notify.relay.configuration_invalid');
  // This catches a common accidental co-restore configuration. Runtime/database
  // independence still needs deployment evidence; URL spelling cannot prove it.
  if (environment.DATABASE_URL) {
    try {
      const guest = new URL(environment.DATABASE_URL),
        relay = new URL(parsed.NOTIFY_RELAY_DATABASE_URL);
      if (guest.hostname === relay.hostname && (guest.port || '5432') === (relay.port || '5432') && guest.pathname === relay.pathname)
        throw new Error('same database');
    } catch {
      throw new Error('notify.relay.configuration_invalid');
    }
  }
  return {
    databaseUrl: parsed.NOTIFY_RELAY_DATABASE_URL,
    host: parsed.NOTIFY_RELAY_HOST,
    port: parsed.NOTIFY_RELAY_PORT,
    ...settings.data,
  };
}
