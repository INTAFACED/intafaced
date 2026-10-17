/**
 * Optional load of the Real Logic SBE 1.39.0 Java stubs.
 *
 * Missing/unloadable generator output is unavailable — not a cue to fake SBE
 * with protobuf. Isolated JDK+Maven lives under this package's `.tools/`.
 * Image/compose pins `INTAFACED_SBE_JAVA` to the shaded jar (H3).
 */

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JavaSbeCodec } from './types.js';

export const JAVA_ENV = 'INTAFACED_SBE_JAVA';
export const SBE_MAIN = 'io.intafaced.sbe.SbeCodecMain';

function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

export function javaMainClassPath(): string | null {
  const fromEnv = process.env[JAVA_ENV];
  if (fromEnv && fromEnv.trim().length > 0 && existsSync(fromEnv.trim())) return fromEnv.trim();
  const shaded = join(packageRoot(), 'target', 'sbe-codec-0.0.0.jar');
  if (existsSync(shaded)) return shaded;
  const compiled = join(packageRoot(), 'target', 'classes', 'io', 'intafaced', 'sbe', 'SbeCodecMain.class');
  return existsSync(compiled) ? compiled : null;
}

function resolveJavaBin(): string | null {
  const home = process.env.JAVA_HOME?.trim();
  if (home) {
    const pinned = join(home, 'bin', 'java');
    if (existsSync(pinned)) return pinned;
  }
  const which = spawnSync('which', ['java'], { encoding: 'utf8' });
  const path = which.status === 0 ? which.stdout.trim() : '';
  if (path.length > 0 && existsSync(path)) {
    const probe = spawnSync(path, ['-version'], { encoding: 'utf8' });
    const out = `${probe.stdout ?? ''}${probe.stderr ?? ''}`;
    if (probe.status === 0 || /version/i.test(out)) return path;
  }
  return null;
}

/**
 * Unpinned: ask scripts/ensure-build.mjs for a JDK and the content-hashed codec jar. When the jar is already
 * built (turbo runs `build:jar` before the tests, see turbo.json) this is a hash and a stat, no lock, no Maven.
 * Only if it is missing (vitest run by hand) does it build, behind a plain mkdir lock that is never stolen.
 */
// Ceiling for the fallback build: a 300 s lock wait, or bounded toolchain downloads plus a 180 s `mvn package`.
const BUILD_TIMEOUT_MS = 1_200_000;

function compileAndClasspath(): { java: string; classpath: string } | null {
  try {
    const r = spawnSync(process.execPath, [join(packageRoot(), 'scripts', 'ensure-build.mjs')], {
      encoding: 'utf8',
      cwd: packageRoot(),
      timeout: BUILD_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    if (r.status !== 0) {
      // A missing or broken codec must not look like a clean skip: say why, on stderr.
      process.stderr.write(`${r.stderr || `sbe-codec jar build failed (${r.status ?? r.signal})`}\n`);
      return null;
    }
    const line = r.stdout.trim().split('\n').filter(Boolean).at(-1);
    if (line === undefined) return null;
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const rec = parsed as { JAVA_HOME?: unknown; JAR?: unknown };
    if (typeof rec.JAVA_HOME !== 'string' || typeof rec.JAR !== 'string') return null;
    const java = join(rec.JAVA_HOME, 'bin', 'java');
    return existsSync(java) && existsSync(rec.JAR) ? { java, classpath: rec.JAR } : null;
  } catch {
    return null;
  }
}

function runtimeFromEnv(): { java: string; classpath: string } | null {
  const pinned = process.env[JAVA_ENV]?.trim();
  if (!pinned) return null;
  if (!existsSync(pinned)) return null;
  const java = resolveJavaBin();
  if (java === null) return null;
  return { java, classpath: pinned };
}

function spawnCodec(ready: { java: string; classpath: string }): JavaSbeCodec {
  return {
    handle(json: string): string {
      const r = spawnSync(ready.java, ['--add-opens', 'java.base/jdk.internal.misc=ALL-UNNAMED', '-cp', ready.classpath, SBE_MAIN], {
        input: json,
        encoding: 'utf8',
        cwd: packageRoot(),
        timeout: 90_000,
        killSignal: 'SIGKILL',
      });
      const out = `${r.stdout ?? ''}`.trim();
      const processFailed = r.error != null || r.signal != null || r.status !== 0;
      if (processFailed || !out) {
        const err = `${r.stderr ?? ''}`.trim();
        const spawned = r.error instanceof Error ? r.error.message : '';
        const killed = r.signal != null ? `SBE Java codec killed by ${r.signal}` : '';
        const exited = processFailed ? `SBE Java codec exited ${String(r.status)}` : 'SBE Java codec produced no output';
        throw new Error(err || spawned || killed || exited);
      }
      const jsonStart = out.indexOf('{');
      return jsonStart >= 0 ? out.slice(jsonStart) : out;
    },
  };
}

export function loadJavaSbeCodec(): JavaSbeCodec | null {
  const pinned = process.env[JAVA_ENV]?.trim();
  if (pinned && pinned.length > 0) {
    const ready = runtimeFromEnv();
    return ready === null ? null : spawnCodec(ready);
  }
  const ready = compileAndClasspath();
  return ready === null ? null : spawnCodec(ready);
}
