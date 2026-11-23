import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import {
  QUANT_SANDBOX_LANGUAGES,
  quantDecimalSchema,
  quantEnvironmentInputSchema,
  quantLanguageSchema,
  quantSandboxRunOutputSchema,
  quantWriteKeyField,
} from './quant-wire.js';

/**
 * svc-quant's sandbox (AL-sandbox-01), one record per call: what this deployment's isolate offers, and one paper run of a
 * script on the internal book. Simulated: no run moves value. svc-quant mounts each from here (`routes/sandbox.ts`).
 */

/** Served wherever quant's fiat plane is, with or without a principal. */
const ACCESS = { caller: 'jurisdiction', module: 'quant', plane: 'fiat' } as const;
const base = { service: 'svc-quant', module: 'quant', transport: 'trpc', access: ACCESS } as const;

/**
 * The longest source any deployment takes (`SANDBOX_MAX_SOURCE` may be at most this). The owner's own pin, which is the
 * deployment's, is held by svc-quant before anything runs or is stored.
 */
export const QUANT_SANDBOX_SOURCE_ENVELOPE = 64_000;

/** The isolate, its languages and the venue vault as this deployment has them. Read only. */
export const QUANT_SANDBOX_CAPABILITIES = defineProcedure({
  ...base,
  name: 'quant.sandbox.capabilities',
  kind: 'query',
  path: 'sandbox.capabilities',
  refusals: {},
  input: NO_INPUT,
  output: z.object({
    isolate: z.enum(['wired', 'unwired']),
    languages: z.array(z.enum(QUANT_SANDBOX_LANGUAGES)),
    venueVault: z.enum(['trade-only', 'unset']),
    refuse: z.string().nullable(),
  }),
  samples: [{ verdict: 'accept', input: undefined }],
});

/**
 * One paper run of a script under the caller's plan limits (J-algo-dev-12), recorded under the caller's key. Each refusal
 * is listed with the status svc-quant's `toTrpc` gives it; a replay under the same key answers the first run's refusal.
 */
export const QUANT_SANDBOX_RUN = defineProcedure({
  ...base,
  name: 'quant.sandbox.run',
  kind: 'mutation',
  path: 'sandbox.run',
  refusals: {
    // The key and the plan, before anything runs.
    'quant.idempotency_key_unset': 'BAD_REQUEST',
    'quant.params_invalid': 'BAD_REQUEST',
    'quant.quota_profile_unset': 'PRECONDITION_FAILED',
    'quant.quota_unset': 'PRECONDITION_FAILED',
    'quant.quota_exceeded': 'PRECONDITION_FAILED',
    'quant.sandbox_limit_unset': 'PRECONDITION_FAILED',
    // The request's honesty and bankroll.
    'quant.environment_required': 'BAD_REQUEST',
    'quant.environment_unknown': 'BAD_REQUEST',
    'quant.simulated_as_live': 'BAD_REQUEST',
    'quant.cash_unset': 'BAD_REQUEST',
    // The isolate and the paper book.
    'quant.sandbox_unwired': 'PRECONDITION_FAILED',
    'quant.sandbox_max_ops_unset': 'PRECONDITION_FAILED',
    'quant.sandbox_max_source_unset': 'PRECONDITION_FAILED',
    'quant.sandbox_syntax': 'BAD_REQUEST',
    'quant.sandbox_escape': 'BAD_REQUEST',
    'quant.sandbox_timeout': 'TIMEOUT',
    'quant.sandbox_memory': 'BAD_REQUEST',
    'quant.sandbox_output': 'BAD_REQUEST',
    'quant.param_out_of_range': 'BAD_REQUEST',
    'quant.paper_fee_unset': 'PRECONDITION_FAILED',
    'quant.venue_vault_unset': 'PRECONDITION_FAILED',
    // The run log.
    'quant.run_result_cap_unset': 'PRECONDITION_FAILED',
    'quant.run_result_too_large': 'PRECONDITION_FAILED',
    'quant.run_immutable': 'BAD_REQUEST',
  },
  input: z
    .object({
      language: quantLanguageSchema,
      source: z.string().min(1).max(QUANT_SANDBOX_SOURCE_ENVELOPE),
      cash: quantDecimalSchema.optional().nullable(),
      ...quantWriteKeyField,
    })
    .merge(quantEnvironmentInputSchema),
  output: quantSandboxRunOutputSchema,
  samples: [
    {
      verdict: 'accept',
      input: { language: 'javascript', source: 'console.log(1);', cash: '10000', environment: 'paper', idempotencyKey: 'sbx-1' },
    },
    { verdict: 'accept', input: { language: 'python', source: 'print(1)', cash: '10000', environment: 'paper', presentedAs: 'paper' } },
    { verdict: 'refuse', input: { language: 'ruby', source: 'puts 1', cash: '10000', environment: 'paper' } },
    { verdict: 'refuse', input: { language: 'javascript', source: '', cash: '10000', environment: 'paper' } },
    { verdict: 'refuse', input: { language: 'javascript', source: 'console.log(1);', cash: '10k', environment: 'paper' } },
  ],
});

export const QUANT_SANDBOX_PROCEDURES = [QUANT_SANDBOX_CAPABILITIES, QUANT_SANDBOX_RUN] as const;
