import { describe, expect, it } from 'vitest';
import { homeConfigOutputSchema } from '@intafaced/contracts';
import { createHomeConfigRouter, homeConfigFromEnv } from './home-config.js';
import { OpsService } from './ops-service.js';
import { createOpsRouter } from './router.js';

describe('home.config owner values', () => {
  it('answers every blank value as blank, never a default', () => {
    expect(homeConfigFromEnv({})).toEqual({ workListCap: null, workListOrder: null, searchResultCap: null, revision: 0 });
    expect(homeConfigFromEnv({ OPS_HOME_WORK_LIST_CAP: '  ', OPS_HOME_WORK_LIST_ORDER: '', OPS_HOME_SEARCH_RESULT_CAP: '' })).toEqual({
      workListCap: null,
      workListOrder: null,
      searchResultCap: null,
      revision: 0,
    });
  });

  it('reads set values exactly', () => {
    const config = homeConfigFromEnv({
      OPS_HOME_WORK_LIST_CAP: '5',
      OPS_HOME_WORK_LIST_ORDER: 'verification, margin_health,card_frozen',
      OPS_HOME_SEARCH_RESULT_CAP: '3',
    });
    expect(config).toEqual({
      workListCap: 5,
      workListOrder: ['verification', 'margin_health', 'card_frozen'],
      searchResultCap: 3,
      revision: 0,
    });
    expect(homeConfigOutputSchema.parse(config)).toEqual(config);
  });

  it.each([
    ['OPS_HOME_WORK_LIST_CAP', '0'],
    ['OPS_HOME_WORK_LIST_CAP', '51'],
    ['OPS_HOME_WORK_LIST_CAP', 'five'],
    ['OPS_HOME_WORK_LIST_CAP', '2.5'],
    ['OPS_HOME_WORK_LIST_CAP', '0x10'],
    ['OPS_HOME_SEARCH_RESULT_CAP', '1e1'],
    ['OPS_HOME_SEARCH_RESULT_CAP', '21'],
    ['OPS_HOME_WORK_LIST_ORDER', 'verification,verification'],
    ['OPS_HOME_WORK_LIST_ORDER', 'verification,loan_late'],
    ['OPS_HOME_WORK_LIST_ORDER', ' , '],
  ] as const)('refuses a malformed %s (%s) at boot instead of changing the list silently', (name, value) => {
    expect(() => homeConfigFromEnv({ [name]: value })).toThrow(name);
  });

  it('is a public read: a caller with no principal gets the values', async () => {
    const config = homeConfigFromEnv({ OPS_HOME_WORK_LIST_CAP: '4' });
    const caller = createHomeConfigRouter(config).createCaller({} as never);
    await expect(caller.config()).resolves.toEqual(config);
  });

  it('is mounted as home.config, blank when the service is given no values', async () => {
    const caller = createOpsRouter(new OpsService()).createCaller({} as never);
    await expect(caller.home.config()).resolves.toEqual({ workListCap: null, workListOrder: null, searchResultCap: null, revision: 0 });
  });
});
