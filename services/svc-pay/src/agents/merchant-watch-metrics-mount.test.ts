import { describe, expect, it } from 'vitest';
import { MERCHANT_WATCH_METRICS_PATH, MERCHANT_WATCH_METRICS_PUBLISH_PATH } from './merchant-watch-metrics-routes.js';

describe('merchant watch metrics mount', () => {
  it('exports stable paths for svc-agents HTTP port', () => {
    expect(MERCHANT_WATCH_METRICS_PATH).toBe('/internal/agents/merchant-watch-metrics');
    expect(MERCHANT_WATCH_METRICS_PUBLISH_PATH).toBe('/internal/agents/merchant-watch-metrics/publish');
  });
});
