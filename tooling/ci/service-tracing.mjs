#!/usr/bin/env node
/**
 * SERVICE TRACING — every service a compose file runs starts tracing.
 *
 * svc-mining-pool ran for months with no tracer: its entry file never called
 * `startTelemetry`, so every span it could have made went to a no-op tracer and
 * nothing said so. svc-fix, the Java gateway, had no tracing at all. The only
 * thing that ever noticed was a report-only script nobody read.
 *
 * The entry point is read from the compose `command`, because that is the file
 * that really starts (svc-mining-pool's is `dist/server.js`, not its package's
 * `main`):
 *
 *   · `node services/<svc>/dist/<file>.js` → `services/<svc>/src/<file>.ts` must
 *     call `startTelemetry(` and `registerProcessHooks(` from
 *     `@intafaced/telemetry` (comments do not count).
 *   · `java …` → the command loads the OpenTelemetry Java agent
 *     (`-javaagent:…opentelemetry-javaagent.jar`), the service's Dockerfile
 *     puts that jar in the image, and the block sets `OTEL_JAVAAGENT_ENABLED`
 *     and `OTEL_EXPORTER_OTLP_ENDPOINT`.
 *
 * A service no compose file runs is not checked: nothing starts it.
 *
 * Usage: node tooling/ci/service-tracing.mjs
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NODE_EXAMPLE = 'services/svc-tax/src/index.ts';

/** Code with comments removed, so a commented-out call is not a call. */
export function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

/** Top-level services of a compose file: `{ name, block }`, `block` being the lines under the name. */
export function composeServices(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^services:\s*$/.test(l));
  if (start < 0) return [];
  const out = [];
  let current = null;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const head = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line);
    if (head) {
      current = { name: head[1], block: '' };
      out.push(current);
    } else if (current) {
      current.block += line + '\n';
    }
  }
  return out;
}

/** The `command` as a list, written on one line or wrapped (`[` … `]` over several lines, or `- item` lines). */
export function commandOf(block) {
  const flow = /^ {4}command:\s*\[([^\]]*)\]/m.exec(block);
  const quoted = (text) => [...text.matchAll(/'([^']*)'|"([^"]*)"/g)].map((x) => x[1] ?? x[2]);
  if (flow) return quoted(flow[1]);
  const listed = /^ {4}command:\s*\n((?: {6}- .*\n?)+)/m.exec(block);
  if (listed)
    return listed[1]
      .split('\n')
      .filter(Boolean)
      .map((l) =>
        l
          .replace(/^ {6}- /, '')
          .trim()
          .replace(/^(['"])(.*)\1$/, '$2'),
      );
  return null;
}

/**
 * Every untraced service, as `{ service, file, fix }`.
 * `composeFiles` is `[{ name, text }]`; `read(path)` returns a repo file's text or null.
 */
export function untraced(composeFiles, read) {
  const failures = [];
  for (const { name: composeName, text } of composeFiles) {
    for (const { name, block } of composeServices(text)) {
      const command = commandOf(block);
      if (!command) continue;
      if (command[0] === 'node') {
        const entry = command.find((arg) => /^services\/svc-[a-z0-9-]+\/dist\/.+\.js$/.test(arg));
        if (!entry) continue;
        const file = entry.replace('/dist/', '/src/').replace(/\.js$/, '.ts');
        const source = read(file);
        if (source === null) {
          failures.push({ service: name, file, fix: `${composeName} runs ${entry}, but ${file} does not exist` });
          continue;
        }
        const code = stripComments(source);
        const missing = ['startTelemetry(', 'registerProcessHooks('].filter((call) => !code.includes(call));
        if (missing.length > 0 || !/from\s+['"]@intafaced\/telemetry['"]/.test(code)) {
          failures.push({
            service: name,
            file,
            fix:
              `starts no tracing (missing ${missing.length > 0 ? missing.join(', ') : 'the @intafaced/telemetry import'}). ` +
              `Import { registerProcessHooks, startTelemetry } from '@intafaced/telemetry', call them at start-up as ` +
              `${NODE_EXAMPLE} does, and add "@intafaced/telemetry": "workspace:*" to the service's package.json`,
          });
        }
      } else if (command[0] === 'java') {
        const agent = command.some((arg) => /^-javaagent:\S*opentelemetry-javaagent\S*\.jar$/.test(arg));
        const dockerfile = /^ {6}dockerfile:\s*(\S+)\s*$/m.exec(block)?.[1];
        const image = dockerfile ? read(dockerfile) : null;
        const problems = [];
        if (!agent) problems.push('its command does not load -javaagent:/app/opentelemetry-javaagent.jar');
        if (image === null || !stripDockerComments(image).includes('opentelemetry-javaagent')) {
          problems.push(`its Dockerfile (${dockerfile ?? 'none named'}) does not put opentelemetry-javaagent.jar in the image`);
        }
        for (const v of ['OTEL_JAVAAGENT_ENABLED', 'OTEL_EXPORTER_OTLP_ENDPOINT']) {
          if (!new RegExp(`^ {6}${v}:`, 'm').test(block)) problems.push(`its environment does not set ${v}`);
        }
        if (problems.length > 0) {
          failures.push({
            service: name,
            file: composeName,
            fix: `starts no tracing: ${problems.join('; ')}. See the svc-fix block and services/svc-fix/Dockerfile`,
          });
        }
      }
    }
  }
  return failures;
}

function stripDockerComments(text) {
  return text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}

function main() {
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
  const composeFiles = readdirSync(root)
    .filter((f) => /^docker-compose.*\.ya?ml$/.test(f))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(root, name), 'utf8') }));
  const read = (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : null);
  const checked = composeFiles
    .flatMap((c) => composeServices(c.text))
    .filter((s) => {
      const cmd = commandOf(s.block);
      return cmd && (cmd[0] === 'java' || (cmd[0] === 'node' && cmd.some((a) => a.startsWith('services/svc-'))));
    });
  if (checked.length === 0) {
    console.error('service-tracing: found no service commands in the compose files; refusing to pass over nothing');
    process.exit(1);
  }
  const failures = untraced(composeFiles, read);
  for (const f of failures) console.error(`✗ ${f.service} (${f.file}): ${f.fix}`);
  if (failures.length > 0) process.exit(1);
  console.log(`service-tracing: ${checked.length} services start tracing`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
