import { describe, expect, it } from 'vitest';
import { ALERT_MARK_MAX_AGE_MS } from './alerts/accepted-mark.js';
import { ALERT_SWEEP_INTERVAL_MS } from './alerts/service.js';
import { ALERT_KIND_UNPUBLISHED, ALERT_PORTFOLIO_VIEW_UNPUBLISHED, UNPUBLISHED_ALERT_KINDS } from './alerts/types.js';
import { createEdgeContext } from '@intafaced/contracts';
import { createNotifyRouter } from './router.js';
import type { NotifyService } from './notify-service.js';
import { describeAlertsPolicy } from './alerts-policy.js';

const edgeContext = createEdgeContext({ secret: 'a-notify-policy-test-edge-secret-long', serviceName: 'svc-notify' });
const anonymous = () => edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });

function stubNotify(): NotifyService {
  return { fanoutEnabled: true } as NotifyService;
}

describe('describeAlertsPolicy — v22.alerts honesty door', () => {
  it('states alert refuse honesty without inventing marks or balances', () => {
    const p = describeAlertsPolicy();
    expect(p.publishedKind).toBe('price');
    expect(p.publishedKinds).toEqual(['price', 'funding', 'liquidation_proximity', 'whale']);
    expect(p.priceWatchCoreOnly).toBe(false);
    expect(p.sourcedSeriesOnly).toBe(true);
    expect(p.unpublishedKinds).toEqual([...UNPUBLISHED_ALERT_KINDS]);
    expect(p.unpublishedKinds).toEqual(['intelligence']);
    expect(p.portfolioViewUnpublishedCode).toBe(ALERT_PORTFOLIO_VIEW_UNPUBLISHED);
    expect(p.kindUnpublishedCode).toBe(ALERT_KIND_UNPUBLISHED);
    expect(p.markMaxAgeMs).toBe(ALERT_MARK_MAX_AGE_MS);
    expect(p.sweepIntervalMs).toBe(ALERT_SWEEP_INTERVAL_MS);
    expect(p.darkMarkRefusesFire).toBe(true);
    expect(p.inventsPrices).toBe(false);
    expect(p.inventsPortfolioBalance).toBe(false);
    expect(p.sweepEvaluatesDueAlerts).toBe(true);
    expect(p.ridesNotifyFanout).toBe(true);
    expect(p.oneShotFire).toBe(true);
    expect(p.moneyNeverNumber).toBe(true);
  });
});

describe('notify.alertsPolicy route (v22.alerts honesty door)', () => {
  it('public query mirrors describeAlertsPolicy', async () => {
    const result = await createNotifyRouter(stubNotify()).createCaller(anonymous()).notify.alertsPolicy();
    expect(result).toEqual(describeAlertsPolicy());
  });
});
