import { describe, expect, it } from 'vitest';
import type { JavaSbeCodec } from '@intafaced/sbe-codec';
import { serviceSbeCodec } from './sbe-runtime.js';

/**
 * #7554: an unpinned svc-ws must never reach the sbe-codec fallback build (a synchronous JDK download and
 * `mvn package`), which froze its event loop so `/health` never answered.
 */
describe('serviceSbeCodec', () => {
  const fakeJava: JavaSbeCodec = { handle: () => '{}' };

  it('unpinned: never calls the loader, and the codec is unlinked', () => {
    let loads = 0;
    const codec = serviceSbeCodec(undefined, {
      load: () => {
        loads += 1;
        return fakeJava;
      },
    });
    expect(loads).toBe(0);
    expect(codec.linked).toBe(false);
  });

  it('a blank pin is unpinned, not the loader (whose blank pin means the fallback build)', () => {
    let loads = 0;
    const codec = serviceSbeCodec('   ', {
      load: () => {
        loads += 1;
        return fakeJava;
      },
    });
    expect(loads).toBe(0);
    expect(codec.linked).toBe(false);
  });

  it('pinned: loads the pinned jar once, and the codec is linked when it loads', () => {
    let loads = 0;
    const codec = serviceSbeCodec('/app/sbe-codec.jar', {
      load: () => {
        loads += 1;
        return fakeJava;
      },
    });
    expect(loads).toBe(1);
    expect(codec.linked).toBe(true);
  });

  it('pinned but unloadable (jar or Java missing): unlinked, not a build', () => {
    const codec = serviceSbeCodec('/nowhere/sbe-codec.jar', { load: () => null });
    expect(codec.linked).toBe(false);
  });

  it('the default unpinned path returns at once (no spawned build)', () => {
    const t0 = Date.now();
    const codec = serviceSbeCodec(undefined);
    expect(codec.linked).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});
