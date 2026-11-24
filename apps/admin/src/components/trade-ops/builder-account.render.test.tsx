import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TRADE_BUILDER_ACCOUNT_MODE } from '@intafaced/contracts/trade-builder-mode-procedures';
import type { BuilderAccountView } from '@/lib/trade-ops/builder-account-model';
import { BuilderAccount } from './builder-account';

// J-ops-console-28: the builder account room, rendered from replies that pass the record's own schema. TEST figures.

const BUILDER = '0x116d8f7751e72306d499dd61ae826e46a726c632';
const CONTACT = 'TEST founders on call (oncall@intafaced.test)';
const venue = (venueId: string, over: Partial<BuilderAccountView['venues'][number]>): BuilderAccountView['venues'][number] => ({
  venueId,
  displayName: `TEST ${venueId}`,
  test: true,
  builder: BUILDER,
  mode: { status: 'read', mode: 'standard', asOf: '2026-11-21T03:00:01.000Z' },
  required: { status: 'published', mode: 'standard' },
  verdict: 'required_mode',
  ...over,
});
const view = (over: Partial<BuilderAccountView>): BuilderAccountView =>
  TRADE_BUILDER_ACCOUNT_MODE.output.parse({
    asOf: '2026-11-21T03:00:02.000Z',
    builder: BUILDER,
    venues: [venue('test-venue-sim', {})],
    alerting: { status: 'on', contact: CONTACT },
    alerts: [],
    ...over,
  });
const html = (v: BuilderAccountView) => renderToStaticMarkup(<BuilderAccount view={v} />);

describe('the builder account room', () => {
  it('shows each venue: our address, the mode as the venue reports it with its time, the required mode', () => {
    const out = html(view({}));
    expect(out).toMatch(/data-venue="test-venue-sim" data-verdict="required_mode"/);
    expect(out).toContain(BUILDER);
    expect(out).toMatch(/data-cell="mode">standard<span[^>]*>TEST<\/span>/);
    expect(out).toContain('2026-11-21 03:00:01 UTC');
    expect(out).toMatch(/data-cell="required">standard</);
    expect(out).toContain(`An alert goes once to ${CONTACT}`);
    expect(out).toContain('No alert has been sent.');
  });

  it('out of mode: the words, and the open alert with the contact; cleared: the time', () => {
    const out = html(
      view({
        venues: [
          venue('test-venue-sim', {
            mode: { status: 'read', mode: 'unified', asOf: '2026-11-21T03:00:01.000Z' },
            verdict: 'not_collected',
          }),
        ],
        alerts: [
          {
            id: '2',
            venueId: 'test-venue-sim',
            builder: BUILDER,
            modeSeen: 'unified',
            requiredMode: 'standard',
            contact: CONTACT,
            openedAt: '2026-11-21T03:00:00.000Z',
            clearedAt: null,
            clearedMode: null,
          },
          {
            id: '1',
            venueId: 'test-venue-sim',
            builder: BUILDER,
            modeSeen: 'portfolio_margin',
            requiredMode: 'standard',
            contact: CONTACT,
            openedAt: '2026-11-21T02:00:00.000Z',
            clearedAt: '2026-11-21T02:10:00.000Z',
            clearedMode: 'standard',
          },
        ],
      }),
    );
    expect(out).toContain('Builder fees not collected in this mode');
    expect(out).toMatch(/data-alert="2"[^>]*data-state="open".*data-cell="contact">TEST founders on call \(oncall@intafaced.test\)</);
    expect(out).toMatch(/data-alert="1"[^>]*data-state="cleared".*Cleared 2026-11-21 02:10:00 UTC, back in standard/);
  });

  it('a mode that cannot be read reads unknown, never ok; an unpublished requirement reads not published', () => {
    const out = html(
      view({
        venues: [
          venue('a', {
            mode: { status: 'unknown', code: 'venue_down', message: 'TEST venue down' },
            required: { status: 'unknown' },
            verdict: 'unknown',
          }),
          venue('b', { required: { status: 'not_published' }, verdict: 'not_published' }),
        ],
      }),
    );
    expect(out).toMatch(
      /data-venue="a" data-verdict="unknown".*data-cell="mode">unknown .*data-cell="as-of">unknown.*data-cell="required">unknown.*data-cell="verdict"[^>]*>unknown</,
    );
    expect(out).not.toMatch(/data-venue="a"[^]*?Collected/);
    expect(out).toMatch(/data-venue="b".*data-cell="required">not published</);
  });

  it('a blank contact refuses alerting by name', () => {
    const out = html(
      view({
        alerting: {
          status: 'refused',
          code: 'trade.builder_mode_alert_contact_unset',
          message: 'No alert contact is named, so no alert is sent',
        },
      }),
    );
    expect(out).toContain('data-alerting="refused"');
    expect(out).toContain('No alert contact is named, so no alert is sent (trade.builder_mode_alert_contact_unset).');
  });
});
