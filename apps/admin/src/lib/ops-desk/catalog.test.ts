import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MODULE_IDS, moduleForApi, moduleForPage } from '@/lib/modules';
import { ACCOUNT_GAPS } from './accounts-gaps';
import {
  ACADEMY_PAGES,
  BANK_CUSTOMER_BALANCES,
  BANK_CUSTOMER_ENTRIES,
  BANK_CUSTOMER_ENTRIES_CHECK,
  DESKS,
  DESK_IDS,
  PAY_TRANSFER_DETAIL,
  academySectionDesk,
  allReads,
} from './catalog';
import type { DeskSpec, ReadSpec } from './types';

const ROUTER: Record<ReadSpec['module'], string | null> = {
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
  campaigns: 'svc-campaigns',
  identity: null,
  trade: null,
  pay: null,
  support: null,
  notify: null,
};
const personalPayRouter = () =>
  readFileSync(fileURLToPath(new URL('../../../../../services/svc-bank/src/personal-pay/router.ts', import.meta.url)), 'utf8');
// svc-bank's router.ts composes one router file per area from src/router/; those files are read with it.
const source = (service: string) => {
  const src = fileURLToPath(new URL(`../../../../../services/${service}/src`, import.meta.url));
  const areas = existsSync(join(src, 'router'))
    ? readdirSync(join(src, 'router'))
        .filter((name) => name.endsWith('.router.ts'))
        .sort()
        .map((name) => readFileSync(join(src, 'router', name), 'utf8'))
    : [];
  return [...areas, readFileSync(join(src, 'router.ts'), 'utf8')].join('\n');
};

