#!/usr/bin/env node
/**
 * Builds the Real Logic SBE codec jar once and prints, as one JSON line, a JDK and the jar:
 *   {"JAVA_HOME": "...", "JAR": "..."}
 *
 * Run as `pnpm --filter @intafaced/sbe-codec run build:jar`, which turbo runs ONCE before the tests of every
 * package that links the codec (turbo.json), so no test process builds anything. java-bridge.ts also calls it as
 * a fallback when someone runs vitest directly and the jar is missing.
 *
 * The jar is content-addressed: `.tools/jars/<sha256 of the inputs>.jar`. It exists only after `mvn package`
 * exited cleanly, the jar was checked to hold the shaded agrona classes, and it was copied aside and renamed into
 * place, so a reader never sees a partial one (a build killed mid-shade used to leave a thin jar that then looked
 * fresh, #4710). The hash covers pom.xml, schema/, the hand-written Java and the toolchain pins. It skips
 * src/main/java/io/intafaced/sbe/md/: the SBE generator rewrites that tracked directory on every Maven run.
 *
 * If the jar exists: no lock, no Maven. Otherwise the build takes a plain `mkdir` lock. The lock is never stolen:
 * a waiter waits up to LOCK_WAIT_MS and then fails loudly, naming the directory.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureToolchain } from './ensure-toolchain.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS_DIR = join(ROOT, '.tools');
const JARS = join(TOOLS_DIR, 'jars');
const LOCK_DIR = join(TOOLS_DIR, 'build.lock');
const MVN_TIMEOUT_MS = 180_000;
const LOCK_WAIT_MS = 300_000;

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

export function inputHash() {
  const generated = `${sep}io${sep}intafaced${sep}sbe${sep}md${sep}`;
  const files = [
    join(ROOT, 'pom.xml'),
    join(ROOT, 'scripts', 'ensure-toolchain.mjs'),
    join(ROOT, 'scripts', 'ensure-build.mjs'),
    ...walk(join(ROOT, 'schema')),
    ...walk(join(ROOT, 'src', 'main')).filter((file) => !file.includes(generated)),
  ].sort();
  const hash = createHash('sha256');
  for (const file of files) hash.update(relative(ROOT, file)).update('\0').update(readFileSync(file)).update('\0');
  return hash.digest('hex');
}

function readyEnv() {
  try {
    const env = JSON.parse(readFileSync(join(TOOLS_DIR, 'env.json'), 'utf8'));
    return existsSync(join(env.JAVA_HOME, 'bin', 'java')) && existsSync(env.MVN) ? env : null;
  } catch {
    return null;
  }
}

/** The running mvn, so an interrupt can stop it. The build is async so the signal handler can run while it works. */
let child = null;

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Why a waiter gave up, from the pid the holder wrote into the lock. */
function describeHolder() {
  let pid = NaN;
  try {
    pid = Number(readFileSync(join(LOCK_DIR, 'pid'), 'utf8').trim());
  } catch {
    /* no pid file: the holder died between mkdir and writing it, or is about to write it */
  }
  if (!Number.isInteger(pid) || pid <= 0) return `held by an unknown process (no pid file); if no build is running, delete ${LOCK_DIR}`;
  return pidIsAlive(pid) ? `held by live pid ${pid}; wait for it to finish` : `held by dead pid ${pid}: delete ${LOCK_DIR}`;
}

/**
 * Plain mkdir lock with the owner's pid inside it. Never stolen: a waiter reports who holds it, and a human removes
 * a dead holder's directory. The owner removes the lock on exit and on Ctrl-C / SIGTERM, so a normal interrupt leaves none.
 */
async function withBuildLock(fn) {
  mkdirSync(TOOLS_DIR, { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() > deadline)
        throw new Error(`gave up after ${LOCK_WAIT_MS / 1000} s waiting for another sbe-codec build: lock ${describeHolder()}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
  writeFileSync(join(LOCK_DIR, 'pid'), String(process.pid));
  const release = () => rmSync(LOCK_DIR, { recursive: true, force: true });
  const onSignal = (signal) => {
    child?.kill('SIGKILL'); // do not orphan a running mvn
    release();
    process.removeListener(signal, onSignal);
    process.kill(process.pid, signal); // re-raise with the default action
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    return await fn();
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    release();
  }
}

async function build(env, jar) {
  const mvnEnv = { ...process.env, JAVA_HOME: env.JAVA_HOME, PATH: `${join(env.JAVA_HOME, 'bin')}:${process.env.PATH ?? ''}` };
  // Start the shade step from a freshly packaged jar, never from an earlier (maybe truncated) output.
  for (const name of ['sbe-codec-0.0.0.jar', 'original-sbe-codec-0.0.0.jar', 'sbe-codec-0.0.0-shaded.jar']) {
    rmSync(join(ROOT, 'target', name), { force: true });
  }
  const r = await new Promise((resolve) => {
    let stderr = '';
    let timedOut = false;
    child = spawn(env.MVN, ['-q', `-Dmaven.repo.local=${env.MAVEN_REPO}`, '-DskipTests', 'package'], {
      cwd: ROOT,
      env: mvnEnv,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, MVN_TIMEOUT_MS);
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      child = null;
      resolve({ status: timedOut ? null : status, signal: timedOut ? 'timeout' : signal, stderr });
    });
  });
  if (r.status !== 0) throw new Error(`mvn package failed (${r.status ?? r.signal}): ${r.stderr.slice(0, 400)}`);
  const built = join(ROOT, 'target', 'sbe-codec-0.0.0.jar');
  const listing = execFileSync(join(env.JAVA_HOME, 'bin', 'jar'), ['tf', built], { encoding: 'utf8', env: mvnEnv });
  if (!listing.includes('org/agrona/MutableDirectBuffer.class') || !listing.includes('io/intafaced/sbe/SbeCodecMain.class')) {
    throw new Error('built jar is missing the codec or the shaded agrona classes');
  }
  mkdirSync(JARS, { recursive: true });
  const staging = join(JARS, `.${process.pid}.tmp`);
  copyFileSync(built, staging);
  renameSync(staging, jar);
  for (const name of readdirSync(JARS)) if (join(JARS, name) !== jar && name.endsWith('.jar')) rmSync(join(JARS, name), { force: true });
}

async function main() {
  const jar = join(JARS, `${inputHash()}.jar`);
  const quick = existsSync(jar) ? readyEnv() : null;
  if (quick) return { JAVA_HOME: quick.JAVA_HOME, JAR: jar };
  return withBuildLock(async () => {
    const env = ensureToolchain();
    if (!existsSync(jar)) await build(env, jar);
    return { JAVA_HOME: env.JAVA_HOME, JAR: jar };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.stdout.write(`${JSON.stringify(await main())}\n`);
  } catch (err) {
    process.stderr.write(`sbe-codec jar: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
