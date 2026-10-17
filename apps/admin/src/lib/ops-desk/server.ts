import 'server-only';
import { founderCall, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { partFrom } from '@/lib/desk/part';
import { DESKS, allReads } from './catalog';
import { inputFor, readData } from './model';
import type { DeskView, OpsDeskId, ReadData, ReadOutcome, ReadSpec } from './types';

/**
 * Read a whole module desk as the signed-in founder.
 *
 * Every read is independent: one that is refused, down or unreadable is a failed part with its reason, and the rest
 * still load. Nothing is cached and nothing is summed or estimated here; the only thing this adds to a service answer
 * is the time the console finished reading it.
 *
 * Reads that name the same procedure with the same input (one answer shown as a facts block and a table, say) share ONE
 * call to the service. Each is still read, checked and counted on its own: one that cannot be read is a failed part while
 * its sibling shows.
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
  mining: 'svc-mining-pool',
  token: 'svc-token',
  protocol: 'svc-protocol',
  indexer: 'svc-indexer',
  dex: 'svc-dex',
};

function outcomeOf(spec: ReadSpec, result: FounderCallResult<ReadData>, asOf: string): ReadOutcome {
  return {
    id: spec.id,
    asOf,
    part: partFrom(result, (d) => d, { service: SERVICE[spec.module], forbiddenMessage: spec.forbiddenText }),
  };
}

async function loadGroup(ctx: FounderCallContext, specs: readonly ReadSpec[], now: Date): Promise<ReadOutcome[]> {
  const first = specs[0]!;
  const answer = await founderCall(ctx, first.module, first.procedure, 'GET', inputFor(first, now), (raw) => ({ raw }), {
    sendEmptyInput: first.sendEmptyInput === true,
  });
  const asOf = new Date().toISOString();
  return specs.map((spec) => {
    if (answer.kind !== 'ok') return outcomeOf(spec, answer, asOf);
    const data = readData(spec, answer.data.raw);
    return outcomeOf(
      spec,
      data === null ? { kind: 'invalid', requestId: answer.requestId } : { kind: 'ok', data, requestId: answer.requestId },
      asOf,
    );
  });
}

export async function loadRead(ctx: FounderCallContext, spec: ReadSpec): Promise<ReadOutcome> {
  return (await loadGroup(ctx, [spec], new Date()))[0]!;
}

export async function loadDesk(ctx: FounderCallContext, deskId: OpsDeskId, now: Date = new Date()): Promise<DeskView> {
  const groups = new Map<string, ReadSpec[]>();
  for (const spec of allReads(DESKS[deskId])) {
    const key = JSON.stringify([spec.module, spec.procedure, inputFor(spec, now) ?? null, spec.sendEmptyInput === true]);
    groups.set(key, [...(groups.get(key) ?? []), spec]);
  }
  const outcomes = (await Promise.all([...groups.values()].map((specs) => loadGroup(ctx, specs, now)))).flat();
  return { deskId, asOf: now.toISOString(), reads: Object.fromEntries(outcomes.map((o) => [o.id, o])) };
}
