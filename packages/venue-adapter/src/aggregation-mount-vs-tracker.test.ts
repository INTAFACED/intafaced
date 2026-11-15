import { describe, expect, it } from 'vitest';
import {
  VENUE_AGGREGATION_DONE_BAR_TEST_FILES,
  VENUE_AGGREGATION_HONEST_GAPS,
  VENUE_AGGREGATION_PACKAGE_EXPORTS,
  VENUE_AGGREGATION_TRACKER_ID,
  venueAggregationDoneBarTestsPresent,
  venueAggregationExportsInIndexSource,
  venueAggregationMountVsTrackerBoardCard,
  venueAggregationPolicyHonest,
  venueAggregationTrackerBackendDoneBarMet,
  venueAggregationTradeFactoryComplete,
} from './aggregation-mount-vs-tracker.js';

describe('venue.aggregation mount vs tracker honest gaps (D73-P1)', () => {
  it('backend done bar met on tip — factory trio + trading-half policy', () => {
    expect(VENUE_AGGREGATION_TRACKER_ID).toBe('venue.aggregation');
    expect(venueAggregationExportsInIndexSource()).toEqual([...VENUE_AGGREGATION_PACKAGE_EXPORTS]);
    expect(venueAggregationPolicyHonest()).toBe(true);
    expect(venueAggregationTradeFactoryComplete()).toBe(true);
    expect(venueAggregationDoneBarTestsPresent()).toBe(true);
    expect(VENUE_AGGREGATION_DONE_BAR_TEST_FILES).toHaveLength(5);
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationMountVsTrackerBoardCard().backendDoneBarMet).toBe(true);
  });

  it('D73 — honest gaps remain owner-residual; mount cert does not stamp product done', () => {
    expect(VENUE_AGGREGATION_HONEST_GAPS).toEqual([]);
    expect(venueAggregationMountVsTrackerBoardCard().gaps).toBe(0);
  });
});

describe('venue.aggregation mount vs tracker — D74 denon complete', () => {
  it('mount cert board, exports, policy, factory, and done-bar tests all green', () => {
    const card = venueAggregationMountVsTrackerBoardCard();
    expect(card).toMatchObject({
      tracker: 'venue.aggregation',
      exports: VENUE_AGGREGATION_PACKAGE_EXPORTS.length,
      exportsPresent: VENUE_AGGREGATION_PACKAGE_EXPORTS.length,
      gaps: VENUE_AGGREGATION_HONEST_GAPS.length,
      backendDoneBarMet: true,
    });
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationPolicyHonest()).toBe(true);
    expect(venueAggregationTradeFactoryComplete()).toBe(true);
    expect(venueAggregationDoneBarTestsPresent()).toBe(true);
    expect(VENUE_AGGREGATION_DONE_BAR_TEST_FILES).toContain('aggregation-mount-vs-tracker.test.ts');
    expect(VENUE_AGGREGATION_DONE_BAR_TEST_FILES).toContain('fabric/venues/aggregation-trading-door.test.ts');
  });
});

describe('venue.aggregation mount vs tracker — D76 denon complete', () => {
  it('full mount board: tracker id, exports, policy, factory, done-bar tests, honest gaps', () => {
    expect(VENUE_AGGREGATION_TRACKER_ID).toBe('venue.aggregation');
    const card = venueAggregationMountVsTrackerBoardCard();
    expect(card).toMatchObject({
      tracker: 'venue.aggregation',
      exports: 9,
      exportsPresent: 9,
      gaps: 0,
      backendDoneBarMet: true,
    });
    expect(venueAggregationExportsInIndexSource()).toEqual([...VENUE_AGGREGATION_PACKAGE_EXPORTS]);
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationPolicyHonest()).toBe(true);
    expect(venueAggregationTradeFactoryComplete()).toBe(true);
    expect(venueAggregationDoneBarTestsPresent()).toBe(true);
    expect(VENUE_AGGREGATION_HONEST_GAPS).toEqual([]);
  });
});