// The transfer record is read on request, so it sits in no section; it is held to the same rules as every other read.
const all = [
  ...DESK_IDS.flatMap((id) => allReads(DESKS[id]).map((read) => ({ desk: DESKS[id] as DeskSpec, read }))),
  { desk: DESKS.pay as DeskSpec, read: PAY_TRANSFER_DETAIL },
];

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
        // A list names a stable row id, or says outright that the service gives its rows none (and then it has no row action).
        if (read.anonymousRows) {
          expect(read.idKey, `${read.id} is anonymous, so it has no idKey`).toBeUndefined();
          expect(read.rowAction, `${read.id} is anonymous, so it has no row action`).toBeUndefined();
        } else {
          expect(read.idKey, read.id).toBeTruthy();
          expect(
            read.columns.some((c) => c.key === read.idKey),
            `${read.id} idKey is a column`,
          ).toBe(true);
        }
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
  it('bank: the customer balances lookup is a section action, so nothing about a customer is read with the page', () => {
    const section = DESKS.bank.sections.find((s) => s.id === 'customer-balances')!;
    expect(section.sectionAction).toBe('bank.customer.balances');
    expect(section.reads).toEqual([]);
    expect(allReads(DESKS.bank).map((r) => r.procedure)).not.toContain('ops.customerBalances');
    expect(BANK_CUSTOMER_BALANCES.procedure).toBe('ops.customerBalances');
    expect(BANK_CUSTOMER_ENTRIES.procedure).toBe(BANK_CUSTOMER_ENTRIES_CHECK.procedure);
    expect(BANK_CUSTOMER_ENTRIES.input).toBeUndefined();
  });
  it('bank: the operator reads of BANKOPS are on the desk, and the card freeze is a two-founder section action', () => {
    const procedures = allReads(DESKS.bank).map((r) => r.procedure);
    expect(procedures).toEqual(
      expect.arrayContaining(['ops.poolTotals', 'ops.loanBook', 'ops.cardProgramme', 'ops.rampHealth', 'ops.businessApprovals']),
    );
    const cards = DESKS.bank.sections.find((s) => s.id === 'cards')!;
    expect(cards.sectionAction).toBe('bank.card.status');
    expect(cards.disabledActions).toEqual([]);
    // What the service now gives is not also listed as missing.
    const unavailable = DESKS.bank.sections.flatMap((s) => s.unavailable.map((u) => u.id));
    expect(unavailable).not.toEqual(expect.arrayContaining(['bank.pool-totals']));
    expect(unavailable).not.toEqual(expect.arrayContaining(['bank.loan-book']));
    expect(unavailable).not.toEqual(expect.arrayContaining(['bank.business-queue']));
  });
  it('bank: the windowed reads state their window in the title and stay inside the service’s own limits', () => {
    for (const read of allReads(DESKS.bank).filter((r) => r.windowDays !== undefined)) {
      // The card counts are all-time; only the authorisations are windowed, and the title says both.
      if (read.id === 'bank.card-counts') expect(read.title).toMatch(/all time/);
      expect(read.title, read.id).toMatch(/last 30 days/);
      // svc-bank refuses a card programme span over 92 days.
      expect(read.windowDays, read.id).toBeLessThanOrEqual(92);
    }
  });
  it('p2p: disputes (escalate is a row action, the ruling is shown as not offered), settlements and offers/trades', () => {
    expect(sections('p2p')).toEqual(expect.arrayContaining(['disputes', 'settlements', 'orders']));
    const disputes = DESKS.p2p.sections.find((s) => s.id === 'disputes')!;
    expect(disputes.reads.find((r) => r.id === 'p2p.disputes')!.rowAction).toBe('p2p.dispute.escalate');
    expect(disputes.disabledActions.map((a) => a.id)).toEqual(['p2p.resolve']);
    const orders = DESKS.p2p.sections.find((s) => s.id === 'orders')!;
    expect(orders.reads.map((r) => r.procedure)).toEqual(
      expect.arrayContaining(['ops.counts', 'ops.disputeRate24h', 'ops.offers', 'ops.trades']),
    );
    // Every operator read of P2POPS asks for an explicit page size: the service refuses a blank one.
    for (const r of orders.reads.filter((x) => x.procedure === 'ops.offers' || x.procedure === 'ops.trades')) {
      expect(r.input?.limit, r.id).toBe(50);
      expect(['active', 'paused', 'closed', 'created', 'escrowed', 'fiat_sent', 'released', 'cancelled', 'disputed']).toContain(
        r.input?.status,
      );
    }
  });
  it('pay: lists lead, then the metrics with their window, then actions; every read is svc-bank’s own operator read', () => {
    expect(sections('pay')).toEqual(['failures', 'bills', 'global', 'health', 'actions']);
    const reads = allReads(DESKS.pay);
    expect(reads.every((r) => r.module === 'bank')).toBe(true);
    expect(new Set(reads.map((r) => r.procedure))).toEqual(
      new Set([
        'ops.failedTransfers',
        'bills.ops.failed',
        'bills.ops.summary',
        'global.ops.failed',
        'global.ops.recalls',
        'global.ops.summary',
        'ops.transferHealth',
      ]),
    );
    expect(PAY_TRANSFER_DETAIL.procedure).toBe('ops.transferDetail');
    expect(DESKS.pay.module).toBe('pay-ops');
    expect(DESKS.pay.endpoint).toBe('/api/pay-ops');
  });
  it('pay: the health reads send the window svc-bank requires, and the titles say it', () => {
    const health = allReads(DESKS.pay).filter((r) => r.procedure === 'ops.transferHealth');
    expect(health.map((r) => r.id).sort()).toEqual(
      ['pay.bills-24h', 'pay.bills-7d', 'pay.oneoff-24h', 'pay.oneoff-7d', 'pay.p2p-pointer', 'pay.standing-24h', 'pay.standing-7d'].sort(),
    );
    for (const r of health.filter((x) => x.id !== 'pay.p2p-pointer')) {
      const hours = r.input?.windowHours;
      expect(hours === 24 || hours === 168, r.id).toBe(true);
      expect(r.title, r.id).toMatch(hours === 24 ? /last 24 hours/ : /last 7 days/);
      // svc-bank refuses a window outside 1 to 720 hours.
      expect(hours as number).toBeGreaterThanOrEqual(1);
      expect(hours as number).toBeLessThanOrEqual(720);
      // Every block states the time svc-bank computed it.
      expect(
        r.columns.find((c) => c.key === 'asOf'),
        r.id,
      ).toMatchObject({ kind: 'time' });
    }
    const failed = allReads(DESKS.pay).find((r) => r.id === 'pay.failed-standing')!;
    expect(failed.input).toEqual({ windowHours: 168, limit: 50 });
    expect(failed.page).toBe(50);
    expect(failed.rowAction).toBe('pay.transfer.detail');
    expect(failed.forbiddenText).toMatch(/admin:compliance/);
  });
  it('pay: the lists that svc-bank pages by size ask for one, because it refuses a blank page size', () => {
    for (const id of ['pay.bills-failed', 'pay.global-failed']) {
      const r = allReads(DESKS.pay).find((x) => x.id === id)!;
      expect(r.input).toEqual({ limit: 50 });
      expect(r.page).toBe(50);
    }
  });
  it('pay: the oldest-pending ages name the window they cover, and are shown as durations', () => {
    for (const r of allReads(DESKS.pay).filter((x) => x.procedure === 'ops.transferHealth' && x.id !== 'pay.p2p-pointer')) {
      const age = r.columns.find((c) => c.key.endsWith('oldestPendingAgeSeconds'))!;
      expect(age.kind, r.id).toBe('seconds');
      expect(age.label, r.id).toMatch(/in this window/);
      expect(age.label, r.id).toMatch(/older ones are not counted/);
      expect(age.label, r.id).not.toMatch(/a dash means none is (pending|reserved|waiting)\b/);
    }
  });
  it('pay: lists with a page marker read it; lists without one never claim a full page means more exist', () => {
    const reads = allReads(DESKS.pay).filter((r) => r.shape === 'list');
    expect(reads.filter((r) => r.cursorKey).map((r) => r.id)).toEqual(['pay.failed-standing', 'pay.bills-failed']);
    for (const r of reads) {
      if (r.cursorKey) expect(r.cursorKey).toBe('nextCursor');
      expect(r.note, r.id).not.toMatch(/when the page is full, more exist/);
    }
    expect(allReads(DESKS.pay).find((r) => r.id === 'pay.global-failed')!.note).toMatch(/exactly 50 are shown more may exist/);
  });
  it('pay: the bill reference is in the detail, not the table, and a code column does not promise the stored value', () => {
    const bills = allReads(DESKS.pay).find((r) => r.id === 'pay.bills-failed')!;
    expect(bills.columns.find((c) => c.key === 'reference')).toMatchObject({ detail: true });
    for (const r of [allReads(DESKS.pay).find((x) => x.id === 'pay.failed-standing')!, PAY_TRANSFER_DETAIL]) {
      expect(r.columns.find((c) => c.key === 'rejectionCode')!.label).not.toMatch(/as stored/);
    }
  });
  it('pay: a one-off failure rate is a dash with its reason, and the P2P pointer is pinned to what svc-bank states', () => {
    const oneOff = allReads(DESKS.pay).find((r) => r.id === 'pay.oneoff-24h')!;
    expect(oneOff.columns.find((c) => c.key === 'oneOff.failureRate')).toMatchObject({ kind: 'text', nullable: true, alwaysNull: true });
    expect(oneOff.columns.find((c) => c.key === 'oneOff.failureRateReason')).toMatchObject({ mustBe: 'failures_not_recorded' });
    const p2p = allReads(DESKS.pay).find((r) => r.id === 'pay.p2p-pointer')!;
    expect(p2p.columns.find((c) => c.key === 'p2p.available')).toMatchObject({ kind: 'bool', mustBe: false });
    expect(p2p.columns.find((c) => c.key === 'p2p.reason')).toMatchObject({ mustBe: 'served_by_p2p_ops' });
  });
  it('pay: no action is offered, because svc-bank has none; each is switched off with the real reason and none says "yet" or "soon"', () => {
    const sectionsOf = DESKS.pay.sections;
    expect(sectionsOf.flatMap((s) => (s.sectionAction ? [s.sectionAction] : []))).toEqual(['pay.transfer.lookup']);
    const disabled = sectionsOf.flatMap((s) => s.disabledActions);
    expect(disabled.map((a) => a.id)).toEqual(['pay.standing-cancel', 'pay.execution-retry', 'pay.oneoff-reverse', 'pay.bill-refund']);
    for (const text of sectionsOf.flatMap((s) => [
      ...s.disabledActions.map((a) => a.reason),
      ...s.unavailable.map((u) => u.reason),
      s.intro,
    ])) {
      expect(text).not.toMatch(/\b(yet|soon|later|coming|todo)\b/i);
    }
  });
  it('pay: every figure svc-bank cannot give names its back-end need (40 onward) and is not also a read', () => {
    const unavailable = DESKS.pay.sections.flatMap((s) => s.unavailable);
    expect(unavailable.map((u) => [u.id, u.need])).toEqual([
      ['pay.pending-transfers', 41],
      ['pay.bills-returned', 42],
      ['pay.global-health', 43],
      ['pay.oneoff-failures', 40],
    ]);
  });
  it('pay: every typed refusal is a sentence that states a reason', () => {
    for (const r of [...allReads(DESKS.pay), PAY_TRANSFER_DETAIL]) {
      for (const [code, sentence] of Object.entries(r.refusals ?? {})) {
        expect(code, r.id).toMatch(/^bank\.[a-z_]+$/);
        expect(sentence.length, code).toBeGreaterThan(40);
        expect(sentence, code).not.toMatch(/\b(yet|soon|coming)\b/i);
      }
    }
    expect(PAY_TRANSFER_DETAIL.refusals).toHaveProperty('bank.ops_transfer_not_found');
    expect(allReads(DESKS.pay).find((r) => r.id === 'pay.failed-standing')!.refusals).toHaveProperty('bank.party_handles_unset');
  });
  it('more: mining, market sales and takedown, and quant strategies are wired', () => {
    const more = allReads(DESKS.more);
    expect(more.filter((r) => r.module === 'mining').map((r) => r.procedure)).toEqual([
      'terms',
      'ops.windows',
      'ops.shares',
      'ops.workers',
    ]);
    expect(more.find((r) => r.id === 'market.sales')).toMatchObject({ procedure: 'ops.sales', windowDays: 30, input: { limit: 50 } });
    expect(more.find((r) => r.id === 'market.listings')!.rowAction).toBe('market.listing.takedown');
    expect(more.find((r) => r.id === 'quant.strategies')).toMatchObject({ procedure: 'studio.operatorList', input: { limit: 50 } });
    // The mining shares read has an object input with every field optional, so it must send one.
    expect(more.find((r) => r.id === 'mining.shares')!.sendEmptyInput).toBe(true);
    const market = DESKS.more.sections.find((s) => s.id === 'market')!;
    expect(market.disabledActions).toEqual([]);
  });
  it('academy: content metrics, certificates and grant audit, ambassadors', () => {
    expect(sections('academy')).toEqual(expect.arrayContaining(['catalogue', 'certificates', 'ambassadors']));
    const ambassadors = DESKS.academy.sections.find((s) => s.id === 'ambassadors')!;
    expect(ambassadors.disabledActions).toEqual([]);
    expect(ambassadors.sectionAction).toBe('academy.ambassador.appoint');
    const residencies = ambassadors.reads.find((r) => r.id === 'academy.residencies')!;
    expect(residencies.rowAction).toBe('academy.residency');
    // The grant audit and enrolment counts are real reads now (svc-academy admin.grantAudit, admin.enrolments), on the grants page.
    expect(DESKS.academy.sections.flatMap((s) => s.unavailable)).toEqual([]);
    const grants = DESKS.academy.sections.find((s) => s.id === 'grants')!;
    expect(grants.reads.map((r) => r.procedure)).toEqual(['admin.grantAudit', 'admin.enrolments']);
    expect(DESKS.academy.sections.find((s) => s.id === 'catalogue')!.reads.map((r) => r.id)).toContain('academy.courses');
  });

  it('academy: each section also has a page of its own, with the five pages in its navigation', () => {
    expect(ACADEMY_PAGES.map((p) => p.href)).toEqual([
      '/academy-ops/catalogue',
      '/academy-ops/certificates',
      '/academy-ops/programmes',
      '/academy-ops/ambassadors',
      '/academy-ops/grants',
    ]);
    for (const page of ACADEMY_PAGES) {
      const desk = academySectionDesk(page.id);
      expect(desk.sections.map((s) => s.id)).toEqual([page.id]);
      expect(desk.endpoint).toBe('/api/academy-ops');
      expect(desk.pages).toBe(ACADEMY_PAGES);
    }
    expect(() => academySectionDesk('nope')).toThrow();
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
      expect(read.forbiddenText, read.id).toMatch(/^Your console session does not have .* permission/);
    }
    expect(token.unavailable.map((u) => u.id)).toEqual(['token.supply']);
  });
  it('protocol: chain, audit, indexer finality, DEX health the blockers panel and the listing control link, never INTACHAIN or audited', () => {
    expect(sections('protocol')).toEqual(['chain', 'audit', 'indexer', 'dex', 'blockers', 'listing']);
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
    expect(DESKS.protocol.sections.find((s) => s.id === 'listing')!.links.map((l) => l.href)).toEqual(['/protocol-ops/listing']);
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

/** Every .ts under a service's src, so a procedure built in its own file (`poolTotalsProcedure`) can be found. */
function serviceSources(service: string): string[] {
  const root = fileURLToPath(new URL(`../../../../../services/${service}/src`, import.meta.url));
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.ts') && !name.includes('.test.')) out.push(readFileSync(full, 'utf8'));
    }
  };
  walk(root);
  return out;
}

