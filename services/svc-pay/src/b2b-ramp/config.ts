import { isExplicitDevOrTest } from '@intafaced/config';
import { B2bRampBootError } from './errors.js';

/**
 * `pay.b2b_ramp` — Phantom's bank-settled USD→USDT line, shipped switched off.
 *
 *   off (default)  every b2b-ramp route refuses. No attestation is required,
 *                  and payment, payout and settlement behaviour is unchanged.
 *   on             staging, prod, and any APP_ENV that is not exactly `dev` or
 *                  `test` (including unset) refuse to boot unless
 *                  PAY_B2B_RAMP_LICENCE_ATTESTATION is a non-blank string.
 *                  The string is the operator's attestation that a licence
 *                  exists. This module does not invent licence text, and it
 *                  never echoes the value back.
 *
 * Any other flag value fails boot. It does not fall through to `off`.
 * Read the raw env. The service schema defaults an unset APP_ENV to `dev`,
 * and using that default here would let a production host that forgot
 * APP_ENV enable the ramp without an attestation.
 */

export const B2B_RAMP_FLAG = 'pay.b2b_ramp' as const;
export const B2B_RAMP_MODE_ENV = 'PAY_B2B_RAMP';
export const B2B_RAMP_LICENCE_ENV = 'PAY_B2B_RAMP_LICENCE_ATTESTATION';

/** Product line that is not built. Status names these so a screen can list them. */
export const B2B_RAMP_DEFERRED = ['intake', 'batches', 'executions', 'events'] as const;

export type B2bRampMode = 'off' | 'on';

export interface B2bRampConfig {
  readonly flag: typeof B2B_RAMP_FLAG;
  readonly mode: B2bRampMode;
  readonly licenceAttestation: 'present' | 'absent';
  readonly reconciliationSocket: 'wired';
  readonly deferred: typeof B2B_RAMP_DEFERRED;
}

export type B2bRampEnv = Record<string, string | undefined>;

export function loadB2bRampConfig(env: B2bRampEnv): B2bRampConfig {
  const raw = env[B2B_RAMP_MODE_ENV];
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  let mode: B2bRampMode;
  if (raw === undefined || trimmed === '') mode = 'off';
  else if (trimmed === 'off' || trimmed === 'on') mode = trimmed;
  else throw new B2bRampBootError(`PAY_B2B_RAMP must be "off" or "on", got ${JSON.stringify(trimmed)}`);

  const attestationRaw = env[B2B_RAMP_LICENCE_ENV];
  const attestation = typeof attestationRaw === 'string' ? attestationRaw.trim() : '';
  const present = attestation.length > 0;

  if (mode === 'on' && !isExplicitDevOrTest(env.APP_ENV) && !present) {
    const named = typeof env.APP_ENV === 'string' && env.APP_ENV.trim() !== '' ? env.APP_ENV.trim() : '(unset)';
    throw new B2bRampBootError(
      `pay.b2b_ramp cannot be enabled when APP_ENV=${named}: PAY_B2B_RAMP_LICENCE_ATTESTATION is unset. Refusing to boot.`,
    );
  }

  return {
    flag: B2B_RAMP_FLAG,
    mode,
    licenceAttestation: present ? 'present' : 'absent',
    reconciliationSocket: 'wired',
    deferred: B2B_RAMP_DEFERRED,
  };
}
