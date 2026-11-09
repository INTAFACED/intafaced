import { createSbeCodec, loadJavaSbeCodec, type JavaSbeCodec, type SbeCodec } from '@intafaced/sbe-codec';

/** Logged once at boot when this process serves with no SBE codec; the SBE doors then refuse `depth.sbe_unavailable`. */
export const WS_SBE_UNLINKED = 'ws.sbe_unlinked';

/**
 * The SBE codec this process serves with, chosen by its own `INTAFACED_SBE_JAVA` (env.ts).
 *
 * Pinned (the image pins `/app/sbe-codec.jar`): that jar, on the Java `JAVA_HOME` or PATH names. Unpinned: no codec,
 * so the public L2 SBE doors refuse `depth.sbe_unavailable`, as env.ts promises.
 *
 * Never the package's unpinned fallback (`sbeCodec`): that one runs `scripts/ensure-build.mjs` through `spawnSync`, a
 * JDK and Maven download plus `mvn package` with a 20-minute ceiling, made for a test run by hand. Inside this process
 * it ran at the first read of `linked`, just after `listen`, and froze the event loop for as long as the downloads took:
 * `/health` did not answer, and the stack's start gave up after 90 s (#7554).
 */
export function serviceSbeCodec(
  pinned: string | undefined,
  deps: { readonly load?: () => JavaSbeCodec | null; readonly create?: typeof createSbeCodec } = {},
): SbeCodec {
  const load = deps.load ?? loadJavaSbeCodec;
  const create = deps.create ?? createSbeCodec;
  // The loader treats a blank pin as no pin and falls back to the build; here a blank pin is simply unpinned.
  const java = pinned !== undefined && pinned.trim().length > 0 ? load() : null;
  return create({ java });
}
