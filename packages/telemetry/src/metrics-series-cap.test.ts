import { describe, expect, it } from 'vitest';
import { Metrics, type HttpRequestLabels } from './metrics.js';

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
  it('stays at maxSeries when further distinct label sets arrive', () => {
    const metrics = new Metrics(2);

    metrics.observe(labels({ service: 'svc-a' }), 0.01);
    metrics.observe(labels({ service: 'svc-b' }), 0.01);
    expect(metrics.size()).toBe(2);

    metrics.observe(labels({ service: 'svc-c', method: 'GET', status: '4xx', outcome: 'anonymous' }), 0.01);
    expect(metrics.size()).toBe(2);

    metrics.observe(labels({ service: 'svc-d', module: 'pay', method: 'PUT', status: '5xx', outcome: 'refused' }), 0.01);
    expect(metrics.size()).toBe(2);
  });
});