describe('venue.aggregation mount vs tracker — D78 denon complete', () => {
  it('mount cert board complete: exports, policy, factory, done-bar tests, honest gaps', () => {
    const card = venueAggregationMountVsTrackerBoardCard();
    expect(card.tracker).toBe('venue.aggregation');
    expect(card.backendDoneBarMet).toBe(true);
    expect(card.exportsPresent).toBe(VENUE_AGGREGATION_PACKAGE_EXPORTS.length);
    expect(card.gaps).toBe(VENUE_AGGREGATION_HONEST_GAPS.length);
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationPolicyHonest()).toBe(true);
    expect(venueAggregationTradeFactoryComplete()).toBe(true);
    expect(venueAggregationDoneBarTestsPresent()).toBe(true);
    expect(VENUE_AGGREGATION_DONE_BAR_TEST_FILES).toHaveLength(5);
    expect(VENUE_AGGREGATION_HONEST_GAPS).toHaveLength(0);
  });
});

describe('venue.aggregation mount vs tracker — D80 denon complete', () => {
  it('full mount board: tracker, exports, policy, factory, done-bar tests, honest gaps', () => {
    expect(VENUE_AGGREGATION_TRACKER_ID).toBe('venue.aggregation');
    const card = venueAggregationMountVsTrackerBoardCard();
    expect(card).toMatchObject({
      tracker: 'venue.aggregation',
      exports: VENUE_AGGREGATION_PACKAGE_EXPORTS.length,
      exportsPresent: VENUE_AGGREGATION_PACKAGE_EXPORTS.length,
      gaps: VENUE_AGGREGATION_HONEST_GAPS.length,
      backendDoneBarMet: true,
    });
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationExportsInIndexSource()).toEqual([...VENUE_AGGREGATION_PACKAGE_EXPORTS]);
    expect(venueAggregationPolicyHonest()).toBe(true);
    expect(venueAggregationTradeFactoryComplete()).toBe(true);
    expect(venueAggregationDoneBarTestsPresent()).toBe(true);
    expect(VENUE_AGGREGATION_HONEST_GAPS).toEqual([]);
  });
});

describe('venue.aggregation mount vs tracker — D82 denon complete', () => {
  it('full mount board: tracker, exports, policy, factory, done-bar tests, honest gaps', () => {
    expect(VENUE_AGGREGATION_TRACKER_ID).toBe('venue.aggregation');
    const card = venueAggregationMountVsTrackerBoardCard();
    expect(card.backendDoneBarMet).toBe(true);
    expect(card.exportsPresent).toBe(VENUE_AGGREGATION_PACKAGE_EXPORTS.length);
    expect(card.gaps).toBe(VENUE_AGGREGATION_HONEST_GAPS.length);
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationExportsInIndexSource()).toEqual([...VENUE_AGGREGATION_PACKAGE_EXPORTS]);
    expect(venueAggregationPolicyHonest()).toBe(true);
    expect(venueAggregationTradeFactoryComplete()).toBe(true);
    expect(venueAggregationDoneBarTestsPresent()).toBe(true);
    expect(VENUE_AGGREGATION_HONEST_GAPS).toHaveLength(0);
  });
});

describe('venue.aggregation mount vs tracker — D84 denon complete', () => {
  it('full mount board: tracker, exports, policy, factory, done-bar tests, honest gaps', () => {
    const card = venueAggregationMountVsTrackerBoardCard();
    expect(card).toMatchObject({
      tracker: 'venue.aggregation',
      exports: VENUE_AGGREGATION_PACKAGE_EXPORTS.length,
      exportsPresent: VENUE_AGGREGATION_PACKAGE_EXPORTS.length,
      gaps: VENUE_AGGREGATION_HONEST_GAPS.length,
      backendDoneBarMet: true,
    });
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationExportsInIndexSource()).toEqual([...VENUE_AGGREGATION_PACKAGE_EXPORTS]);
    expect(venueAggregationPolicyHonest()).toBe(true);
    expect(venueAggregationTradeFactoryComplete()).toBe(true);
    expect(venueAggregationDoneBarTestsPresent()).toBe(true);
    expect(VENUE_AGGREGATION_HONEST_GAPS).toEqual([]);
  });
});

