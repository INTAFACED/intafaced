import { describe, expect, it } from 'vitest';
import { parseExposition } from './exposition.js';
import { Metrics, MODULE_OVERFLOW, REQUESTS_TOTAL, type HttpRequestLabels } from './metrics.js';

function labels(over: Partial<HttpRequestLabels>): HttpRequestLabels {
  return {
    service: 'svc-edge',
    module: 'trade',
    method: 'POST',
    status: '2xx',
    outcome: 'authenticated',
    ...over,
  };
}

describe('series cap', () => {
  it('adds one overflow series past the cap and then stops growing', () => {
    const metrics = new Metrics(2);

    metrics.observe(labels({ service: 'svc-a' }), 0.01);
    metrics.observe(labels({ service: 'svc-b' }), 0.01);
    expect(metrics.size()).toBe(2);

    metrics.observe(labels({ service: 'svc-c', method: 'GET', status: '4xx', outcome: 'anonymous' }), 0.01);
    expect(metrics.size()).toBe(3);

    metrics.observe(labels({ service: 'svc-d', module: 'pay', method: 'PUT', status: '5xx', outcome: 'refused' }), 0.01);
    expect(metrics.size()).toBe(3);

    const overflow = parseExposition(metrics.render()).samples.find(
      (sample) => sample.name === REQUESTS_TOTAL && sample.labels.module === MODULE_OVERFLOW,
    );
    expect(overflow?.value).toBe(2);
    expect(overflow?.labels).toEqual({
      service: MODULE_OVERFLOW,
      module: MODULE_OVERFLOW,
      method: MODULE_OVERFLOW,
      status: MODULE_OVERFLOW,
      outcome: MODULE_OVERFLOW,
    });
  });
});
