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

it('keeps existing series usable and accounts for every overflow request', () => {
  const metrics = new Metrics(1);
  const kept = labels({ service: 'svc-kept' });
  metrics.observe(kept, 0.1);
  for (let i = 0; i < 100; i++) metrics.observe(labels({ service: `svc-${i}`, method: `METHOD-${i}` }), 0.2);
  metrics.observe(kept, 0.3);
  expect(metrics.size()).toBe(2);
  const requests = parseExposition(metrics.render()).samples.filter((sample) => sample.name === REQUESTS_TOTAL);
  expect(requests.find((sample) => sample.labels.service === 'svc-kept')?.value).toBe(2);
  expect(requests.find((sample) => sample.labels.module === MODULE_OVERFLOW)?.value).toBe(100);
  expect(requests.reduce((sum, sample) => sum + sample.value, 0)).toBe(102);
});