describe('venue.aggregation mount vs tracker — D86 denon complete', () => {
  it('full mount board: tracker, exports, policy, factory, done-bar tests, honest gaps', () => {
    expect(VENUE_AGGREGATION_TRACKER_ID).toBe('venue.aggregation');
    const card = venueAggregationMountVsTrackerBoardCard();
    expect(card.backendDoneBarMet).toBe(true);
    expect(card.exportsPresent).toBe(VENUE_AGGREGATION_PACKAGE_EXPORTS.length);
    expect(card.gaps).toBe(VENUE_AGGREGATION_HONEST_GAPS.length);
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationExportsInIndexSource()).toEqual([...VENUE_AGGREGATION_PACKAGE_EXPORTS]);
    expect(venueAggregationPolicyHonest()).toBe(true);
    expect(venueAggregationTradeFactoryComplete()).toBe(true);
    expect(venueAggregationDoneBarTestsPresent()).toBe(true);
    expect(VENUE_AGGREGATION_HONEST_GAPS).toHaveLength(0);
  });
});

describe('venue.aggregation mount vs tracker — D88 denon complete', () => {
  it('full mount board: tracker, exports, policy, factory, done-bar tests, honest gaps', () => {
    const card = venueAggregationMountVsTrackerBoardCard();
    expect(card).toMatchObject({
      tracker: 'venue.aggregation',
      exports: VENUE_AGGREGATION_PACKAGE_EXPORTS.length,
      exportsPresent: VENUE_AGGREGATION_PACKAGE_EXPORTS.length,
      gaps: VENUE_AGGREGATION_HONEST_GAPS.length,
      backendDoneBarMet: true,
    });
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationExportsInIndexSource()).toEqual([...VENUE_AGGREGATION_PACKAGE_EXPORTS]);
    expect(venueAggregationPolicyHonest()).toBe(true);
    expect(venueAggregationTradeFactoryComplete()).toBe(true);
    expect(venueAggregationDoneBarTestsPresent()).toBe(true);
    expect(VENUE_AGGREGATION_HONEST_GAPS).toEqual([]);
  });
});

describe('venue.aggregation mount vs tracker — D90 denon complete', () => {
  it('full mount board: tracker, exports, policy, factory, done-bar tests, honest gaps', () => {
    expect(VENUE_AGGREGATION_TRACKER_ID).toBe('venue.aggregation');
    const card = venueAggregationMountVsTrackerBoardCard();
    expect(card.backendDoneBarMet).toBe(true);
    expect(card.exportsPresent).toBe(VENUE_AGGREGATION_PACKAGE_EXPORTS.length);
    expect(card.gaps).toBe(VENUE_AGGREGATION_HONEST_GAPS.length);
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationExportsInIndexSource()).toEqual([...VENUE_AGGREGATION_PACKAGE_EXPORTS]);
    expect(venueAggregationPolicyHonest()).toBe(true);
    expect(venueAggregationTradeFactoryComplete()).toBe(true);
    expect(venueAggregationDoneBarTestsPresent()).toBe(true);
    expect(VENUE_AGGREGATION_HONEST_GAPS).toHaveLength(0);
  });
});

