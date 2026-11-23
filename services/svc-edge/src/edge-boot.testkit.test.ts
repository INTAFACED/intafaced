import { describe, expect, it } from 'vitest';
import { bootEdge, listeningOrigin, stopEdge } from './edge-boot.testkit.js';

/**
 * The boot kit every real-process test in this service uses.
 *
 * A port number freed by a probe and handed to the child can be taken by another test process first: the edge then
 * exits with EADDRINUSE before listening, or another server answers /health for ours. The kit hands the child port 0
 * and reads back the port the OS bound for it, so there is no number to lose.
 */

const ENV = {
  PATH: process.env.PATH ?? '',
  APP_ENV: 'test',
  NODE_ENV: 'test',
  SERVICE_NAME: 'svc-edge',
  OTEL_ENABLED: 'false',
  JWT_ACCESS_SECRET: 'test-only-signing-secret-at-least-32-characters-long',
  EDGE_PRINCIPAL_SECRET: 'test-only-edge-principal-secret-at-least-32-chars',
  EDGE_RATE_LIMIT_MAX: '300',
  EDGE_RATE_LIMIT_WINDOW_MS: '60000',
  EDGE_BODY_LIMIT_BYTES: '1048576',
  INTAFACED_SANCTIONS_REGIONS: 'AA:test-fixture-not-a-real-list',
  EDGE_KILL_STATE_PATH: '',
};

describe('listeningOrigin', () => {
  it("reads the origin from Fastify's own listening line", () => {
    const line = '{"level":30,"pid":1,"msg":"Server listening at http://127.0.0.1:39139"}\n';
    expect(listeningOrigin(line)).toBe('http://127.0.0.1:39139');
  });

  it('is null for the EADDRINUSE exit the old hand-off produced', () => {
    const exit = 'Error: listen EADDRINUSE: address already in use 127.0.0.1:44451\n';
    expect(listeningOrigin(exit)).toBeNull();
  });
});

describe('bootEdge', () => {
  it('never hands the child a port number of its own: the child binds port 0, even when the caller passes one', async () => {
    const edge = await bootEdge({ ...ENV, HTTP_PORT: '1', HTTP_HOST: '0.0.0.0', LOG_LEVEL: 'fatal' });
    try {
      // index.ts logs the HTTP_PORT it was given: 0, so no number chosen here can be taken before the child binds it.
      expect(edge.output()).toContain('"port":0');
      expect(edge.base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(edge.base).not.toBe('http://127.0.0.1:0');
    } finally {
      await stopEdge(edge.child);
    }
  }, 90_000);

  it('starts two edges at once on two ports, each answering only for itself', async () => {
    const [a, b] = await Promise.all([bootEdge(ENV), bootEdge(ENV)]);
    try {
      expect(a.base).not.toBe(b.base);
      expect((await fetch(`${a.base}/health`)).ok).toBe(true);
      expect((await fetch(`${b.base}/health`)).ok).toBe(true);
    } finally {
      await Promise.all([stopEdge(a.child), stopEdge(b.child)]);
    }
  }, 90_000);

  it('rejects, naming the exit, when the edge refuses to start', async () => {
    await expect(bootEdge({ ...ENV, JWT_ACCESS_SECRET: 'short' })).rejects.toThrow(/svc-edge exited with \d+ before listening/);
  }, 90_000);
});
