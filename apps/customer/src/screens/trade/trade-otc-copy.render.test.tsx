// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeskStatusStrip } from './otc/DeskStatusStrip';
import { otcCopy } from './otc/copy';
import { optionsCopy } from './options/copy';
import { Ticket } from './options/Ticket';
import { execCopy } from './execution/copy';
import { marginCopy } from './margin/margin-copy';
import { StatusBanner } from '../charts/DataStatus';
import type { DataStatus } from '../charts/data-status';
import { AccountBadge } from './copybots/parts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../app/feature-registry', async (original) => {
  const real = await original<typeof import('../../app/feature-registry')>();
  return { ...real, isDevBuild: () => false };
});

vi.mock('./desk/data', () => ({
  useDeskApi: () => ({ preview: vi.fn(), place: vi.fn() }),
  useRefreshPrivate: () => vi.fn(),
}));

let host: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  if (root) {
    const mounted = root;
    root = null;
    act(() => mounted.unmount());
  }
  host.remove();
  document.getElementById('local-test-stack-banner')?.remove();
});

function render(node: React.ReactElement) {
  root = createRoot(host);
  const mounted = root;
  act(() => mounted.render(node));
}

describe('Trade and OTC customer copy (#6177)', () => {
  it('/otc desk status strip speaks plainly without Maker routing, Platform only, Mid feed or Not wired', () => {
    render(
      <DeskStatusStrip
        desk={{
          status: 'ready',
          asOf: 0,
          data: {
            published: true,
            statusLine: 'TEST',
            makerRouting: { published: false },
            midFeed: { wiring: 'boot', published: false },
            assets: ['BTC'],
            minTier: 'full',
          },
        }}
      />,
    );
    const text = host.textContent ?? '';
    expect(text).not.toContain('Maker routing');
    expect(text).not.toContain('Platform only');
    expect(text).not.toContain('Mid feed');
    expect(text).not.toContain('Not wired');
    expect(text).toContain('Direct desk');
    expect(text).toContain('Unavailable');
    expect(otcCopy.t('Buttons note')).not.toContain('ledger');
  });

  it('/trade/options uses plain chip copy and explains an empty contract list on the ticket', () => {
    expect(optionsCopy.t('Live orders blocked')).not.toContain('blocked');
    expect(optionsCopy.t('No paper contract listed')).not.toContain('Paper orders:');
    expect(optionsCopy.t('Held by the service')).not.toContain('service');
    render(
      <Ticket
        market={null}
        hasContracts={false}
        policy={{
          status: 'ready',
          asOf: 0,
          data: {
            allowed: { optionsOrders: true, paperOptionsOrders: true, liveOptionsOrders: false },
            settlementAssetLawStamped: false,
            settlementFixingConfigured: false,
            blockers: [],
            residual: '',
            statusLine: 'TEST',
            europeanOnly: true,
            fullCollateralV1: true,
          },
        }}
        writer={{
          signedIn: true,
          busy: false,
          outcome: { kind: 'idle' },
          note: { state: 'none' },
          run: vi.fn(),
          resolve: vi.fn(),
          dismiss: vi.fn(),
        }}
      />,
    );
    expect(host.textContent).toContain('No option contracts are listed right now.');
    expect(host.textContent).not.toContain('Pick a contract in the chain first.');
  });

  it('/trade/bots/grid AccountBadge never claims real orders on a test build carrying the local-test banner', () => {
    const banner = document.createElement('div');
    banner.id = 'local-test-stack-banner';
    document.body.append(banner);
    render(<AccountBadge paper={false} />);
    expect(host.textContent).toContain('TEST account: no real money');
    expect(host.textContent).not.toContain('Live account: real orders');
  });

  it('/trade/margin speaks plainly without internal service wording or raw ADL acronym', () => {
    expect(marginCopy.t('Band note')).not.toContain('until the service publishes the inputs');
    expect(marginCopy.t('ADL notice')).not.toContain('ADL');
    expect(marginCopy.t('Liquidation point 4')).toContain('auto-deleveraging');
    expect(marginCopy.t('Switch mode reason')).not.toContain('The service');
  });

  it('/execution uses plain schedule wording without Scheduler running, Open by id or The service lists no schedules', () => {
    expect(execCopy.t('Scheduler running')).not.toContain('Scheduler');
    expect(execCopy.t('Open by id')).not.toBe('Open by id');
    expect(execCopy.t('No schedules known reason')).not.toContain('The service lists no schedules');
  });

  it('/charts delayed banner explains the delay in plain wording without boundary or data class jargon', () => {
    const delayed: DataStatus = {
      chip: 'delayed',
      feed: 'connected',
      ageSeconds: 354,
      feedAgeSeconds: 1,
      lastTradeMs: 0,
      state: 'OPEN',
      stateSinceMs: null,
      thresholdSeconds: 30,
      delayedBy: 'age',
      staleBy: null,
      staleAgeSeconds: 35,
      orderEntry: 'open',
      test: false,
    };
    render(<StatusBanner status={delayed} format={() => 'T'} />);
    const text = host.textContent ?? '';
    expect(text).not.toContain('boundary on a real-time market');
    expect(text).toContain('354 s ago');
    expect(text).toContain('30 s');
  });
});