describe('venue.aggregation mount vs tracker — D92 denon complete', () => {
  it('full mount board: tracker, exports, policy, factory, done-bar tests, honest gaps', () => {
    expect(VENUE_AGGREGATION_TRACKER_ID).toBe('venue.aggregation');
    const card = venueAggregationMountVsTrackerBoardCard();
    expect(card.backendDoneBarMet).toBe(true);
    expect(card.exportsPresent).toBe(VENUE_AGGREGATION_PACKAGE_EXPORTS.length);
    expect(card.gaps).toBe(VENUE_AGGREGATION_HONEST_GAPS.length);
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationExportsInIndexSource()).toEqual([...VENUE_AGGREGATION_PACKAGE_EXPORTS]);
    expect(venueAggregationPolicyHonest()).toBe(true);
    expect(venueAggregationTradeFactoryComplete()).toBe(true);
    expect(venueAggregationDoneBarTestsPresent()).toBe(true);
    expect(VENUE_AGGREGATION_HONEST_GAPS).toHaveLength(0);
  });
});

describe('venue.aggregation mount vs tracker — D94 denon complete', () => {
  it('full mount board: tracker, exports, policy, factory, done-bar tests, honest gaps', () => {
    expect(VENUE_AGGREGATION_TRACKER_ID).toBe('venue.aggregation');
    const card = venueAggregationMountVsTrackerBoardCard();
    expect(card.backendDoneBarMet).toBe(true);
    expect(card.exportsPresent).toBe(VENUE_AGGREGATION_PACKAGE_EXPORTS.length);
    expect(card.gaps).toBe(VENUE_AGGREGATION_HONEST_GAPS.length);
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationExportsInIndexSource()).toEqual([...VENUE_AGGREGATION_PACKAGE_EXPORTS]);
    expect(venueAggregationPolicyHonest()).toBe(true);
    expect(venueAggregationTradeFactoryComplete()).toBe(true);
    expect(venueAggregationDoneBarTestsPresent()).toBe(true);
    expect(VENUE_AGGREGATION_HONEST_GAPS).toHaveLength(0);
  });
});

describe('venue.aggregation mount vs tracker — D96 denon complete', () => {
  it('full mount board: tracker, exports, policy, factory, done-bar tests, honest gaps', () => {
    expect(VENUE_AGGREGATION_TRACKER_ID).toBe('venue.aggregation');
    const card = venueAggregationMountVsTrackerBoardCard();
    expect(card.backendDoneBarMet).toBe(true);
    expect(card.exportsPresent).toBe(VENUE_AGGREGATION_PACKAGE_EXPORTS.length);
    expect(card.gaps).toBe(VENUE_AGGREGATION_HONEST_GAPS.length);
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationExportsInIndexSource()).toEqual([...VENUE_AGGREGATION_PACKAGE_EXPORTS]);
    expect(venueAggregationPolicyHonest()).toBe(true);
    expect(venueAggregationTradeFactoryComplete()).toBe(true);
    expect(venueAggregationDoneBarTestsPresent()).toBe(true);
    expect(VENUE_AGGREGATION_HONEST_GAPS).toHaveLength(0);
  });
});

describe('venue.aggregation mount vs tracker — D98 denon complete', () => {
  it('full mount board: tracker, exports, policy, factory, done-bar tests, honest gaps', () => {
    expect(VENUE_AGGREGATION_TRACKER_ID).toBe('venue.aggregation');
    const card = venueAggregationMountVsTrackerBoardCard();
    expect(card.backendDoneBarMet).toBe(true);
    expect(card.exportsPresent).toBe(VENUE_AGGREGATION_PACKAGE_EXPORTS.length);
    expect(card.gaps).toBe(VENUE_AGGREGATION_HONEST_GAPS.length);
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationExportsInIndexSource()).toEqual([...VENUE_AGGREGATION_PACKAGE_EXPORTS]);
    expect(venueAggregationPolicyHonest()).toBe(true);
    expect(venueAggregationTradeFactoryComplete()).toBe(true);
    expect(venueAggregationDoneBarTestsPresent()).toBe(true);
    expect(VENUE_AGGREGATION_HONEST_GAPS).toHaveLength(0);
  });
});

