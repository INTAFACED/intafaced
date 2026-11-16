import { describe, expect, it } from 'vitest';
import {
  CHANNEL_IDS,
  OUT_OF_APP_CHANNELS,
  isChannelId,
  isOutOfAppChannel,
  channelCatalogSize,
  outOfAppChannelCount,
  channelCatalogBoardCard,
  parseChannelCatalogStatusLine,
  channelCatalogStatusLineMatches,
  channelCatalogExportHeader,
  channelCatalogExportLines,
  channelCatalogExportText,
  channelCatalogSizeInRange,
  allRefusalCodes,
  refusalCodeCount,
} from './channel.js';

describe('L3 wave54 channel catalog honesty', () => {
  it('catalog boards and export', () => {
    expect(channelCatalogSize()).toBe(4);
    expect(outOfAppChannelCount()).toBe(3);
    expect(isChannelId('inapp')).toBe(true);
    expect(isOutOfAppChannel('inapp')).toBe(false);
    expect(isOutOfAppChannel('email')).toBe(true);
    expect(channelCatalogBoardCard().ids).toEqual(CHANNEL_IDS);
    expect(channelCatalogStatusLineMatches()).toBe(true);
    expect(parseChannelCatalogStatusLine('nope')).toBeNull();
    expect(channelCatalogExportText().startsWith(channelCatalogExportHeader())).toBe(true);
    expect(channelCatalogExportLines()).toHaveLength(4);
    expect(channelCatalogSizeInRange(4, 4)).toBe(true);
    expect(channelCatalogSizeInRange(5, 1)).toBe(false);
    expect(refusalCodeCount()).toBe(allRefusalCodes().length);
    expect(allRefusalCodes()).toContain('channel.muted');
    expect(allRefusalCodes()).toContain('channel.register_rate_limited');
    expect(allRefusalCodes()).toContain('channel.verify_rate_limited');
    expect(allRefusalCodes()).toContain('channel.delivery_stuck');
    expect(allRefusalCodes()).toContain('channel.unprobed');
    expect(OUT_OF_APP_CHANNELS).toHaveLength(3);
  });
});
