#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureToolchain } from './ensure-toolchain.mjs';
import { runMvnSync } from '../../../tooling/scripts/mvn-run.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = ensureToolchain();
const compile = runMvnSync(env.MVN, ['-q', '-Dmaven.repo.local=' + env.MAVEN_REPO, '-DskipTests', 'compile'], {
  cwd: ROOT,
  env: { ...process.env, JAVA_HOME: env.JAVA_HOME, PATH: `${join(env.JAVA_HOME, 'bin')}:${process.env.PATH ?? ''}` },
});
if (compile.status !== 0) process.exit(compile.status === null ? 1 : compile.status);

const cp = runMvnSync(
  env.MVN,
  ['-q', '-Dmaven.repo.local=' + env.MAVEN_REPO, 'dependency:build-classpath', '-Dmdep.outputFile=.tools/cp.txt'],
  {
    cwd: ROOT,
    env: { ...process.env, JAVA_HOME: env.JAVA_HOME, PATH: `${join(env.JAVA_HOME, 'bin')}:${process.env.PATH ?? ''}` },
    out: null,
  },
);
if (cp.status !== 0) {
  process.stderr.write(`${cp.stdout ?? ''}${cp.stderr ?? ''}`);
  process.exit(cp.status === null ? 1 : cp.status);
}

const { readFileSync } = await import('node:fs');
const classpath = `${join(ROOT, 'target/classes')}:${readFileSync(join(ROOT, '.tools/cp.txt'), 'utf8').trim()}`;
const r = spawnSync(join(env.JAVA_HOME, 'bin', 'java'), ['-cp', classpath, 'io.intafaced.fix.FixAcceptorMain'], {
  cwd: ROOT,
  env: { ...process.env, JAVA_HOME: env.JAVA_HOME },
  stdio: 'inherit',
});
process.exit(r.status === null ? 1 : r.status);
