import { z } from 'zod';

/** The only thing the mining pool publishes to a browser: process liveness and
 * whether its two connections are configured. Configured is not verified. */
export const miningHealth = z.object({
  ok: z.literal(true),
  service: z.literal('svc-mining-pool'),
  ledger: z.object({ status: z.enum(['absent', 'configured']), code: z.string() }),
  pg: z.object({ status: z.enum(['absent', 'configured']), code: z.string() }),
  jobs: z.array(z.string()),
});
export type MiningHealth = z.infer<typeof miningHealth>;

export type PoolVerdict = 'unreachable' | 'incomplete' | 'configured_no_jobs' | 'configured';

/** Plain-language pool state from the public reading alone. It never says the
 * pool is "live", "paying" or "healthy": no reading can prove that. */
export function poolVerdict(health: MiningHealth | null): PoolVerdict {
  if (!health) return 'unreachable';
  if (health.ledger.status !== 'configured' || health.pg.status !== 'configured') return 'incomplete';
  return health.jobs.length ? 'configured' : 'configured_no_jobs';
}

export type MiningStepId = 'worker' | 'shares' | 'window' | 'payout';
export type MiningStep = { id: MiningStepId; blocker: 'no_customer_api'; dependency: 'none' | 'ledger' | 'store' | 'job' };

/** The miner journey, in order. Each step names why a customer cannot run it:
 * the pool exposes no customer-scoped read or write for any of them. */
export const MINING_STEPS: readonly MiningStep[] = [
  { id: 'worker', blocker: 'no_customer_api', dependency: 'none' },
  { id: 'shares', blocker: 'no_customer_api', dependency: 'store' },
  { id: 'window', blocker: 'no_customer_api', dependency: 'store' },
  { id: 'payout', blocker: 'no_customer_api', dependency: 'ledger' },
];

/** Whether the dependency a step needs is configured, not checked. */
export function dependencyReading(health: MiningHealth | null, step: MiningStep): 'unknown' | 'absent' | 'configured' | 'none' {
  if (step.dependency === 'none') return 'none';
  if (!health) return 'unknown';
  if (step.dependency === 'job') return health.jobs.length ? 'configured' : 'absent';
  return (step.dependency === 'ledger' ? health.ledger : health.pg).status;
}
