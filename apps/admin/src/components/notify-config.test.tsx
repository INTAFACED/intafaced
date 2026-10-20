import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NotifyConfigDesk } from './notify-config';
import type { NotifyConfigView } from '@/lib/notify/config-model';

const view = (over: Partial<NotifyConfigView> = {}): NotifyConfigView => ({
  asOf: '2026-10-17T03:00:00.000Z',
  channels: {
    kind: 'ok',
    data: [
      {
        channel: 'email',
        configured: false,
        requires: ['EMAIL_API_KEY'],
        enabled: true,
        adapter: null,
        version: 1,
        effective: 'unconfigured',
        notConnected: null,
      },
      {
        channel: 'sms',
        configured: true,
        requires: [],
        enabled: false,
        adapter: 'gateway-a',
        version: 3,
        effective: 'disabled',
        notConnected: null,
      },
    ],
  },
  templates: {
    kind: 'ok',
    data: [
      {
        key: 'login_code',
        fields: ['brand', 'code'],
        current: {
          version: 2,
          subject: 'Your code',
          body: 'b',
          authorId: '11111111-1111-4111-8111-111111111111',
          createdAt: '2026-10-17T02:00:00.000Z',
        },
      },
      { key: 'kyc_decision', fields: ['decision'], current: null },
    ],
  },
  ...over,
});
const render = (v: NotifyConfigView | null) => renderToStaticMarkup(<NotifyConfigDesk view={v} />);

describe('channels and templates', () => {
  it('a switched-on channel with no credentials still reads unconfigured and names what is missing', () => {
    const html = render(view());
    expect(html).toContain('Unconfigured');
    expect(html).toContain('Missing: EMAIL_API_KEY');
    expect(html).not.toContain('Sending');
    expect(html).toContain('Switched off');
  });
  it('a template with no saved version says nothing is sent from it', () => {
    expect(render(view())).toContain('No version saved, so nothing is sent from this template.');
  });
  it('names the blocker and offers no edit control', () => {
    const html = render(view());
    expect(html).toContain('data-testid="notify-config-blocker"');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<input');
  });
  it('a failed read says why and shows no table', () => {
    const failed = {
      kind: 'failed',
      message: 'svc-notify did not accept your founder session (admin:read).',
      code: null,
      notBuilt: false,
      forbidden: true,
    } as const;
    const html = render(view({ channels: failed, templates: failed }));
    expect(html).toContain('Channel settings unavailable');
    expect(html).toContain('admin:read');
    expect(html).not.toContain('aria-label="Channel settings"');
  });
  it('no read at all says so', () => {
    expect(render(null)).toContain('Nothing is shown rather than a guess');
  });
});
