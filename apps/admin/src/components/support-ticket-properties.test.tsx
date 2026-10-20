import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LABELS_MAX, parseLabels, propertiesGate } from '@/lib/support/model';
import type { SupportPropertiesView } from '@/lib/support/types';
import {
  TicketPropertiesView,
  changeFrom,
  emptyPropertiesForm,
  type TicketPropertiesViewProps,
  type PropertiesForm,
} from './support-ticket-properties';

const T1 = '22222222-2222-4222-8222-222222222222';
const held = (over: Record<string, unknown> = {}) => ({
  ticketId: T1,
  priority: 'high' as const,
  ticketType: null,
  labels: ['vip', 'refund'],
  updatedAt: '2026-10-20T03:00:00.000Z',
  ...over,
});
const okView = (over: Record<string, unknown> = {}): SupportPropertiesView => ({
  asOf: '2026-10-20T04:00:00.000Z',
  properties: { kind: 'ok', data: held(over) } as SupportPropertiesView['properties'],
});
const form = (over: Partial<PropertiesForm> = {}): PropertiesForm => ({ ...emptyPropertiesForm, ...over });
const base = (over: Partial<TicketPropertiesViewProps> = {}): TicketPropertiesViewProps => ({
  ticket: { id: T1, status: 'open' },
  view: okView(),
  loading: false,
  form: emptyPropertiesForm,
  armed: false,
  busy: false,
  outcome: null,
  onField: () => undefined,
  onArm: () => undefined,
  onSend: () => undefined,
  ...over,
});
const html = (p: TicketPropertiesViewProps) => renderToStaticMarkup(<TicketPropertiesView {...p} />);

describe('what the form asks for', () => {
  const current = held();
  it('sends nothing when nothing changed', () => {
    expect(changeFrom(current, emptyPropertiesForm)).toEqual({});
    expect(changeFrom(current, form({ priority: 'high', labels: 'vip refund' }))).toEqual({});
  });
  it('sends only the fields that changed, and clear as null', () => {
    expect(changeFrom(current, form({ priority: 'urgent' }))).toEqual({ priority: 'urgent' });
    expect(changeFrom(current, form({ priority: 'clear', ticketType: 'incident' }))).toEqual({ priority: null, ticketType: 'incident' });
    expect(changeFrom(current, form({ labels: 'vip, refund vip fraud' }))).toEqual({ labels: ['vip', 'refund', 'fraud'] });
  });
  it('clearing what is not set is no change', () => {
    expect(changeFrom(current, form({ ticketType: 'clear' }))).toEqual({});
  });
  it('emptying the labels clears them', () => {
    expect(changeFrom(current, form({ labels: '' }))).toEqual({ labels: [] });
  });
});

describe('the gate', () => {
  it('needs a change, a bad label is named, a closed ticket is refused', () => {
    expect(propertiesGate({ status: 'open' }, {}, '', false).ok).toBe(false);
    expect(propertiesGate({ status: 'open' }, { priority: 'low' }, '', false).ok).toBe(true);
    const bad = propertiesGate({ status: 'open' }, { labels: ['ok', 'no!'] }, '', false);
    expect(bad.ok === false && bad.why).toContain('no!');
    expect(propertiesGate({ status: 'closed' }, { priority: 'low' }, '', false).ok).toBe(false);
    expect(propertiesGate({ status: 'open' }, { labels: Array.from({ length: LABELS_MAX + 1 }, (_, i) => `l${i}`) }, '', false).ok).toBe(
      false,
    );
    expect(propertiesGate({ status: 'open' }, { priority: 'low' }, '', true).ok).toBe(false);
  });
  it('parses labels split on commas and spaces, once each', () => {
    expect(parseLabels(' a,b  a\nc ')).toEqual(['a', 'b', 'c']);
  });
});

describe('the panel', () => {
  it('shows what svc-support holds, and "Not set" rather than a guess', () => {
    const out = html(base());
    expect(out).toContain('data-testid="prop-priority">high<');
    expect(out).toContain('data-testid="prop-type">Not set<');
    expect(out).toContain('vip, refund');
  });
  it('says so when it could not read, instead of drawing empty properties', () => {
    const out = html(base({ view: null }));
    expect(out).toContain('could not be read');
    expect(out).not.toContain('data-testid="prop-priority"');
  });
  it('shows a refusal on the read as that part’s refusal', () => {
    const failed: SupportPropertiesView = {
      asOf: '2026-10-20T04:00:00.000Z',
      properties: { kind: 'failed', forbidden: true, message: 'denied', code: null } as SupportPropertiesView['properties'],
    };
    expect(html(base({ view: failed }))).toContain('Properties unavailable');
  });
  it('offers the review step only with a change, and a second click when armed', () => {
    expect(html(base())).toContain('Change at least one of priority, type or labels first.');
    const armed = html(base({ form: form({ priority: 'low' }), armed: true }));
    expect(armed).toContain('Yes, save');
  });
  it('is on the page for a closed ticket and says why it cannot save', () => {
    const out = html(base({ ticket: { id: T1, status: 'closed' }, form: form({ priority: 'low' }) }));
    expect(out).toContain('data-testid="ticket-properties"');
    expect(out).toContain('closed');
  });
});
