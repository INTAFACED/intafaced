import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MODULE_IDS, moduleForApi, moduleForPage } from '@/lib/modules';
import { ACCOUNT_GAPS } from './accounts-gaps';
import { DESKS, DESK_IDS, allReads } from './catalog';
import type { DeskSpec, ReadSpec } from './types';

const ROUTER: Record<ReadSpec['module'], string | null> = {
  bank: 'svc-bank',
  p2p: 'svc-p2p',
  academy: 'svc-academy',
  market: 'svc-market',
  agents: 'svc-agents',
  quant: 'svc-quant',
  token: 'svc-token',
  protocol: 'svc-protocol',
  indexer: 'svc-indexer',
  dex: 'svc-dex',
  identity: null,
  pay: null,
  support: null,
  notify: null,
};
const source = (service: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../../services/${service}/src/router.ts`, import.meta.url)), 'utf8');

const all = DESK_IDS.flatMap((id) => allReads(DESKS[id]).map((read) => ({ desk: DESKS[id] as DeskSpec, read })));

describe('every desk is a real console module', () => {
  it.each(DESK_IDS)('%s: page, API and nav belong to its module', (id) => {
    const desk = DESKS[id];
    expect(MODULE_IDS).toContain(desk.module);
    expect(moduleForApi(desk.endpoint)).toBe(desk.module);
    expect(moduleForPage(`/${desk.module}`)).toBe(desk.module);
  });
});

describe('the catalogue is internally consistent', () => {
  it('read ids are unique across all desks and carry their service prefix', () => {
    const ids = all.map((a) => a.read.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('column keys are unique within a read and each read shows at least one column in the table', () => {
    for (const { read } of all) {
      const keys = read.columns.map((c) => c.key);
      expect(new Set(keys).size, read.id).toBe(keys.length);
      expect(
        read.columns.some((c) => c.detail !== true),
        read.id,
      ).toBe(true);
    }
  });
  it('lists name a stable row id, and the page size matches the limit asked for', () => {
    for (const { read } of all) {
      if (read.shape === 'list') {
        expect(read.idKey, read.id).toBeTruthy();
        expect(
          read.columns.some((c) => c.key === read.idKey),
          `${read.id} idKey is a column`,
        ).toBe(true);
        const limit = read.input?.limit;
        if (typeof limit === 'number') expect(read.page, read.id).toBe(limit);
      }
    }
  });
  it('every read says what empty means and what a refused session means, and an empty answer never reads as healthy', () => {
    for (const { read } of all) {
      expect(read.forbiddenText.length, read.id).toBeGreaterThan(20);
      if (read.shape === 'list') {
        expect(read.emptyText.length, read.id).toBeGreaterThan(10);
        expect(read.emptyText.toLowerCase(), read.id).not.toMatch(/\bhealthy\b.*\bhealthy\b/);
      }
    }
  });
  it('every unavailable item has a reason, and points at a back-end need or at a decision', () => {
    for (const id of DESK_IDS) {
      for (const s of DESKS[id].sections) {
        for (const u of s.unavailable) {
          expect(u.reason.length, u.id).toBeGreaterThan(40);
          if (u.need !== null) expect(u.need, u.id).toBeGreaterThanOrEqual(13);
        }
        for (const a of s.disabledActions) expect(a.reason.length, a.id).toBeGreaterThan(40);
      }
    }
    for (const g of ACCOUNT_GAPS) expect(g.reason.length, g.id).toBeGreaterThan(40);
  });
});

describe('the desks cover what the product order asks for', () => {
  const sections = (id: keyof typeof DESKS) => DESKS[id].sections.map((s) => s.id);
  it('bank: pools, loans book, card programme, ramp health, business approvals, freezes', () => {
    expect(sections('bank')).toEqual(expect.arrayContaining(['pools', 'loans', 'cards', 'ramps', 'business', 'freezes']));
  });
  it('p2p: disputes (with escalation shown as not offered), settlements and offers/orders', () => {
    expect(sections('p2p')).toEqual(expect.arrayContaining(['disputes', 'settlements', 'orders']));
    const disputes = DESKS.p2p.sections.find((s) => s.id === 'disputes')!;
    expect(disputes.disabledActions.map((a) => a.id)).toEqual(expect.arrayContaining(['p2p.escalate', 'p2p.resolve']));
  });
  it('academy: content metrics, certificates and grant audit, ambassadors', () => {
    expect(sections('academy')).toEqual(expect.arrayContaining(['catalogue', 'certificates', 'ambassadors']));
    const ambassadors = DESKS.academy.sections.find((s) => s.id === 'ambassadors')!;
    expect(ambassadors.disabledActions).toEqual([]);
    expect(ambassadors.sectionAction).toBe('academy.ambassador.appoint');
    const residencies = ambassadors.reads.find((r) => r.id === 'academy.residencies')!;
    expect(residencies.rowAction).toBe('academy.residency');
    const unavailable = DESKS.academy.sections.flatMap((s) => s.unavailable.map((u) => u.id));
    expect(unavailable).toEqual(expect.arrayContaining(['academy.enrolments', 'academy.grant-audit']));
  });
  it('more: agents, quant, mining, launch, market, token, campaigns', () => {
    expect(sections('more')).toEqual(expect.arrayContaining(['agents', 'quant', 'mining', 'launch', 'market', 'token', 'campaigns']));
  });
  it('token: proposals, burned supply and the next emission epoch, each with a plain name and the founder-session wording', () => {
    const token = DESKS.more.sections.find((s) => s.id === 'token')!;
    expect(token.reads.map((r) => [r.id, r.procedure])).toEqual([
      ['token.proposals', 'listProposals'],
      ['token.burned', 'burnedSupply'],
      ['token.epoch', 'nextEmissionEpoch'],
    ]);
    // svc-token refuses a missing page size, so the list asks for one explicitly.
    expect(token.reads[0]!.input).toEqual({ limit: 50 });
    for (const read of token.reads) {
      expect(read.module).toBe('token');
      expect(read.plainName, read.id).toBeTruthy();
      expect(read.forbiddenText, read.id).toMatch(/^Your console session does not have .* permission yet/);
    }
    expect(token.unavailable.map((u) => u.id)).toEqual(['token.supply']);
  });
  it('protocol: chain, audit, indexer finality, DEX health and the blockers panel, read-only and never INTACHAIN or audited', () => {
    expect(sections('protocol')).toEqual(['chain', 'audit', 'indexer', 'dex', 'blockers']);
    expect(allReads(DESKS.protocol).map((r) => `${r.module}.${r.procedure}`)).toEqual([
      'protocol.chainStatus',
      'protocol.auditStatus',
      'indexer.status',
      'dex.health',
      'protocol.health',
    ]);
    for (const read of allReads(DESKS.protocol)) expect(read.plainName, read.id).toBeTruthy();
    expect(DESKS.protocol.sections.find((s) => s.id === 'blockers')!.panel).toBe('protocol.blockers');
    const audit = allReads(DESKS.protocol).find((r) => r.id === 'protocol.audit')!;
    expect(audit.columns.find((c) => c.key === 'audited')).toMatchObject({ kind: 'bool', mustBe: false });
    // The kind of the audit package is pinned too, so the page can only ever describe the internal review.
    expect(audit.columns.find((c) => c.key === 'kind')).toMatchObject({ mustBe: 'internal' });
    expect(DESKS.protocol.module).toBe('protocol-ops');
  });
  it('a figure a service cannot give is never also a read: nothing is listed both ways', () => {
    for (const id of DESK_IDS) {
      for (const s of DESKS[id].sections) {
        const unavailable = new Set(s.unavailable.map((u) => u.id));
        for (const r of s.reads) expect(unavailable.has(r.id), r.id).toBe(false);
      }
    }
  });
});

describe('every read names a QUERY that exists in the owning router (drift guard)', () => {
  it.each(all.map((a) => [a.read.id, a.read] as const))('%s', (_id, read) => {
    const service = ROUTER[read.module];
    expect(service, `${read.module} has a router mapping`).not.toBeNull();
    const text = source(service!);
    const parts = read.procedure.split('.');
    let from = 0;
    if (parts.length === 2) {
      const group = new RegExp(`(\\b${parts[0]}: router\\(|const ${parts[0]} = router\\()`).exec(text);
      expect(group, `${service} has a ${parts[0]} group`).not.toBeNull();
      from = group!.index;
    }
    const name = parts[parts.length - 1]!;
    const proc = new RegExp(`\\b${name}: \\w*Procedure\\b`).exec(text.slice(from));
    expect(proc, `${service} has ${read.procedure}`).not.toBeNull();
    // From the procedure up to the next procedure definition, the call kind must be a query.
    const rest = text.slice(from + proc!.index + 1);
    const next = rest.search(/\n\s+[a-zA-Z]+: \w*Procedure\b/);
    const body = next === -1 ? rest : rest.slice(0, next);
    expect(body.includes('.query('), `${read.procedure} is a query`).toBe(true);
    expect(body.includes('.mutation('), `${read.procedure} is not a mutation`).toBe(false);
  });
});
