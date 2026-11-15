import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseAdapterStatus, sessionAccount, type AdapterStatus } from '@/lib/trade-ops/adapters-model';
import { AdaptersRoom } from './adapters-room';

const AS_OF = '2026-11-07T00:00:00.000Z';
const WIRE = {
  fix: {
    read: 'ok',
    sessions: [
      {
        role: 'order-entry',
        beginString: 'FIX.4.4',
        senderCompId: 'INTAFACED',
        targetCompId: 'CLIENT',
        state: 'Logged on',
        accountId: 'acct-1',
        nextSenderSeq: 3,
        nextTargetSeq: 4,
      },
      {
        role: 'drop-copy',
        beginString: 'FIX.4.4',
        senderCompId: 'INTAFACED-DC',
        targetCompId: 'CLIENT-DC',
        state: 'Not logged on',
        accountId: null,
        nextSenderSeq: 1,
        nextTargetSeq: 1,
      },
    ],
    compIdMapSet: true,
    compIdMap: [{ compId: 'CLIENT', accountId: 'acct-1' }],
    asOf: AS_OF,
  },
  sbe: {
    read: 'ok',
    codecLinked: true,
    consumers: [{ id: 'sbe-1', marketId: 'm-1', connectedAt: AS_OF, framesSent: 2, lastSequence: '17' }],
    asOf: AS_OF,
  },
  asOf: AS_OF,
};

describe('FIX and SBE room (J-cex-spot-20 #3)', () => {
  it('shows each session, the CompID map and each SBE consumer as the adapters reported them', () => {
    const status = parseAdapterStatus(WIRE) as AdapterStatus;
    expect(status).not.toBeNull();
    const html = renderToStaticMarkup(<AdaptersRoom status={status} />);
    expect(html).toContain('aria-label="FIX sessions" data-read="ok"');
    expect(html).toContain('data-session="INTAFACED:CLIENT"');
    expect(html).toContain('<td data-col="state">Logged on</td>');
    expect(html).toContain('acct-1');
    expect(html).toContain('Drop copy (no orders)');
    expect(html).toContain('data-compid="CLIENT"');
    expect(html).toContain('data-consumer="sbe-1"');
    expect(html).toMatch(/data-col="last-sequence">17</);
    // Adapters carry orders and market data only: no money or risk column.
    const headers = [...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]!).join(' ');
    expect(headers).not.toMatch(/balance|greeks|delta|margin/i);
    expect(html).not.toMatch(/\byet\b/i);
  });

  it('a refused half says why by code and shows no rows; the other half still shows', () => {
    const status = parseAdapterStatus({
      ...WIRE,
      fix: {
        read: 'refused',
        code: 'fix_status_unconfigured',
        key: 'FIX_STATUS_READ_SECRET',
        error: 'FIX_STATUS_READ_SECRET is unpublished.',
      },
    }) as AdapterStatus;
    const html = renderToStaticMarkup(<AdaptersRoom status={status} />);
    expect(html).toContain('aria-label="FIX sessions" data-read="refused"');
    expect(html).toContain('fix_status_unconfigured');
    expect(html).not.toContain('data-session=');
    // One alert for the one failed read, though two regions come from it.
    expect(html.match(/role="alert"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="CompID mapping" data-read="refused"');
    expect(html).toContain('data-consumer="sbe-1"');
  });

  it('refuses a malformed answer rather than guessing', () => {
    expect(parseAdapterStatus({ ...WIRE, sbe: { read: 'ok', consumers: 'x' } })).toBeNull();
    expect(sessionAccount({ ...WIRE.fix.sessions[0], role: 'order-entry', accountId: null } as never)).toBe('Not mapped');
  });
});