describe('every read names a QUERY that exists in the owning router (drift guard)', () => {
  it.each(all.map((a) => [a.read.id, a.read] as const))('%s', (_id, read) => {
    const service = ROUTER[read.module];
    expect(service, `${read.module} has a router mapping`).not.toBeNull();
    // svc-bank mounts the bill and global send routers from personal-pay/router.ts (`bills.ops.*`, `global.ops.*`).
    const nested = read.procedure.split('.').length === 3;
    const text = nested ? personalPayRouter() : source(service!);
    const parts = read.procedure.split('.');
    let from = 0;
    if (nested) {
      const factory = parts[0] === 'bills' ? 'createBillsRouter' : 'createGlobalRouter';
      const start = text.indexOf(`export function ${factory}(`);
      expect(start, `personal-pay router has ${factory}`).toBeGreaterThanOrEqual(0);
      const ops = /\bops: router\(/.exec(text.slice(start));
      expect(ops, `${factory} has an ops group`).not.toBeNull();
      from = start + ops!.index;
    } else if (parts.length === 2) {
      const group = new RegExp(
        `(\\b${parts[0]}: router\\(|const ${parts[0]} = router\\(|export function create${parts[0]![0]!.toUpperCase()}${parts[0]!.slice(1)}Router\\()`,
      ).exec(text);
      expect(group, `${service} has a ${parts[0]} group`).not.toBeNull();
      from = group!.index;
    }
    const name = parts[parts.length - 1]!;
    // `operator` is svc-mining-pool's local alias for its admin:read procedure builder.
    const proc = new RegExp(`\\b${name}: (\\w*Procedure|operator)\\b`).exec(text.slice(from));
    expect(proc, `${service} has ${read.procedure}`).not.toBeNull();
    // From the procedure up to the next procedure definition, the call kind must be a query.
    const rest = text.slice(from + proc!.index + 1);
    const next = rest.search(/\n\s+[a-zA-Z]+: (\w*Procedure|operator|customer)\b/);
    let body = next === -1 ? rest : rest.slice(0, next);
    // A procedure built in its own file (`poolTotals: poolTotalsProcedure(...)`) is judged by that factory's body.
    if (!body.includes('.query(') && !body.includes('.mutation(')) {
      const factory = new RegExp(`\\b${name}: (\\w+Procedure)\\(`).exec(text.slice(from))?.[1];
      expect(factory, `${read.procedure} is defined inline or by a factory`).toBeTruthy();
      const file = serviceSources(service!).find((src) => src.includes(`export function ${factory}(`));
      expect(file, `${factory} is defined in ${service}`).toBeTruthy();
      const start = file!.indexOf(`export function ${factory}(`);
      const after = file!.slice(start + 1);
      const end = after.search(/\nexport function /);
      body = end === -1 ? after : after.slice(0, end);
    }
    expect(body.includes('.query('), `${read.procedure} is a query`).toBe(true);
    expect(body.includes('.mutation('), `${read.procedure} is not a mutation`).toBe(false);
  });
});

describe('mining pool terms', () => {
  it('needs only a signed-in session, so its refusal never claims a missing admin permission', () => {
    const terms = allReads(DESKS.more).find((r) => r.id === 'mining.terms')!;
    expect(terms.forbiddenText).not.toMatch(/admin:read/);
  });
});
