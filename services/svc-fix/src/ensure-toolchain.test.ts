import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureToolchain, temurinJavaHome } from '../scripts/ensure-toolchain.mjs';

const execFileSync = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('toolchain test must not spawn');
  }),
);

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync };
});

const TEMURIN = 'jdk-21.0.12.1+1';

describe('unpacked Temurin home is the JDK sentinel', () => {
  const made: string[] = [];

  afterEach(() => {
    execFileSync.mockClear();
    while (made.length > 0) {
      const dir = made.pop();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function newTools(): string {
    const dir = fs.mkdtempSync(join(tmpdir(), 'svc-fix-jdk-'));
    made.push(dir);
    // Present so the Maven pin check does not download.
    const mvn = join(dir, 'maven', 'apache-maven-3.9.11', 'bin', 'mvn');
    fs.mkdirSync(dirname(mvn), { recursive: true });
    fs.writeFileSync(mvn, '');
    return dir;
  }

  function touch(path: string): void {
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(path, '');
  }

  function assertKept(tools: string, home: string): void {
    const jdkRoot = join(tools, 'jdk');
    const marker = join(jdkRoot, 'keep.txt');
    fs.writeFileSync(marker, 'stay');
    const before = fs.statSync(marker).ino;
    expect(ensureToolchain(tools).JAVA_HOME).toBe(home);
    expect(ensureToolchain(tools).JAVA_HOME).toBe(home);
    expect(fs.existsSync(join(home, 'bin', 'java'))).toBe(true);
    expect(fs.readFileSync(marker, 'utf8')).toBe('stay');
    expect(fs.statSync(marker).ino).toBe(before);
    expect(fs.existsSync(join(tools, 'jdk.tgz'))).toBe(false);
    expect(execFileSync).not.toHaveBeenCalled();
  }

  it('uses the macOS Contents/Home layout and leaves the tree in place', () => {
    const tools = newTools();
    const home = join(tools, 'jdk', TEMURIN, 'Contents', 'Home');
    touch(join(home, 'bin', 'java'));
    assertKept(tools, home);
  });

  it('uses the linux layout and leaves the tree in place', () => {
    const tools = newTools();
    const home = join(tools, 'jdk', TEMURIN);
    touch(join(home, 'bin', 'java'));
    assertKept(tools, home);
  });

  it('does not treat jdk/bin/java as the Temurin home', () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'svc-fix-jdk-'));
    made.push(dir);
    const jdkRoot = join(dir, 'jdk');
    touch(join(jdkRoot, 'bin', 'java'));
    expect(fs.existsSync(join(jdkRoot, 'bin', 'java'))).toBe(true);
    expect(temurinJavaHome(jdkRoot)).toBeNull();
    expect(temurinJavaHome(jdkRoot)).not.toBe(jdkRoot);
  });
});
