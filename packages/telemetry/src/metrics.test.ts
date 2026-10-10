import { describe, expect, it } from 'vitest';
import { parseExposition, type ParsedExposition, type ParsedSample } from './exposition.js';
import {
  DURATION_BUCKETS,
  EMITTED_LABEL_NAMES,
  METRIC_FAMILIES,
  Metrics,
  MODULE_OVERFLOW,
  PROMETHEUS_CONTENT_TYPE,
  REQUESTS_TOTAL,
  REQUEST_DURATION_SECONDS,
  methodLabel,
  statusClass,
  type HttpRequestLabels,
} from './metrics.js';

/**
 * THESE TESTS PARSE THE OUTPUT.
 *
 * They do not assert that the module exports a function, and they do not
 * compare the render against a string literal copied out of the render — both
 * of those pass while the endpoint emits something Prometheus refuses.
 *
 * `parseExposition` is a sibling module written from the exposition grammar
 * rather than from `metrics.ts`, and it is strict: any line it cannot parse
 * throws, because a line Prometheus cannot parse takes down the whole scrape
 * rather than that one sample. Same-package code can still drift together,
 * which is why it is not the only check — `promtool check metrics`, the real
 * Prometheus parser, is run against this renderer's output out of band.
 */

const LABELS: HttpRequestLabels = {
  service: 'svc-edge',
  module: 'trade',
  method: 'POST',
  status: '2xx',
  outcome: 'authenticated',
};

function samplesNamed(parsed: ParsedExposition, name: string): readonly ParsedSample[] {
  return parsed.samples.filter((s) => s.name === name);
}

describe('exposition format', () => {
  it('declares the counter and the histogram even before a single request', () => {
    const parsed = parseExposition(new Metrics().render());

    // "Served nothing yet" and "does not have this metric" are the same blank
    // panel unless the endpoint says which one it is.
    expect(parsed.type[REQUESTS_TOTAL]).toBe('counter');
    expect(parsed.type[REQUEST_DURATION_SECONDS]).toBe('histogram');
    expect(parsed.help[REQUESTS_TOTAL]).toBeTruthy();
    expect(parsed.help[REQUEST_DURATION_SECONDS]).toBeTruthy();
    expect(parsed.samples).toHaveLength(0);
  });

  it('counts requests under the labels it was given', () => {
    const m = new Metrics();
    m.observe(LABELS, 0.02);
    m.observe(LABELS, 0.03);
    m.observe({ ...LABELS, status: '5xx' }, 0.04);

    const parsed = parseExposition(m.render());
    const counters = samplesNamed(parsed, REQUESTS_TOTAL);
    expect(counters).toHaveLength(2);

    const ok = counters.find((s) => s.labels.status === '2xx');
    expect(ok?.value).toBe(2);
    expect(ok?.labels).toEqual({
      service: 'svc-edge',
      module: 'trade',
      method: 'POST',
      status: '2xx',
      outcome: 'authenticated',
    });

    expect(counters.find((s) => s.labels.status === '5xx')?.value).toBe(1);
  });

  it('emits every declared bucket, cumulatively, with +Inf equal to the count', () => {
    const m = new Metrics();
    // 0.02s lands in the 0.025 bucket and every wider one; 3s lands in 5 and 10.
    m.observe(LABELS, 0.02);
    m.observe(LABELS, 3);

    const parsed = parseExposition(m.render());
    const buckets = samplesNamed(parsed, `${REQUEST_DURATION_SECONDS}_bucket`);

    // One per declared boundary, plus +Inf.
    expect(buckets).toHaveLength(DURATION_BUCKETS.length + 1);

    const at = (le: string) => buckets.find((b) => b.labels.le === le)?.value;
    expect(at('0.01')).toBe(0);
    expect(at('0.025')).toBe(1);
    expect(at('1')).toBe(1);
    expect(at('2.5')).toBe(1);
    expect(at('5')).toBe(2);
    expect(at('10')).toBe(2);
    expect(at('+Inf')).toBe(2);

    // Monotonic non-decreasing. `histogram_quantile` relies on it, and a
    // hand-written renderer is exactly the thing that can break it.
    const ordered = [...DURATION_BUCKETS.map(String), '+Inf'].map((le) => at(le) as number);
    for (let i = 1; i < ordered.length; i += 1) {
      expect(ordered[i]).toBeGreaterThanOrEqual(ordered[i - 1] as number);
    }

    // A histogram whose +Inf disagrees with its _count is malformed, and
    // `histogram_quantile` answers nonsense rather than erroring.
    const count = samplesNamed(parsed, `${REQUEST_DURATION_SECONDS}_count`)[0];
    expect(count?.value).toBe(2);
    expect(at('+Inf')).toBe(count?.value);

    const sum = samplesNamed(parsed, `${REQUEST_DURATION_SECONDS}_sum`)[0];
    expect(sum?.value).toBeCloseTo(3.02, 9);
  });

  it('escapes label values so a quote cannot break out of the block', () => {
    const m = new Metrics();
    m.observe({ ...LABELS, module: 'we"ird\\path\nnewline' }, 0.01);

    // Round-trips: the parser recovers exactly what went in, which is the only
    // thing that makes a dashboard's label matcher meaningful.
    const parsed = parseExposition(m.render());
    expect(samplesNamed(parsed, REQUESTS_TOTAL)[0]?.labels.module).toBe('we"ird\\path\nnewline');
  });

  it('ends with a newline — a payload that does not is rejected outright', () => {
    const m = new Metrics();
    m.observe(LABELS, 0.5);
    expect(m.render().endsWith('\n')).toBe(true);
  });

  it('METRIC_FAMILIES is exactly the set of names actually rendered', () => {
    const m = new Metrics();
    m.observe(LABELS, 0.5);

    const rendered = new Set(parseExposition(m.render()).samples.map((s) => s.name));
    // Both directions, and that matters. A family listed but never emitted lets
    // a dashboard pass the wiring check and plot nothing; a family emitted but
    // not listed lets a future dashboard be checked against a short list.
    expect([...rendered].sort()).toEqual([...METRIC_FAMILIES].sort());
  });

  it('EMITTED_LABEL_NAMES is exactly the label set on a real sample', () => {
    const m = new Metrics();
    m.observe(LABELS, 0.5);

    const counter = samplesNamed(parseExposition(m.render()), REQUESTS_TOTAL)[0];
    expect(Object.keys(counter?.labels ?? {}).sort()).toEqual([...EMITTED_LABEL_NAMES].sort());
  });

  it('advertises the frozen 0.0.4 content type', () => {
    expect(PROMETHEUS_CONTENT_TYPE).toBe('text/plain; version=0.0.4; charset=utf-8');
  });
});

