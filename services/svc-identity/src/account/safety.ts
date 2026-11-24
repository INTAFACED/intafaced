/**
 * Step-up extras and the location signal (BK-safe-01, J-bank-18 #4). Shapes and refusals:
 * `@intafaced/contracts/identity-safety`. Identity keeps both; it moves no money and reads no other service.
 *
 * The owner's least number of controls (`IDENTITY_EXTRA_CONTROLS_MIN`) has no default: blank refuses every set with
 * `identity.extra_controls_unset`. Reading and removing extras still work while it is blank.
 */
import type { Sql } from 'postgres';
import { transaction, type Queryable } from '@intafaced/db';
import type { ExtraControl, ExtraControlsFor, SafetyRead } from '@intafaced/contracts/identity-safety';

export const EXTRA_CONTROLS_UNSET = 'identity.extra_controls_unset';
export const EXTRA_CONTROLS_TOO_FEW = 'identity.extra_controls_too_few';
export const LOCATION_CONSENT_REQUIRED = 'identity.location_consent_required';

export type SafetyErrorCode = typeof EXTRA_CONTROLS_UNSET | typeof EXTRA_CONTROLS_TOO_FEW | typeof LOCATION_CONSENT_REQUIRED;

export class SafetyError extends Error {
  constructor(readonly code: SafetyErrorCode) {
    super(code);
    this.name = 'SafetyError';
  }
}

/** How many kept sign-in regions the person sees. */
const SIGNALS_SHOWN = 5;

/** Parses `IDENTITY_EXTRA_CONTROLS_MIN`: blank is null (not published); anything but 1..4 stops the service. */
export function parseExtraControlsMin(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 1 || n > 4) throw new Error(`IDENTITY_EXTRA_CONTROLS_MIN must be a whole number 1 to 4, got "${raw}"`);
  return n;
}

type ExtrasRow = { controls: ExtraControl[]; allowance_amount: string; allowance_asset: 'USDT' | 'USDC'; updated_at: Date };

/** A numeric(36,8) read back without its trailing zeros: `500.00000000` is `500`. */
function plainAmount(raw: string): string {
  return raw.includes('.') ? raw.replace(/0+$/, '').replace(/\.$/, '') : raw;
}

async function extrasOf(sql: Sql, userId: string): Promise<ExtrasRow | null> {
  const rows = await sql<ExtrasRow[]>`
    SELECT controls, allowance_amount::text AS allowance_amount, allowance_asset, updated_at
    FROM extra_controls WHERE user_id = ${userId}`;
  return rows[0] ?? null;
}

async function consentOf(sql: Queryable, userId: string): Promise<{ consent: boolean; changed_at: Date } | null> {
  const rows = await sql<Array<{ consent: boolean; changed_at: Date }>>`
    SELECT consent, changed_at FROM location_consent_events WHERE user_id = ${userId}
    ORDER BY changed_at DESC, id DESC LIMIT 1`;
  return rows[0] ?? null;
}

export async function readSafety(sql: Sql, userId: string, minimum: number | null): Promise<SafetyRead> {
  const extras = await extrasOf(sql, userId);
  const consent = await consentOf(sql, userId);
  const signals = consent?.consent
    ? await sql<Array<{ region: string; at: Date }>>`
        SELECT region, at FROM sign_in_location_signals WHERE user_id = ${userId} ORDER BY at DESC LIMIT ${SIGNALS_SHOWN}`
    : [];
  return {
    extraControls: {
      minimum,
      controls: extras?.controls ?? [],
      allowance: extras ? { amount: plainAmount(extras.allowance_amount), assetId: extras.allowance_asset } : null,
      updatedAt: extras?.updated_at.toISOString() ?? null,
    },
    location: {
      consent: consent?.consent ?? false,
      changedAt: consent?.changed_at.toISOString() ?? null,
      signals: signals.map((s) => ({ region: s.region, at: s.at.toISOString() })),
    },
  };
}

