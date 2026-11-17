import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandOf, composeServices, untraced } from './service-tracing.mjs';

const TRACED_NODE = `import { registerProcessHooks, startTelemetry } from '@intafaced/telemetry';
registerProcessHooks(startTelemetry({ serviceName: 'svc-tax', endpoint: 'http://x', enabled: true }));
`;

// svc-mining-pool's entry as it was: a server that never starts a tracer.
const MINING_POOL_BEFORE = `import { createServer } from 'node:http';
import { s2sFromEnv } from '@intafaced/contracts';
const server = createServer(() => {});
server.listen(4023);
`;

const AGENT_DOCKERFILE = `FROM eclipse-temurin:21-jre-jammy
COPY --from=build /opt/otel/opentelemetry-javaagent.jar /app/opentelemetry-javaagent.jar
`;

function compose(services) {
  return `x-app: &app\n  image: x\n\nservices:\n${services}\nvolumes:\n  pg: {}\n`;
}

const nodeBlock = (svc, file) =>
  `  ${svc}:\n    <<: *app\n    command: ['node', 'services/${svc}/dist/${file}.js']\n    environment:\n      SERVICE_NAME: ${svc}\n`;

const javaBlock = ({ agent = true, env = true } = {}) =>
  `  svc-fix:\n    build:\n      context: .\n      dockerfile: services/svc-fix/Dockerfile\n` +
  `    command: ['java', ${agent ? "'-javaagent:/app/opentelemetry-javaagent.jar', " : ''}'-cp', '/app/svc-fix.jar', 'io.intafaced.fix.FixAcceptorMain']\n` +
  `    environment:\n      SERVICE_NAME: svc-fix\n` +
  (env ? `      OTEL_JAVAAGENT_ENABLED: \${OTEL_ENABLED:-true}\n      OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4318\n` : '');

function run(services, files) {
  return untraced([{ name: 'docker-compose.apps.yml', text: compose(services) }], (p) => files[p] ?? null);
}

test('reads the top-level services and stops at the next top-level key', () => {
  const names = composeServices(compose(nodeBlock('svc-tax', 'index') + nodeBlock('svc-ws', 'index'))).map((s) => s.name);
  assert.deepEqual(names, ['svc-tax', 'svc-ws']);
});

test('passes a Node service whose compose entry starts the tracer', () => {
  assert.deepEqual(run(nodeBlock('svc-tax', 'index'), { 'services/svc-tax/src/index.ts': TRACED_NODE }), []);
});

test('fails svc-mining-pool as it was: the entry compose runs (server.ts, not index.ts) starts no tracer', () => {
  const failures = run(nodeBlock('svc-mining-pool', 'server'), {
    'services/svc-mining-pool/src/index.ts': TRACED_NODE,
    'services/svc-mining-pool/src/server.ts': MINING_POOL_BEFORE,
  });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].file, 'services/svc-mining-pool/src/server.ts');
  assert.match(failures[0].fix, /startTelemetry\(, registerProcessHooks\(/);
  assert.match(failures[0].fix, /services\/svc-tax\/src\/index\.ts/);
});

test('a commented-out call is not a call', () => {
  const commented = `import { registerProcessHooks, startTelemetry } from '@intafaced/telemetry';\n// registerProcessHooks(startTelemetry({}));\n/* startTelemetry( */\n`;
  const failures = run(nodeBlock('svc-ws', 'index'), { 'services/svc-ws/src/index.ts': commented });
  assert.equal(failures.length, 1);
});

test('a compose entry with no source file fails by name', () => {
  const failures = run(nodeBlock('svc-ghost', 'index'), {});
  assert.equal(failures.length, 1);
  assert.match(failures[0].fix, /does not exist/);
});

test('passes the Java gateway with the agent, its jar in the image and its env', () => {
  assert.deepEqual(run(javaBlock(), { 'services/svc-fix/Dockerfile': AGENT_DOCKERFILE }), []);
});

test('fails svc-fix as it was: a plain java command, no agent in the image, no OTEL env', () => {
  const failures = run(javaBlock({ agent: false, env: false }), { 'services/svc-fix/Dockerfile': 'FROM eclipse-temurin:21-jre-jammy\n' });
  assert.equal(failures.length, 1);
  assert.match(failures[0].fix, /-javaagent/);
  assert.match(failures[0].fix, /Dockerfile/);
  assert.match(failures[0].fix, /OTEL_JAVAAGENT_ENABLED/);
  assert.match(failures[0].fix, /OTEL_EXPORTER_OTLP_ENDPOINT/);
});

test('an agent jar named only in a Dockerfile comment does not count', () => {
  const failures = run(javaBlock(), { 'services/svc-fix/Dockerfile': '# add opentelemetry-javaagent.jar later\nFROM x\n' });
  assert.equal(failures.length, 1);
});

test('ignores commands that are not a service entry', () => {
  const migrate = `  migrate-all:\n    <<: *app\n    command: ['node', 'tooling/scripts/migrate-all.mjs']\n`;
  assert.deepEqual(run(migrate, {}), []);
});

test('reads a command wrapped over several lines, as prettier writes a long one', () => {
  const wrapped = `    command:\n      [\n        'java',\n        '-cp',\n        '/app/svc-fix.jar',\n      ]\n    environment:\n`;
  assert.deepEqual(commandOf(wrapped), ['java', '-cp', '/app/svc-fix.jar']);
  const listed = `    command:\n      - node\n      - 'services/svc-ws/dist/index.js'\n    environment:\n`;
  assert.deepEqual(commandOf(listed), ['node', 'services/svc-ws/dist/index.js']);
  const block = `  svc-fix:\n    build:\n      dockerfile: services/svc-fix/Dockerfile\n${wrapped}`;
  const failures = untraced([{ name: 'c.yml', text: compose(block) }], () => 'FROM x\n');
  assert.equal(failures.length, 1, 'a wrapped java command without the agent still fails');
});
