import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureToolchain, installedJdkHome } from '../scripts/ensure-toolchain.mjs';

const TEMURIN_DIR = 'jdk-21.0.12.1+1';
const MARKER = 'keep-me';

function freshTools(): string {
  return mkdtempSync(join(tmpdir(), 'sbe-jdk-cache-'));
}

function mavenStub(tools: string): void {
  const bin = join(tools, 'maven', 'apache-maven-3.9.11', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'mvn'), '');
}

function markerFile(jdkRoot: string): string {
  const path = join(jdkRoot, MARKER);
  writeFileSync(path, 'present');
  return path;
}

function expectCached(tools: string, markerPath: string, javaHome: string): void {
  const env = ensureToolchain(tools);
  expect(existsSync(markerPath)).toBe(true);
  expect(readFileSync(markerPath, 'utf8')).toBe('present');
  expect(existsSync(join(tools, 'jdk.tgz'))).toBe(false);
  expect(existsSync(join(tools, 'maven.tgz'))).toBe(false);
  expect(env.JAVA_HOME).toBe(javaHome);
  expect(installedJdkHome(join(tools, 'jdk'))).toBe(javaHome);
  const envPath = join(tools, 'env.json');
  expect(envPath.startsWith(tools)).toBe(true);
  const written = JSON.parse(readFileSync(envPath, 'utf8')) as {
    JAVA_HOME: string;
    MVN: string;
    MAVEN_REPO: string;
  };
  expect(written.JAVA_HOME).toBe(javaHome);
  expect(written.MVN).toBe(join(tools, 'maven', 'apache-maven-3.9.11', 'bin', 'mvn'));
  expect(written.MAVEN_REPO).toBe(join(tools, 'm2'));
}

describe('JDK cache keeps a nested Temurin home', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function track(): string {
    const dir = freshTools();
    dirs.push(dir);
    return dir;
  }

  it('keeps a mac nested home and does not re-extract', () => {
    const tools = track();
    const jdkRoot = join(tools, 'jdk');
    const javaHome = join(jdkRoot, TEMURIN_DIR, 'Contents', 'Home');
    mkdirSync(join(javaHome, 'bin'), { recursive: true });
    writeFileSync(join(javaHome, 'bin', 'java'), '');
    const markerPath = markerFile(jdkRoot);
    mavenStub(tools);
    expectCached(tools, markerPath, javaHome);
  });

  it('keeps a linux nested home and does not re-extract', () => {
    const tools = track();
    const jdkRoot = join(tools, 'jdk');
    const javaHome = join(jdkRoot, TEMURIN_DIR);
    mkdirSync(join(javaHome, 'bin'), { recursive: true });
    writeFileSync(join(javaHome, 'bin', 'java'), '');
    const markerPath = markerFile(jdkRoot);
    mavenStub(tools);
    expectCached(tools, markerPath, javaHome);
  });

  it('keeps a direct jdk/bin/java home and does not re-extract', () => {
    const tools = track();
    const jdkRoot = join(tools, 'jdk');
    mkdirSync(join(jdkRoot, 'bin'), { recursive: true });
    writeFileSync(join(jdkRoot, 'bin', 'java'), '');
    const markerPath = markerFile(jdkRoot);
    mavenStub(tools);
    expectCached(tools, markerPath, jdkRoot);
  });

  it('does not treat a nested tree with no java file as an installed home', () => {
    const tools = track();
    const jdkRoot = join(tools, 'jdk');
    mkdirSync(join(jdkRoot, 'bin'), { recursive: true });
    mkdirSync(join(jdkRoot, TEMURIN_DIR, 'Contents', 'Home', 'bin'), { recursive: true });
    mkdirSync(join(jdkRoot, TEMURIN_DIR, 'bin'), { recursive: true });
    // A miss downloads. The guard alone must reject this tree.
    expect(installedJdkHome(jdkRoot)).toBeNull();
    expect(existsSync(join(jdkRoot, 'bin', 'java'))).toBe(false);
    expect(existsSync(join(jdkRoot, TEMURIN_DIR, 'Contents', 'Home', 'bin', 'java'))).toBe(false);
    expect(existsSync(join(jdkRoot, TEMURIN_DIR, 'bin', 'java'))).toBe(false);
  });
});