/** Sets the person's extras. Call after the password check. Setting what is already held changes nothing. */
export async function setExtraControls(
  sql: Sql,
  input: {
    userId: string;
    minimum: number | null;
    controls: readonly ExtraControl[];
    allowance: { amount: string; assetId: 'USDT' | 'USDC' };
  },
): Promise<{ changed: boolean }> {
  if (input.minimum === null) throw new SafetyError(EXTRA_CONTROLS_UNSET);
  const controls = [...new Set(input.controls)].sort();
  if (controls.length < input.minimum) throw new SafetyError(EXTRA_CONTROLS_TOO_FEW);
  if (controls.includes('known_locations') && !(await consentOf(sql, input.userId))?.consent) {
    throw new SafetyError(LOCATION_CONSENT_REQUIRED);
  }
  const held = await extrasOf(sql, input.userId);
  if (
    held &&
    [...held.controls].sort().join(',') === controls.join(',') &&
    plainAmount(held.allowance_amount) === plainAmount(input.allowance.amount) &&
    held.allowance_asset === input.allowance.assetId
  ) {
    return { changed: false };
  }
  await sql`
    INSERT INTO extra_controls (user_id, controls, allowance_amount, allowance_asset, updated_at)
    VALUES (${input.userId}, ${controls}, ${input.allowance.amount}, ${input.allowance.assetId}, now())
    ON CONFLICT (user_id) DO UPDATE SET
      controls = EXCLUDED.controls, allowance_amount = EXCLUDED.allowance_amount,
      allowance_asset = EXCLUDED.allowance_asset, updated_at = now()`;
  return { changed: true };
}

/** Removes the person's extras. Call after the password check. */
export async function clearExtraControls(sql: Sql, userId: string): Promise<{ changed: boolean }> {
  const gone = await sql`DELETE FROM extra_controls WHERE user_id = ${userId} RETURNING user_id`;
  return { changed: gone.length > 0 };
}

/**
 * Records the location consent. The same answer again records nothing. Turning it off deletes every kept region, and
 * removes known locations from the extras (a control that has nothing to compare with would only look like one).
 */
export async function setLocationConsent(sql: Sql, userId: string, consent: boolean): Promise<{ changed: boolean }> {
  return transaction(sql, async (tx) => {
    await tx`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    const now = await consentOf(tx, userId);
    // Never given and now refused, or the same answer again: nothing to record.
    if ((now?.consent ?? false) === consent) return { changed: false };
    await tx`INSERT INTO location_consent_events (user_id, consent) VALUES (${userId}, ${consent})`;
    if (!consent) {
      await tx`DELETE FROM sign_in_location_signals WHERE user_id = ${userId}`;
      await tx`
        UPDATE extra_controls SET controls = array_remove(controls, 'known_locations'), updated_at = now()
        WHERE user_id = ${userId} AND 'known_locations' = ANY(controls)`;
      // Known locations was the only control left: no extras remain.
      await tx`DELETE FROM extra_controls WHERE user_id = ${userId} AND cardinality(controls) = 0`;
    }
    return { changed: true };
  });
}

/**
 * Keeps the region of a new sign-in, only while the person's newest consent is on. An unknown region (`XX`, or anything
 * that is not two capital letters) is not kept. Never throws: a sign-in never fails for its signal.
 */
export async function recordSignInSignal(
  sql: Sql,
  input: { userId: string; sessionId: string; region: string | null | undefined },
  warn: (detail: Record<string, unknown>, msg: string) => void = () => undefined,
): Promise<boolean> {
  const region = input.region?.trim().toUpperCase() ?? '';
  if (!/^[A-Z]{2}$/.test(region) || region === 'XX') return false;
  try {
    const kept = await sql`
      INSERT INTO sign_in_location_signals (user_id, session_id, region)
      SELECT ${input.userId}, ${input.sessionId}, ${region}
      WHERE (SELECT consent FROM location_consent_events WHERE user_id = ${input.userId}
             ORDER BY changed_at DESC, id DESC LIMIT 1) IS TRUE
      RETURNING id`;
    return kept.length > 0;
  } catch (err) {
    warn({ userId: input.userId, reason: err instanceof Error ? err.name : 'error' }, 'identity.location_signal_not_kept');
    return false;
  }
}

/** What svc-bank needs to hold a send above the allowance. */
export async function extraControlsFor(sql: Sql, userId: string): Promise<ExtraControlsFor> {
  const extras = await extrasOf(sql, userId);
  return {
    userId,
    controls: extras?.controls ?? [],
    allowance: extras ? { amount: plainAmount(extras.allowance_amount), assetId: extras.allowance_asset } : null,
  };
}
