// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { researchProvenanceSchema, type ResearchProvenance as Provenance } from '@intafaced/contracts/agents-research';
import { ResearchProvenance, ResearchReply } from './ResearchProvenance';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** RC-agents-09 (J-agents-10 #4): the block shows every part of the provenance svc-agents built, and nothing else. */
const PROVENANCE: Provenance = researchProvenanceSchema.parse({
  sources: [{ id: 'S1', market: 'BTC/USDT', measure: 'last_price', value: '64000.5', observedAt: '2026-11-14T08:00:00.000Z' }],
  observedAt: '2026-11-14T08:00:00.000Z',
  environment: 'TEST',
  assumptions: ['last_trade_at_observation', 'named_markets_only'],
  uncertainty: { level: 'TEST medium', scale: ['TEST low', 'TEST medium', 'TEST high'], unsupportedCount: 1, claimCount: 2 },
  unsupported: ['It will double next week.'],
  notAdvice: true,
});

function render(node: React.ReactNode) {
  const host = document.createElement('div');
  document.body.append(host);
  act(() => createRoot(host).render(node));
  return host;
}

const terms = (host: HTMLElement) => [...host.querySelectorAll('dt')].map((dt) => dt.textContent);
const definition = (host: HTMLElement, term: string) =>
  [...host.querySelectorAll('dt')].find((dt) => dt.textContent === term)!.nextElementSibling!.textContent;

describe('ResearchProvenance', () => {
  it('shows the source, the observation time, the environment, the assumptions, the uncertainty and the unsupported claims', () => {
    const host = render(<ResearchProvenance provenance={PROVENANCE} />);
    const region = host.querySelector('section[aria-label="Where this came from"]')!;
    expect(region).not.toBeNull();
    expect(terms(host)).toEqual(['Source', 'Observed at', 'Environment', 'Assumptions', 'Uncertainty', 'Unsupported claims']);
    expect(definition(host, 'Source')).toContain('[S1] BTC/USDT last traded price: 64000.5');
    expect(host.querySelector('[data-testid="research-observed-at"]')!.getAttribute('datetime')).toBe('2026-11-14T08:00:00.000Z');
    expect(definition(host, 'Environment')).toBe('TEST data from the test stack, not a live market');
    expect(definition(host, 'Assumptions')).toContain('may have moved since');
    expect(definition(host, 'Assumptions')).toContain('Only the markets your question names were read.');
    expect(definition(host, 'Uncertainty')).toBe(
      'TEST medium, on a scale of TEST low · TEST medium · TEST high: 1 of 2 sentences cite no source.',
    );
    expect(definition(host, 'Unsupported claims')).toBe('It will double next week.');
    expect(region.textContent).toContain('A claim with no source is marked unsupported.');
    expect(host.querySelector('[role="note"]')!.textContent).toBe(
      'This is the agent’s reading of the sources above, not an exchange record and not advice.',
    );
  });

  it('keeps every part visible when a part is empty', () => {
    const host = render(
      <ResearchProvenance
        provenance={{ ...PROVENANCE, assumptions: [], unsupported: [], uncertainty: { ...PROVENANCE.uncertainty, unsupportedCount: 0 } }}
      />,
    );
    expect(terms(host)).toHaveLength(6);
    expect(definition(host, 'Assumptions')).toBe('None');
    expect(definition(host, 'Unsupported claims')).toBe('None: every sentence cites a source.');
  });
});

describe('ResearchReply', () => {
  it('marks each unsupported sentence and leaves a cited one unmarked', () => {
    const host = render(<ResearchReply text={'BTC/USDT last traded at 64000.5 [S1]. It will double next week.'} provenance={PROVENANCE} />);
    const marks = [...host.querySelectorAll('[data-testid="unsupported-claim"]')];
    expect(marks).toHaveLength(1);
    expect(marks[0]!.previousElementSibling!.textContent).toBe('It will double next week.');
    expect(host.textContent).toBe('BTC/USDT last traded at 64000.5 [S1]. It will double next week. Unsupported');
  });
});
