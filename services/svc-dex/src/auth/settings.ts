import { dexOrderCapSchema, type DexOrderCap } from '@intafaced/contracts/protocol-dex-orders';
import { getAddress } from 'viem';
import { envTransform } from '../order/trigger-settings.js';

/** The order session's owner settings (D-limit-dca-01). Blank stays blank; each refuses by name where it is used. */
export const dexAuthSecretField = envTransform('DEX_AUTH_SECRET', (raw) => raw.trim());

export const dexAuthTtlField = (name: string) =>
  envTransform(name, (raw) => {
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) throw new Error(`${name} must be a whole number of seconds`);
    return Number(trimmed);
  });

/** JSON array of `{ token, symbol, max }`; a malformed or empty schedule refuses to boot rather than reading as no cap. */
export function parseCapSchedule(raw: string): DexOrderCap[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('DEX_ORDER_CAP_SCHEDULE is not JSON');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('DEX_ORDER_CAP_SCHEDULE must be a non-empty JSON array');
  const seen = new Set<string>();
  return parsed.map((row, i) => {
    let cap: DexOrderCap;
    try {
      cap = dexOrderCapSchema.parse(row);
    } catch {
      throw new Error(`DEX_ORDER_CAP_SCHEDULE[${i}] must be { token, symbol, max } with a decimal max`);
    }
    const token = getAddress(cap.token).toLowerCase();
    if (seen.has(token)) throw new Error(`DEX_ORDER_CAP_SCHEDULE names ${token} twice`);
    seen.add(token);
    return { token, symbol: cap.symbol, max: cap.max };
  });
}

export const dexOrderCapScheduleField = envTransform('DEX_ORDER_CAP_SCHEDULE', parseCapSchedule);
