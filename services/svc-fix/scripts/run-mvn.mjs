#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureToolchain } from './ensure-toolchain.mjs';
import { runMvnSync } from '../../../tooling/scripts/mvn-run.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = ensureToolchain();
const args = process.argv.slice(2);
const r = runMvnSync(env.MVN, ['-q', '-Dmaven.repo.local=' + env.MAVEN_REPO, ...args], {
  cwd: ROOT,
  env: { ...process.env, JAVA_HOME: env.JAVA_HOME, PATH: `${join(env.JAVA_HOME, 'bin')}:${process.env.PATH ?? ''}` },
});
process.exit(r.status === null ? 1 : r.status);
