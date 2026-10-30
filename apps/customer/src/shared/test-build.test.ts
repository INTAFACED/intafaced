import { describe, expect, it } from 'vitest';
import { isTestBuild } from './test-build';

const page = (ids: string[]) => ({ getElementById: (id: string) => (ids.includes(id) ? ({ id } as unknown as HTMLElement) : null) });

describe('isTestBuild', () => {
  it('is true only when the page carries the local test stack banner', () => {
    expect(isTestBuild(page(['local-test-stack-banner']))).toBe(true);
  });
  it('is false with no banner or another element', () => {
    expect(isTestBuild(page([]))).toBe(false);
    expect(isTestBuild(page(['root']))).toBe(false);
    expect(isTestBuild(page(['LOCAL-TEST-STACK-BANNER']))).toBe(false);
  });
});
