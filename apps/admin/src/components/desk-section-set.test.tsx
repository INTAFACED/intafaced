import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DeskSectionSet } from './desk-section-set';
import { OpsDeskView } from './ops-desk';
import { DESKS, MINING_DESK } from '@/lib/ops-desk/catalog';
import { COMMON_SECTION_IDS } from '@/lib/ops-desk/common-sections';
import type { DeskView, ReadOutcome } from '@/lib/ops-desk/types';

const AT = '2026-10-22T23:00:00.000Z';
const failed = (id: string): ReadOutcome => ({
  id,
  asOf: AT,
  part: { kind: 'failed', message: 'refused', code: 'denied.kyc_required', notBuilt: false, forbidden: true },
});
const ok = (id: string): ReadOutcome => ({ id, asOf: AT, part: { kind: 'ok', data: { shape: 'record', cells: [] } } });

describe('DeskSectionSet', () => {
  it('draws all eight sections on the bank desk, with unwired ones naming their blocker and code', () => {
    const html = renderToStaticMarkup(<DeskSectionSet setId="bank" spec={DESKS.bank} view={null} />);
    for (const id of COMMON_SECTION_IDS) expect(html).toContain(`data-testid="common-${id}"`);
    expect(html).toContain('Audit: no source');
    expect(html).toContain('ops.desk_section_unwired');
    expect(html).toContain('href="#loans"');
    expect(html).toContain('href="/#module=bank"');
  });

  it('counts only the reads behind a section, from what the desk read', () => {
    const view: DeskView = { deskId: 'bank', asOf: AT, reads: { 'bank.health': ok('bank.health') } };
    const html = renderToStaticMarkup(<DeskSectionSet setId="bank" spec={DESKS.bank} view={view} />);
    // Overview is the service section: one read, answered.
    expect(html).toMatch(/data-testid="common-overview"[^]*?1 of 1 reads answered/);
  });

  it('predict: every section unwired, nothing read', () => {
    const html = renderToStaticMarkup(<DeskSectionSet setId="predict" spec={null} view={null} />);
    expect(html.match(/data-state="unwired"/g)).toHaveLength(8);
    expect(html).not.toContain('reads answered');
  });
});

describe('OpsDeskView with a common set', () => {
  const base = { loading: false, userId: 'u', openKey: null, onOpen: () => {}, onRefresh: () => {} };

  it('bank, pay and academy show the set; p2p and protocol do not', () => {
    for (const id of ['bank', 'pay', 'academy'] as const) {
      expect(renderToStaticMarkup(<OpsDeskView {...base} spec={DESKS[id]} view={null} />)).toContain('data-testid="common-sections"');
    }
    for (const id of ['p2p', 'protocol'] as const) {
      expect(renderToStaticMarkup(<OpsDeskView {...base} spec={DESKS[id]} view={null} />)).not.toContain('data-testid="common-sections"');
    }
  });

  it('the mining desk counts its own reads only, not the rest of the More modules read', () => {
    const reads = Object.fromEntries(
      [...MINING_DESK.sections.flatMap((s) => s.reads.map((r) => r.id)), 'agents.routes', 'market.applications'].map((id) => [
        id,
        failed(id),
      ]),
    );
    const html = renderToStaticMarkup(<OpsDeskView {...base} spec={MINING_DESK} view={{ deskId: 'more', asOf: AT, reads }} />);
    const own = MINING_DESK.sections.flatMap((s) => s.reads).length;
    expect(html).toContain(`0 of ${own} reads answered`);
    expect(html).toContain('Mining operations');
    expect(html).not.toContain('data-testid="section-agents"');
  });
});
