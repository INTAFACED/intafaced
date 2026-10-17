import 'server-only';
import { founderCall, type FounderCallContext } from '@/lib/desk/founder-call';
import { partFrom } from '@/lib/desk/part';
import { DESKS, allReads } from './catalog';
import { readData } from './model';
import type { DeskView, OpsDeskId, ReadOutcome, ReadSpec } from './types';

/**
 * Read a whole module desk as the signed-in founder.
 *
 * Every read is independent: one that is refused, down or unreadable is a failed part with its reason, and the rest
 * still load. Nothing is cached and nothing is summed or estimated here; the only thing this adds to a service answer
 * is the time the console finished reading it.
 */

const SERVICE: Readonly<Record<ReadSpec['module'], string>> = {
  identity: 'svc-identity',
  pay: 'svc-pay',
  support: 'svc-support',
  notify: 'svc-notify',
  bank: 'svc-bank',
  p2p: 'svc-p2p',
  academy: 'svc-academy',
  market: 'svc-market',
  agents: 'svc-agents',
  quant: 'svc-quant',
};

export async function loadRead(ctx: FounderCallContext, spec: ReadSpec): Promise<ReadOutcome> {
  const result = await founderCall(ctx, spec.module, spec.procedure, 'GET', spec.input, (raw) => readData(spec, raw));
  const asOf = new Date().toISOString();
  return {
    id: spec.id,
    asOf,
    part: partFrom(result, (d) => d, { service: SERVICE[spec.module], forbiddenMessage: spec.forbiddenText }),
  };
}

export async function loadDesk(ctx: FounderCallContext, deskId: OpsDeskId, now: Date = new Date()): Promise<DeskView> {
  const outcomes = await Promise.all(allReads(DESKS[deskId]).map((spec) => loadRead(ctx, spec)));
  return { deskId, asOf: now.toISOString(), reads: Object.fromEntries(outcomes.map((o) => [o.id, o])) };
}
