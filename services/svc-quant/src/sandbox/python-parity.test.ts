import { describe, expect, it } from 'vitest';
import { runSandbox } from './run.js';

// RC-algo-dev-03 (J-algo-dev-16 #1): a Python strategy meets the same events and the same limits as its JavaScript twin.
const deps = {
  wired: true,
  venueVaultSet: false,
  paperFeeBps: '10',
  limits: { maxOps: 5_000, maxSource: 8_000, run: { wallClockMs: 5_000, memoryBytes: 1_000_000, outputBytes: 200_000 } },
};
const JS = `const a = oms.limitBuy("BTC-USD", "0.01", "49990", "gtc");
const z = oms.limitBuy("BTC-USD", "0", "49990", "gtc");
console.log(z.status);
console.log(z.reason);`;
const PY = `a = oms.limitBuy("BTC-USD", "0.01", "49990", "gtc")
z = oms.limitBuy("BTC-USD", "0", "49990", "gtc")
print(z.status)
print(z.reason)`;
const run = (language: 'javascript' | 'python', source: string) =>
  runSandbox({ language, source, cash: '1000', environment: 'paper', presentedAs: 'paper' }, deps);

describe('Python in the sandbox', () => {
  it('records the same order events, fills, logs and limits as the JavaScript runtime', () => {
    const js = run('javascript', JS);
    const py = run('python', PY);
    expect(py.events.length).toBeGreaterThan(0);
    expect(py.events.map((e) => e.kind)).toEqual(js.events.map((e) => e.kind));
    expect(py.events).toEqual(js.events);
    expect(py.fills).toEqual(js.fills);
    expect(py.logs).toEqual(js.logs);
    expect(py.limits).toEqual(js.limits);
    expect(py.limits).toEqual({ wallClockMs: 5_000, memoryBytes: 1_000_000, outputBytes: 200_000, maxOps: 5_000, maxSource: 8_000 });
  });

  it('refuses Python that imports a module or opens a file, as the JavaScript runtime refuses a require', () => {
    expect(() => run('python', 'import os\nprint(1)')).toThrow(/^quant\.sandbox_escape — /);
    expect(() => run('python', 'f = open("/etc/passwd")')).toThrow(/^quant\.sandbox_escape — /);
  });
});