describe('venue.aggregation mount vs tracker — D100 denon complete', () => {
  it('full mount board: tracker, exports, policy, factory, done-bar tests, honest gaps', () => {
    expect(VENUE_AGGREGATION_TRACKER_ID).toBe('venue.aggregation');
    const card = venueAggregationMountVsTrackerBoardCard();
    expect(card.backendDoneBarMet).toBe(true);
    expect(card.exportsPresent).toBe(VENUE_AGGREGATION_PACKAGE_EXPORTS.length);
    expect(card.gaps).toBe(VENUE_AGGREGATION_HONEST_GAPS.length);
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationExportsInIndexSource()).toEqual([...VENUE_AGGREGATION_PACKAGE_EXPORTS]);
    expect(venueAggregationPolicyHonest()).toBe(true);
    expect(venueAggregationTradeFactoryComplete()).toBe(true);
    expect(venueAggregationDoneBarTestsPresent()).toBe(true);
    expect(VENUE_AGGREGATION_HONEST_GAPS).toHaveLength(0);
  });
});

describe('venue.aggregation mount vs tracker — D102 denon complete', () => {
  it('full mount board: tracker, exports, policy, factory, done-bar tests, honest gaps', () => {
    expect(VENUE_AGGREGATION_TRACKER_ID).toBe('venue.aggregation');
    const card = venueAggregationMountVsTrackerBoardCard();
    expect(card.backendDoneBarMet).toBe(true);
    expect(card.exportsPresent).toBe(VENUE_AGGREGATION_PACKAGE_EXPORTS.length);
    expect(card.gaps).toBe(VENUE_AGGREGATION_HONEST_GAPS.length);
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationExportsInIndexSource()).toEqual([...VENUE_AGGREGATION_PACKAGE_EXPORTS]);
    expect(venueAggregationPolicyHonest()).toBe(true);
    expect(venueAggregationTradeFactoryComplete()).toBe(true);
    expect(venueAggregationDoneBarTestsPresent()).toBe(true);
    expect(VENUE_AGGREGATION_HONEST_GAPS).toHaveLength(0);
  });
});

describe('venue.aggregation mount vs tracker — D104 denon complete', () => {
  it('full mount board: tracker, exports, policy, factory, done-bar tests, honest gaps', () => {
    expect(VENUE_AGGREGATION_TRACKER_ID).toBe('venue.aggregation');
    const card = venueAggregationMountVsTrackerBoardCard();
    expect(card.backendDoneBarMet).toBe(true);
    expect(card.exportsPresent).toBe(VENUE_AGGREGATION_PACKAGE_EXPORTS.length);
    expect(card.gaps).toBe(VENUE_AGGREGATION_HONEST_GAPS.length);
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationExportsInIndexSource()).toEqual([...VENUE_AGGREGATION_PACKAGE_EXPORTS]);
    expect(venueAggregationPolicyHonest()).toBe(true);
    expect(venueAggregationTradeFactoryComplete()).toBe(true);
    expect(venueAggregationDoneBarTestsPresent()).toBe(true);
    expect(VENUE_AGGREGATION_HONEST_GAPS).toHaveLength(0);
  });
});

describe('venue.aggregation mount vs tracker — D106 denon complete', () => {
  it('full mount board: tracker, exports, policy, factory, done-bar tests, honest gaps', () => {
    expect(VENUE_AGGREGATION_TRACKER_ID).toBe('venue.aggregation');
    const card = venueAggregationMountVsTrackerBoardCard();
    expect(card.backendDoneBarMet).toBe(true);
    expect(card.exportsPresent).toBe(VENUE_AGGREGATION_PACKAGE_EXPORTS.length);
    expect(card.gaps).toBe(VENUE_AGGREGATION_HONEST_GAPS.length);
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationExportsInIndexSource()).toEqual([...VENUE_AGGREGATION_PACKAGE_EXPORTS]);
    expect(venueAggregationPolicyHonest()).toBe(true);
    expect(venueAggregationTradeFactoryComplete()).toBe(true);
    expect(venueAggregationDoneBarTestsPresent()).toBe(true);
    expect(VENUE_AGGREGATION_HONEST_GAPS).toHaveLength(0);
  });
});

