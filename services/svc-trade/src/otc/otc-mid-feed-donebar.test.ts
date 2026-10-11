import { OtcDeskService } from '../controls/test-admission.js';
import { describe, expect, it } from 'vitest';
import { MemoryLedger, parseAmount } from '@intafaced/ledger-client';

import { FixedOtcStake } from './stake-source.js';
import {
  describeOtcMidFeedWiring,
  OTC_MID_FEED_FLAG_ON_SYMBOL_MAP_EMPTY,
  OTC_MID_FEED_FLAG_ON_VENUE_UNWIRED,
  OTC_MID_FEED_RESIDUAL,
  OTC_MID_FEED_SOCKET,
  otcMidFeedStatus,
} from './mid-feed.js';
import { describeOtcPolicy } from './otc-policy.js';

describe('socket.otc-mid-feed Done bar', () => {
  it('deskStatus names the mid-feed socket refuse-closed when venue observation is not installed', () => {
    const svc = new OtcDeskService(new MemoryLedger(), new FixedOtcStake(parseAmount('0')));
    const status = svc.deskStatus();
    expect(status.midFeed).toEqual(describeOtcPolicy().bootMidFeedWiring);
    expect(status.midFeed.published).toBe(false);
    expect(status.midFeed.socket).toBe(OTC_MID_FEED_SOCKET);
    expect(status.midFeed.liveObservationFeed).toBe(false);
    expect(status.residuals.midFeed).toBe(OTC_MID_FEED_RESIDUAL);
  });

  it('deskStatus publishes liveObservationFeed when the venue source is installed', () => {
    const svc = new OtcDeskService(new MemoryLedger(), new FixedOtcStake(parseAmount('0')), {
      liveObservationFeed: true,
      midFeedWiring: describeOtcMidFeedWiring({
        midFromVenue: true,
        venueAdapterInstalled: true,
        venueSymbolsConfigured: true,
        liveObservationFeed: true,
      }),
    });
    const status = svc.deskStatus();
    expect(status.midFeed).toMatchObject(otcMidFeedStatus(true));
    expect(status.midFeed).toMatchObject({ wiring: 'live_observation' });
    expect(status.residuals.midFeed).toBeNull();
  });

  it('describeOtcMidFeedWiring names flag-on venue-unwired separately', () => {
    const wiring = describeOtcMidFeedWiring({
      midFromVenue: true,
      venueAdapterInstalled: false,
      venueSymbolsConfigured: true,
      liveObservationFeed: false,
    });
    expect(wiring.wiring).toBe('flag_on_venue_unwired');
    expect(wiring.residual).toBe(OTC_MID_FEED_FLAG_ON_VENUE_UNWIRED);
    expect(wiring.published).toBe(false);
  });

  it('describeOtcMidFeedWiring names empty symbol map when flag is on', () => {
    const wiring = describeOtcMidFeedWiring({
      midFromVenue: true,
      venueAdapterInstalled: true,
      venueSymbolsConfigured: false,
      liveObservationFeed: false,
    });
    expect(wiring.wiring).toBe('flag_on_symbol_map_empty');
    expect(wiring.residual).toBe(OTC_MID_FEED_FLAG_ON_SYMBOL_MAP_EMPTY);
  });

  it('deskStatus surfaces flag-on venue-unwired wiring from boot', () => {
    const wiring = describeOtcMidFeedWiring({
      midFromVenue: true,
      venueAdapterInstalled: false,
      venueSymbolsConfigured: false,
      liveObservationFeed: false,
    });
    const svc = new OtcDeskService(new MemoryLedger(), new FixedOtcStake(parseAmount('0')), { midFeedWiring: wiring });
    const status = svc.deskStatus();
    expect(status.midFeed).toMatchObject({ wiring: 'flag_on_venue_unwired', published: false });
    expect(status.residuals.midFeed).toBe(OTC_MID_FEED_FLAG_ON_VENUE_UNWIRED);
  });
});
