import { describe, expect, it } from 'vitest';
import { createEdgeContext } from '@intafaced/contracts';
import { createNotifyRouter } from './router.js';
import type { NotifyService } from './notify-service.js';
import {
  FANOUT_MOUNTAIN_ID,
  HONEST_GAPS,
  NOTIFY_CHANNEL_SOCKET_IDS,
  mountainVsSocketsStatusLineMatches,
} from './channels/mountain-vs-sockets.js';
import { OUT_OF_APP_CHANNELS } from './channels/channel.js';
import { describeChannelsPolicy } from './channels-policy.js';

const edgeContext = createEdgeContext({ secret: 'a-notify-policy-test-edge-secret-long', serviceName: 'svc-notify' });
const anonymous = () => edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });

function stubNotify(): NotifyService {
  return { fanoutEnabled: true } as NotifyService;
}

describe('describeChannelsPolicy — ops.notifications honesty door', () => {
  it('summarizes mountain vs socket split without inventing providers', () => {
    const p = describeChannelsPolicy();
    expect(p.mountainId).toBe(FANOUT_MOUNTAIN_ID);
    expect(p.outOfAppChannels).toEqual([...OUT_OF_APP_CHANNELS]);
    expect(p.socketIds).toEqual([...NOTIFY_CHANNEL_SOCKET_IDS]);
    expect(p.honestGaps).toEqual([...HONEST_GAPS]);
    expect(p.matrixComplete).toBe(true);
    expect(p.inappHasNoSocket).toBe(true);
    expect(p.inventsProviders).toBe(false);
    expect(p.acceptedIsNotDelivered).toBe(true);
    expect(p.mountainDoneForbiddenWhileAllOutOfAppRefuse).toBe(true);
    expect(mountainVsSocketsStatusLineMatches()).toBe(true);
    expect(p.statusLine).toContain('mountain=ops.notifications');
    expect(p.export).toContain('channel,plane,socket');
  });
});

describe('notify.channelsPolicy route (ops.notifications honesty door)', () => {
  it('public query mirrors describeChannelsPolicy', async () => {
    const result = await createNotifyRouter(stubNotify()).createCaller(anonymous()).notify.channelsPolicy();
    expect(result).toEqual(describeChannelsPolicy());
  });
});