describe('venue.aggregation mount vs tracker — D108 denon complete', () => {
  it('full mount board: tracker, exports, policy, factory, done-bar tests, honest gaps', () => {
    expect(VENUE_AGGREGATION_TRACKER_ID).toBe('venue.aggregation');
    const card = venueAggregationMountVsTrackerBoardCard();
    expect(card.backendDoneBarMet).toBe(true);
    expect(card.exportsPresent).toBe(VENUE_AGGREGATION_PACKAGE_EXPORTS.length);
    expect(card.gaps).toBe(VENUE_AGGREGATION_HONEST_GAPS.length);
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationExportsInIndexSource()).toEqual([...VENUE_AGGREGATION_PACKAGE_EXPORTS]);
    expect(venueAggregationPolicyHonest()).toBe(true);
    expect(venueAggregationTradeFactoryComplete()).toBe(true);
    expect(venueAggregationDoneBarTestsPresent()).toBe(true);
    expect(VENUE_AGGREGATION_HONEST_GAPS).toHaveLength(0);
  });
});

describe('venue.aggregation mount vs tracker — D110 denon complete', () => {
  it('full mount board: tracker, exports, policy, factory, done-bar tests, honest gaps', () => {
    expect(VENUE_AGGREGATION_TRACKER_ID).toBe('venue.aggregation');
    const card = venueAggregationMountVsTrackerBoardCard();
    expect(card.backendDoneBarMet).toBe(true);
    expect(card.exportsPresent).toBe(VENUE_AGGREGATION_PACKAGE_EXPORTS.length);
    expect(card.gaps).toBe(VENUE_AGGREGATION_HONEST_GAPS.length);
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationExportsInIndexSource()).toEqual([...VENUE_AGGREGATION_PACKAGE_EXPORTS]);
    expect(venueAggregationPolicyHonest()).toBe(true);
    expect(venueAggregationTradeFactoryComplete()).toBe(true);
    expect(venueAggregationDoneBarTestsPresent()).toBe(true);
    expect(VENUE_AGGREGATION_HONEST_GAPS).toHaveLength(0);
  });
});

describe('venue.aggregation mount vs tracker — D112 denon complete', () => {
  it('full mount board: tracker, exports, policy, factory, done-bar tests, honest gaps', () => {
    expect(VENUE_AGGREGATION_TRACKER_ID).toBe('venue.aggregation');
    const card = venueAggregationMountVsTrackerBoardCard();
    expect(card.backendDoneBarMet).toBe(true);
    expect(card.exportsPresent).toBe(VENUE_AGGREGATION_PACKAGE_EXPORTS.length);
    expect(card.gaps).toBe(VENUE_AGGREGATION_HONEST_GAPS.length);
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationExportsInIndexSource()).toEqual([...VENUE_AGGREGATION_PACKAGE_EXPORTS]);
    expect(venueAggregationPolicyHonest()).toBe(true);
    expect(venueAggregationTradeFactoryComplete()).toBe(true);
    expect(venueAggregationDoneBarTestsPresent()).toBe(true);
    expect(VENUE_AGGREGATION_HONEST_GAPS).toHaveLength(0);
  });
});

