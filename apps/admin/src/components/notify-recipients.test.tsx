import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RecipientTable, ReleaseNotice } from './notify-recipients';
import type { RecipientRow, RecipientState, RecipientsRead } from '@/lib/notify/recipients-model';

const row = (over: Partial<RecipientRow> = {}): RecipientRow => ({
  userId: '11111111-1111-4111-8111-111111111111',
  channel: 'email',
  address: 'a***@example.com',
  state: 'quarantined',
  consecutiveFailures: 3,
  lastFailureAt: '2026-10-20T10:00:00.000Z',
  lastFailureCode: 'channel.provider_rejected',
  quarantinedAt: '2026-10-20T10:00:01.000Z',
  quarantineReason: null,
  ...over,
});
const read = (items: RecipientRow[], over: Partial<RecipientsRead> = {}): RecipientsRead => ({
  state: 'quarantined' as RecipientState,
  limit: 200,
  threshold: 3,
  thresholdCode: null,
  items,
  ...over,
});
const render = (r: RecipientsRead, notConnected = {}) =>
  renderToStaticMarkup(<RecipientTable read={r} notConnected={notConnected} onChanged={() => undefined} />);

describe('recipient health', () => {
  it('lists quarantined addresses masked, with a release control', () => {
    const html = render(read([row()]));
    expect(html).toContain('a***@example.com');
    expect(html).toContain('Release…');
    expect(html).toContain('after 3 terminal failures in a row');
  });
  it('a blank threshold says svc-notify never quarantines', () => {
    const html = render(read([], { threshold: null, thresholdCode: 'notify.quarantine_threshold_unset' }));
    expect(html).toContain('notify.quarantine_threshold_unset');
    expect(html).toContain('data-testid="recipients-empty"');
  });
  it('an empty tab says what empty means, and has no release control on other tabs', () => {
    expect(render(read([], { state: 'unconfirmed' }))).toContain('No unconfirmed addresses');
    const html = render(read([row({ state: 'active', quarantinedAt: null })], { state: 'active' }));
    expect(html).not.toContain('Release…');
  });
  it('names the vendor for a channel with no sender and flags a full page', () => {
    const html = render(read([row({ channel: 'sms' })], { limit: 1 }), { sms: 'vendor.sms' });
    expect(html).toContain('vendor.sms');
    expect(html).toContain('The page is full (1)');
  });
  it('keeps the release answer on screen: success, replay, and an unknown outcome that says to read the list', () => {
    expect(renderToStaticMarkup(<ReleaseNotice reply={{ ok: true, replayed: false }} />)).toContain('Released.');
    expect(renderToStaticMarkup(<ReleaseNotice reply={{ ok: true, replayed: true }} />)).toContain('already been released');
    const html = renderToStaticMarkup(
      <ReleaseNotice
        reply={{ ok: false, title: 'The outcome is not known', body: 'Dropped.', next: 'Read the list again.', changed: 'unknown' }}
      />,
    );
    expect(html).toContain('data-testid="release-unknown"');
    expect(html).toContain('The outcome is not known');
  });
});
