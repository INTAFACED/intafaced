#!/usr/bin/env node
/**
 * Isolated JDK 21 + Maven 3.9.11 for QuickFIX/J 3.0.2. Not a global install.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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
  execFileSync('curl', ['-L', '--fail', '--retry', '3', '-o', dest, url], { stdio: 'inherit' });
  const got = hashFile(dest, alg);
  if (got !== expected) {
    rmSync(dest, { force: true });
    throw new Error(`checksum mismatch for ${url}: ${got}`);
  }
}

/** Unpacked Temurin home, or null. `jdk/bin/java` is not this layout. */
export function temurinJavaHome(jdkRoot) {
  const unpacked = join(jdkRoot, 'jdk-21.0.12.1+1');
  const macHome = join(unpacked, 'Contents', 'Home');
  const linuxHome = unpacked;
  if (existsSync(join(macHome, 'bin', 'java'))) return macHome;
  if (existsSync(join(linuxHome, 'bin', 'java'))) return linuxHome;
  return null;
}

export function ensureToolchain(toolsDir = TOOLS) {
  mkdirSync(toolsDir, { recursive: true });
  const k = key();
  const jdkPin = JDK[k];
  if (!jdkPin) throw new Error(`no pinned Temurin 21 for ${k}`);

  const jdkTar = join(toolsDir, 'jdk.tgz');
  const jdkRoot = join(toolsDir, 'jdk');
  let javaHome = temurinJavaHome(jdkRoot);
  if (!javaHome) {
    download(jdkPin.url, jdkTar, 'sha256', jdkPin.sha256);
    rmSync(jdkRoot, { recursive: true, force: true });
    mkdirSync(jdkRoot, { recursive: true });
    execFileSync('tar', ['-xzf', jdkTar, '-C', jdkRoot], { stdio: 'inherit' });
    javaHome = temurinJavaHome(jdkRoot);
    if (!javaHome) {
      const javac = execFileSync('find', [jdkRoot, '-type', 'f', '-name', 'javac'], { encoding: 'utf8' }).trim().split('\n').find(Boolean);
      if (!javac) throw new Error('javac not found in extracted JDK');
      javaHome = dirname(dirname(javac));
    }
  }

  const mvnTar = join(toolsDir, 'maven.tgz');
  const mvnRoot = join(toolsDir, 'maven');
  const mvnBin = join(mvnRoot, MAVEN.dir, 'bin', 'mvn');
  if (!existsSync(mvnBin)) {
    download(MAVEN.url, mvnTar, 'sha512', MAVEN.sha512);
    rmSync(mvnRoot, { recursive: true, force: true });
    mkdirSync(mvnRoot, { recursive: true });
    execFileSync('tar', ['-xzf', mvnTar, '-C', mvnRoot], { stdio: 'inherit' });
  }

  const env = {
    JAVA_HOME: javaHome,
    MVN: existsSync(mvnBin) ? mvnBin : join(mvnRoot, MAVEN.dir, 'bin', 'mvn'),
    MAVEN_REPO: join(toolsDir, 'm2'),
  };
  writeFileSync(join(toolsDir, 'env.json'), JSON.stringify(env, null, 2));
  return env;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = ensureToolchain();
  process.stdout.write(JSON.stringify(env) + '\n');
}