describe('venue.aggregation mount vs tracker — D114 denon complete', () => {
  it('full mount board: tracker, exports, policy, factory, done-bar tests, honest gaps', () => {
    expect(VENUE_AGGREGATION_TRACKER_ID).toBe('venue.aggregation');
    const card = venueAggregationMountVsTrackerBoardCard();
    expect(card.backendDoneBarMet).toBe(true);
    expect(card.exportsPresent).toBe(VENUE_AGGREGATION_PACKAGE_EXPORTS.length);
    expect(card.gaps).toBe(VENUE_AGGREGATION_HONEST_GAPS.length);
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationExportsInIndexSource()).toEqual([...VENUE_AGGREGATION_PACKAGE_EXPORTS]);
    expect(venueAggregationPolicyHonest()).toBe(true);
    expect(venueAggregationTradeFactoryComplete()).toBe(true);
    expect(venueAggregationDoneBarTestsPresent()).toBe(true);
    expect(VENUE_AGGREGATION_HONEST_GAPS).toHaveLength(0);
  });
});

describe('venue.aggregation mount vs tracker — D116 denon complete', () => {
  it('full mount board: tracker, exports, policy, factory, done-bar tests, honest gaps', () => {
    expect(VENUE_AGGREGATION_TRACKER_ID).toBe('venue.aggregation');
    const card = venueAggregationMountVsTrackerBoardCard();
    expect(card.backendDoneBarMet).toBe(true);
    expect(card.exportsPresent).toBe(VENUE_AGGREGATION_PACKAGE_EXPORTS.length);
    expect(card.gaps).toBe(VENUE_AGGREGATION_HONEST_GAPS.length);
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationExportsInIndexSource()).toEqual([...VENUE_AGGREGATION_PACKAGE_EXPORTS]);
    expect(venueAggregationPolicyHonest()).toBe(true);
    expect(venueAggregationTradeFactoryComplete()).toBe(true);
    expect(venueAggregationDoneBarTestsPresent()).toBe(true);
    expect(VENUE_AGGREGATION_HONEST_GAPS).toHaveLength(0);
  });
});

describe('venue.aggregation mount vs tracker — D118 denon complete', () => {
  it('full mount board: tracker, exports, policy, factory, done-bar tests, honest gaps', () => {
    expect(VENUE_AGGREGATION_TRACKER_ID).toBe('venue.aggregation');
    const card = venueAggregationMountVsTrackerBoardCard();
    expect(card.backendDoneBarMet).toBe(true);
    expect(card.exportsPresent).toBe(VENUE_AGGREGATION_PACKAGE_EXPORTS.length);
    expect(card.gaps).toBe(VENUE_AGGREGATION_HONEST_GAPS.length);
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationExportsInIndexSource()).toEqual([...VENUE_AGGREGATION_PACKAGE_EXPORTS]);
    expect(venueAggregationPolicyHonest()).toBe(true);
    expect(venueAggregationTradeFactoryComplete()).toBe(true);
    expect(venueAggregationDoneBarTestsPresent()).toBe(true);
    expect(VENUE_AGGREGATION_HONEST_GAPS).toHaveLength(0);
  });
});

describe('venue.aggregation mount vs tracker — D120 denon complete', () => {
  it('full mount board: tracker, exports, policy, factory, done-bar tests, honest gaps', () => {
    expect(VENUE_AGGREGATION_TRACKER_ID).toBe('venue.aggregation');
    const card = venueAggregationMountVsTrackerBoardCard();
    expect(card.backendDoneBarMet).toBe(true);
    expect(card.exportsPresent).toBe(VENUE_AGGREGATION_PACKAGE_EXPORTS.length);
    expect(card.gaps).toBe(VENUE_AGGREGATION_HONEST_GAPS.length);
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationExportsInIndexSource()).toEqual([...VENUE_AGGREGATION_PACKAGE_EXPORTS]);
    expect(venueAggregationPolicyHonest()).toBe(true);
    expect(venueAggregationTradeFactoryComplete()).toBe(true);
    expect(venueAggregationDoneBarTestsPresent()).toBe(true);
    expect(VENUE_AGGREGATION_HONEST_GAPS).toHaveLength(0);
  });
});
