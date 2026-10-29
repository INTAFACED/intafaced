import { describe, expect, it } from 'vitest';
import { isTestBuild } from './test-build';

const page = (content: string | null) => ({
  querySelector: (selector: string) =>
    selector === 'meta[name="intafaced-build"]' && content !== null
      ? { getAttribute: (name: string) => (name === 'content' ? content : null) }
      : null,
});

describe('isTestBuild', () => {
  it('is true only for the test build tag', () => {
    expect(isTestBuild(page('test') as unknown as Document)).toBe(true);
  });
  it('is false with no tag or another value', () => {
    expect(isTestBuild(page(null) as unknown as Document)).toBe(false);
    expect(isTestBuild(page('live') as unknown as Document)).toBe(false);
    expect(isTestBuild(page('TEST') as unknown as Document)).toBe(false);
  });
});
