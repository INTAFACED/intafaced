import { describe, expect, it } from 'vitest';
import { findRoom, searchRooms } from '../../../app/navigation';
import { featureById } from '../../../app/feature-registry';

describe('news and calendar addresses', () => {
  it('are Trade rooms that search finds, with no screen of their own', () => {
    for (const path of ['/trade/news', '/trade/calendar']) {
      const room = findRoom(path);
      expect(room?.path).toBe(path);
      expect(room?.door).toBe('Trade');
      expect(room?.screen).toBeUndefined();
      expect(room?.hidden).not.toBe(true);
    }
    expect(searchRooms('calendar', 'Personal').map((room) => room.path)).toContain('/trade/calendar');
    expect(searchRooms('news', 'Personal').map((room) => room.path)).toContain('/trade/news');
  });
  it('are in the registry as blocked with the feed.news reason, never hidden', () => {
    const feature = featureById('trade-news-calendar');
    expect(feature?.status).toBe('blocked');
    expect(feature?.reason).toContain('feed.news');
    expect(feature?.paths).toEqual(['/trade/news', '/trade/calendar']);
  });
});
