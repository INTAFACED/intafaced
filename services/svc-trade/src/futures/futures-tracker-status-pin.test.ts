import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FUTURES_HONEST_GAPS,
  FUTURES_TRACKER_ID,
  futuresLiveReleverageMounted,
  futuresMountVsTrackerBoardCard,
  futuresOwnerEnvComposeGapsClosed,
  futuresTrackerBackendDoneBarMet,
} from './mount-vs-tracker.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** The tracker's own feature list, loaded as the module the board itself runs. */
async function trackerStatus(featureId: string): Promise<string | null> {
  const url = pathToFileURL(join(ROOT, 'tooling/tracker/features.mjs')).href;
  const { FEATURES } = (await import(url)) as { FEATURES: ReadonlyArray<{ id: string; status: string }> };
  return FEATURES.find((feature) => feature.id === featureId)?.status ?? null;
}

describe('trade.futures tracker status pin', () => {
  it('owner ladder/funding/leverage compose gaps closed; live re-leverage is mounted', () => {
    expect(futuresOwnerEnvComposeGapsClosed()).toBe(true);
    expect(FUTURES_HONEST_GAPS).toEqual([]);
    expect(futuresLiveReleverageMounted()).toBe(true);
    expect(futuresTrackerBackendDoneBarMet()).toBe(true);
    expect(futuresMountVsTrackerBoardCard().gaps).toBe(0);
  });

  it('features.mjs marks trade.futures done when owner env wiring ships', async () => {
    expect(FUTURES_TRACKER_ID).toBe('trade.futures');
    expect(await trackerStatus('trade.futures')).toBe('done');
  });
});
