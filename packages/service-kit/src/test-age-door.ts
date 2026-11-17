/**
 * The TEST age door's route (test-age.ts), one for every service that mounts it, so its guard is written once.
 *
 * Always mounted: closed, it answers `test_age.door_closed`. Body-bound service auth, always: a replayed or edited body
 * is refused. svc-edge's own key is refused too: the edge signs every request it forwards, so a call it signed is a
 * customer's, never the stack's. With no shared secret and no keys, no caller is ever verified and every call is 401.
 *
 * Typed by shape, as `retainRawBody` is, so this package needs no web framework: a Fastify app fits.
 */
import {
  retainRawBody,
  verifyServiceRequest,
  type HttpServiceRequest,
  type RawBodyHost,
  type ServiceAuthMode,
  type ServiceVerifier,
} from '@intafaced/contracts';
import { answerTestAgeDoor, type TestAgeSubject } from './test-age.js';

export const TEST_AGE_PATH = '/internal/test/age' as const;

export interface TestAgeDoorRequest extends HttpServiceRequest {
  readonly log: { warn(fields: object, message: string): void };
}

export interface TestAgeDoorReply {
  code(status: number): { send(body: unknown): unknown };
}

export interface TestAgeDoorHost extends RawBodyHost {
  post(path: string, handler: (req: TestAgeDoorRequest, reply: TestAgeDoorReply) => Promise<unknown>): unknown;
}

export interface TestAgeDoorDeps {
  readonly open: boolean;
  readonly internalSecret: string | undefined;
  /** Per-service keys (S2S v3). Unset: the shared secret alone. */
  readonly s2s?: { readonly verifier: ServiceVerifier; readonly mode: ServiceAuthMode } | undefined;
  readonly subjects: Readonly<Record<string, TestAgeSubject>>;
  /** False when the service already called `retainRawBody`; the door needs the raw body to check its signature. */
  readonly installRawBody?: boolean;
}

export function registerTestAgeDoor(app: TestAgeDoorHost, deps: TestAgeDoorDeps): void {
  if (deps.installRawBody !== false) retainRawBody(app);
  app.post(TEST_AGE_PATH, async (req, reply) => {
    const auth = verifyServiceRequest(req, {
      verifier: deps.s2s?.verifier,
      mode: deps.s2s?.mode,
      legacySecret: deps.internalSecret,
      bodyBindMode: 'require',
    });
    if (auth.service === null || auth.service === 'svc-edge') {
      return reply.code(401).send({ error: 'test_age.unauthenticated', message: 'the TEST age door answers a signed service call only' });
    }
    const answer = await answerTestAgeDoor(deps.open, deps.subjects, req.body);
    if (answer.status === 200) req.log.warn({ ...answer.body, caller: auth.service }, 'TEST record aged');
    return reply.code(answer.status).send(answer.body);
  });
}