describe('cardinality', () => {
  it('collapses everything past the cap into one _overflow series', () => {
    const m = new Metrics(5);
    for (let i = 0; i < 50; i += 1) {
      m.observe({ ...LABELS, module: `module-${i}` }, 0.01);
    }

    // Five real series plus the one they overflow into.
    expect(m.size()).toBe(6);

    const parsed = parseExposition(m.render());
    const overflow = samplesNamed(parsed, REQUESTS_TOTAL).find((s) => s.labels.module === MODULE_OVERFLOW);
    expect(overflow?.value).toBe(45);
  });

  it('keeps counting into an existing series once the cap is reached', () => {
    const m = new Metrics(1);
    m.observe(LABELS, 0.01);
    m.observe(LABELS, 0.01);
    expect(m.size()).toBe(1);
    expect(samplesNamed(parseExposition(m.render()), REQUESTS_TOTAL)[0]?.value).toBe(2);
  });
});

describe('label bounding', () => {
  it('maps status codes to a class, and anything nonsensical to 5xx', () => {
    expect(statusClass(200)).toBe('2xx');
    expect(statusClass(204)).toBe('2xx');
    expect(statusClass(301)).toBe('3xx');
    expect(statusClass(404)).toBe('4xx');
    expect(statusClass(429)).toBe('4xx');
    expect(statusClass(502)).toBe('5xx');
    // An impossible code is a bug in the caller, and a bug is not a success.
    expect(statusClass(0)).toBe('5xx');
    expect(statusClass(Number.NaN)).toBe('5xx');
    expect(statusClass(999)).toBe('5xx');
  });

  it('refuses to let a caller invent a method label', () => {
    expect(methodLabel('get')).toBe('GET');
    expect(methodLabel('POST')).toBe('POST');
    expect(methodLabel('PROPFIND')).toBe('_other');
    expect(methodLabel(undefined)).toBe('_other');
    expect(methodLabel('')).toBe('_other');
  });
});

describe('duration handling', () => {
  it('treats a negative or non-finite duration as zero rather than dropping the request', () => {
    const m = new Metrics();
    m.observe(LABELS, -5);
    m.observe(LABELS, Number.NaN);

    const parsed = parseExposition(m.render());
    // Both still counted: dropping them would understate the denominator of
    // every availability ratio drawn from this counter.
    expect(samplesNamed(parsed, REQUESTS_TOTAL)[0]?.value).toBe(2);
    expect(samplesNamed(parsed, `${REQUEST_DURATION_SECONDS}_sum`)[0]?.value).toBe(0);
    // A clock glitch must not make the payload unparseable.
    expect(m.render()).not.toContain('NaN');
  });
});
