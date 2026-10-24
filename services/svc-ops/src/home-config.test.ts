import { describe, expect, it } from 'vitest';
import { createEdgeContext } from '@intafaced/contracts';
import { BLANK_HOME_CONFIG, homeConfigFrom } from './home-config.js';
import { OpsService } from './ops-service.js';
import { createOpsRouter } from './router.js';

const edgeContext = createEdgeContext({ secret: 'a-ops-home-config-test-edge-secret-long', serviceName: 'svc-ops' });
const anonymous = () => edgeContext({ headers: {}, id: 'anon' });

describe('home.config: Home owner values (HM-dashboard-03)', () => {
  it('answers every value blank when nothing is published, signed out too, and invents no cap or order', async () => {
    const api = createOpsRouter(new OpsService()).createCaller(await anonymous());
    expect(await api.home.config()).toEqual({ workListCap: null, workListOrder: null, searchResultCap: null, revision: 0 });
    expect(homeConfigFrom({})).toEqual(BLANK_HOME_CONFIG);
    expect(homeConfigFrom({ OPS_HOME_WORK_LIST_CAP: '  ', OPS_HOME_WORK_LIST_ORDER: '', OPS_HOME_SEARCH_RESULT_CAP: ' ' })).toEqual(
      BLANK_HOME_CONFIG,
    );
  });

  it('answers the published values as they are', async () => {
    const home = homeConfigFrom({
      OPS_HOME_WORK_LIST_CAP: '5',
      OPS_HOME_WORK_LIST_ORDER: 'verification, margin_health,loan_payment_due,card_frozen,payout_waiting',
      OPS_HOME_SEARCH_RESULT_CAP: '7',
    });
    const api = createOpsRouter(new OpsService(), undefined, { home }).createCaller(await anonymous());
    expect(await api.home.config()).toEqual({
      workListCap: 5,
      workListOrder: ['verification', 'margin_health', 'loan_payment_due', 'card_frozen', 'payout_waiting'],
      searchResultCap: 7,
      revision: 0,
    });
  });

  it('keeps one value blank while another is published', () => {
    expect(homeConfigFrom({ OPS_HOME_WORK_LIST_CAP: '3' })).toEqual({ ...BLANK_HOME_CONFIG, workListCap: 3 });
  });

  it.each([
    [{ OPS_HOME_WORK_LIST_CAP: 'five' }, /OPS_HOME_WORK_LIST_CAP must be a whole number/],
    [{ OPS_HOME_WORK_LIST_CAP: '2.5' }, /OPS_HOME_WORK_LIST_CAP must be a whole number/],
    [{ OPS_HOME_WORK_LIST_CAP: '0' }, /workListCap/],
    [{ OPS_HOME_WORK_LIST_CAP: '51' }, /workListCap/],
    [{ OPS_HOME_SEARCH_RESULT_CAP: '21' }, /searchResultCap/],
    [{ OPS_HOME_WORK_LIST_ORDER: 'verification,coffee' }, /"coffee", which is not a work item kind/],
    [{ OPS_HOME_WORK_LIST_ORDER: 'verification,verification' }, /each kind once/],
    [{ OPS_HOME_WORK_LIST_ORDER: ',' }, /empty entry/],
    [{ OPS_HOME_WORK_LIST_ORDER: 'verification,,card_frozen' }, /empty entry/],
    [{ OPS_HOME_WORK_LIST_ORDER: 'verification,' }, /empty entry/],
    [{ OPS_HOME_WORK_LIST_CAP: '0', OPS_HOME_SEARCH_RESULT_CAP: '21' }, /workListCap.*; searchResultCap/],
  ])('refuses a malformed value at boot instead of reading it as blank: %o', (env, message) => {
    expect(() => homeConfigFrom(env)).toThrow(message);
  });
});
