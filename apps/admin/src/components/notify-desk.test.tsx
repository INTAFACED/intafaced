import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NotifyDeskView } from './notify-desk';
import type { DeliveryRow, NotifyView } from '@/lib/notify/model';

const row = (over: Partial<DeliveryRow> = {}): DeliveryRow => ({
  id: crypto.randomUUID(),
  notificationId: '33333333-3333-4333-8333-333333333333',
  channel: 'email',
  status: 'accepted',
  attempts: 1,
  attemptedAt: '2026-10-17T02:00:00.000Z',
  acceptedAt: '2026-10-17T02:00:01.000Z',
  refusalCode: null,
  createdAt: '2026-10-17T02:00:00.000Z',
  updatedAt: '2026-10-17T02:00:01.000Z',
  ...over,
});
const view = (rows: DeliveryRow[], limit = 200, fanout = true): NotifyView => ({
  asOf: '2026-10-17T03:00:00.000Z',
  deliveries: { kind: 'ok', data: { rows, limit } },
  health: { kind: 'ok', data: { ok: true, fanoutEnabled: fanout } },
});
const render = (v: NotifyView | null, loading = false) =>
  renderToStaticMarkup(<NotifyDeskView view={v} loading={loading} onRefresh={() => undefined} />);

describe('delivery health', () => {
  it('shows per-channel counts with accepted-of-settled spelled out, and the time it was read', () => {
    const html = render(
      view([row(), row(), row({ status: 'refused', refusalCode: 'channel.not_configured', acceptedAt: null }), row({ channel: 'inapp' })]),
    );
    expect(html).toContain('data-testid="channel-email"');
    expect(html).toContain('66% (2 of 3)');
    expect(html).toContain('channel.not_configured ×1');
    expect(html).toContain('As of 2026-10-17T03:00:00.000Z');
  });
  it('says what the figures cover, and that a full page is not all-time', () => {
    expect(render(view([row()], 200))).toContain('svc-notify returned nothing older');
    const full = render(view([row(), row()], 2));
    expect(full).toContain('The page is full (2)');
    expect(full).toContain('not all-time');
  });
  it('never claims a delivered fact', () => {
    const html = render(view([row()]));
    expect(html).toContain('does not claim one');
    expect(html.replace(/svc-notify has no “delivered” fact, so this page does not claim one\./, '')).not.toMatch(/delivered/i);
  });
  it('no rows is "none recorded", not healthy', () => {
    const html = render(view([]));
    expect(html).toContain('data-testid="notify-empty"');
    expect(html).toContain('not that anything is healthy');
  });
  it('lists failures with their codes and shows an empty failure list plainly', () => {
    const failing = render(view([row({ status: 'failed', refusalCode: 'gateway.timeout', attempts: 3, acceptedAt: null })]));
    expect(failing).toContain('aria-label="Failed deliveries"');
    expect(failing).toContain('gateway.timeout');
    expect(render(view([row()]))).toContain('No refused, failed or abandoned deliveries in these rows.');
  });
  it('fan-out off is a stopped badge, not a quiet footnote', () => {
    const html = render(view([row()], 200, false));
    expect(html).toContain('data-state="stopped"');
    expect(html).toContain('Out-of-app fan-out is OFF');
  });
});

describe('what it cannot show', () => {
  it('a founder without the operator read permission sees why and no figures', () => {
    const html = render({
      asOf: 'x',
      deliveries: {
        kind: 'failed',
        message: 'svc-notify did not accept your founder session (admin:read).',
        code: null,
        notBuilt: false,
        forbidden: true,
      },
      health: { kind: 'ok', data: { ok: true, fanoutEnabled: true } },
    });
    expect(html).toContain('Delivery outcomes unavailable');
    expect(html).toContain('admin:read');
    expect(html).not.toContain('channel-stats');
  });
  it('no read at all says so', () => {
    expect(render(null)).toContain('Nothing is shown rather than a guess');
  });
  it('is read-only: no form, no action button besides refresh', () => {
    const html = render(view([row({ status: 'failed', acceptedAt: null })]));
    expect(html).not.toContain('<form');
    expect((html.match(/<button/g) ?? []).length).toBe(1);
  });
});
