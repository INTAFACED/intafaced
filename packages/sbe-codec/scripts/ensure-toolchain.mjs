#!/usr/bin/env node
/**
 * Isolated JDK 21 + Maven 3.9.11 for Real Logic SBE 1.39.0. Not a global install.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = join(ROOT, '.tools');

const MAVEN = {
  url: 'https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.11/apache-maven-3.9.11-bin.tar.gz',
  sha512:
    'bcfe4fe305c962ace56ac7b5fc7a08b87d5abd8b7e89027ab251069faebee516b0ded8961445d6d91ec1985dfe30f8153268843c89aa392733d1a3ec956c9978',
  dir: 'apache-maven-3.9.11',
};

const JDK = {
  'darwin-arm64': {
    url: 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.12.1_1.tar.gz',
    sha256: '3623232f33a9c3baadf304480b2535f9a3cba8a58d42ecbb438ba267315d9998',
  },
  'darwin-x64': {
    url: 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jdk_x64_mac_hotspot_21.0.12.1_1.tar.gz',
    sha256: '44db0f08196daf19a47f90d13388b0c943b67663cb537f998fe29e836fa842ce',
  },
  'linux-x64': {
    url: 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jdk_x64_linux_hotspot_21.0.12.1_1.tar.gz',
    sha256: 'ce79869e1307ed8ee1e2baa86a412b1eb5b75d10a01006d788a6f968bcfaee94',
  },
};

const DOWNLOAD_MAX_SECONDS = 240;

function key() {
  const plat = process.platform === 'darwin' ? 'darwin' : process.platform;
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch;
  return `${plat}-${arch}`;
}

function hashFile(path, alg) {
  const h = createHash(alg);
  h.update(readFileSync(path));
  return h.digest('hex');
}

function download(url, dest, alg, expected) {
  mkdirSync(dirname(dest), { recursive: true });
  if (existsSync(dest) && hashFile(dest, alg) === expected) return;
  // Download aside and rename, so a second process never reads (or appends to) a half-written archive.
  // Bounded: each attempt gets DOWNLOAD_MAX_SECONDS, retries start only inside the first 120 s.
  const part = `${dest}.${process.pid}.part`;
  try {
    execFileSync(
      'curl',
      [
        '-L',
        '--fail',
        '--connect-timeout',
        '20',
        '--max-time',
        String(DOWNLOAD_MAX_SECONDS),
        '--retry',
        '3',
        '--retry-max-time',
        '120',
        '-o',
        part,
        url,
      ],
      { stdio: 'inherit' },
    );
    const got = hashFile(part, alg);
    if (got !== expected) throw new Error(`checksum mismatch for ${url}: ${got}`);
    renameSync(part, dest);
  } finally {
    rmSync(part, { force: true });
  }
}

/**
 * Unpack a tarball into `target` aside, then rename it into place. Two processes that both found the tool
 * missing each unpack their own copy; the loser sees the winner's directory and throws its copy away.
 */
function unpackOnce(tarball, target, isReady) {
  if (isReady()) return;
  const staging = `${target}.extract-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    execFileSync('tar', ['-xzf', tarball, '-C', staging], { stdio: 'inherit' });
    if (isReady()) return;
    try {
      renameSync(staging, target);
      return;
    } catch (err) {
      if (isReady()) return; // another process finished it first; keep theirs
      if (!existsSync(target)) throw err;
    }
    // Something not ready is in the way: a partial tree from an older run. Move it aside (never delete in place, never
    // rename away a finished tree: the readiness check just above says it is not one), then put ours in.
    try {
      renameSync(target, `${target}.stale-${process.pid}`);
    } catch {
      /* another process moved it first */
    }
    try {
      renameSync(staging, target);
    } catch (err) {
      if (!isReady()) throw err;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(`${target}.stale-${process.pid}`, { recursive: true, force: true });
  }
}

export function ensureToolchain() {
  mkdirSync(TOOLS, { recursive: true });
  const k = key();
  const jdkPin = JDK[k];
  if (!jdkPin) throw new Error(`no pinned Temurin 21 for ${k}`);

  const jdkTar = join(TOOLS, 'jdk.tgz');
  const jdkRoot = join(TOOLS, 'jdk');
  // Where the Temurin tarball puts `bin/java`: under its own top-level directory, so `jdk/bin/java` never
  // exists. Checking that path made EVERY call delete and re-extract the JDK, under any JVM another process
  // was running from it (#4710). Extract only when no JDK is there, aside, then rename, so nobody sees a
  // half-written tree.
  const macHome = join(jdkRoot, 'jdk-21.0.12.1+1', 'Contents', 'Home');
  const linuxHome = join(jdkRoot, 'jdk-21.0.12.1+1');
  const hasJdk = () => existsSync(join(macHome, 'bin', 'java')) || existsSync(join(linuxHome, 'bin', 'java'));
  if (!hasJdk()) {
    download(jdkPin.url, jdkTar, 'sha256', jdkPin.sha256);
    unpackOnce(jdkTar, jdkRoot, hasJdk);
  }
  let javaHome = jdkRoot;
  if (existsSync(join(macHome, 'bin', 'java'))) javaHome = macHome;
  else if (existsSync(join(linuxHome, 'bin', 'java'))) javaHome = linuxHome;
  else {
    const javac = execFileSync('find', [jdkRoot, '-type', 'f', '-name', 'javac'], { encoding: 'utf8' }).trim().split('\n').find(Boolean);
    if (!javac) throw new Error('javac not found in extracted JDK');
    javaHome = dirname(dirname(javac));
  }

  const mvnTar = join(TOOLS, 'maven.tgz');
  const mvnRoot = join(TOOLS, 'maven');
  const mvnBin = join(mvnRoot, MAVEN.dir, 'bin', 'mvn');
  if (!existsSync(mvnBin)) {
    download(MAVEN.url, mvnTar, 'sha512', MAVEN.sha512);
    unpackOnce(mvnTar, mvnRoot, () => existsSync(mvnBin));
  }

  const env = {
    JAVA_HOME: javaHome,
    MVN: existsSync(mvnBin) ? mvnBin : join(mvnRoot, MAVEN.dir, 'bin', 'mvn'),
    MAVEN_REPO: join(TOOLS, 'm2'),
  };
  writeFileSync(join(TOOLS, 'env.json'), JSON.stringify(env, null, 2));
  return env;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = ensureToolchain();
  process.stdout.write(JSON.stringify(env) + '\n');
}
