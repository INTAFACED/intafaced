/**
 * LOCAL TEST promotion door: `POST /internal/local-test/promotion`, service-signed, mounted only on a test stack.
 *
 * No promotion producer exists yet, so the local stack's gates tool (`local-test-gates.mjs notify-promotion <handle>`)
 * files one TEST promotion for one account through here, and it then takes the same path every notification takes:
 * `NotifyService.create`, the inbox row and the dispatcher, with the category and channel choices applied at send
 * time. It is mounted only when NOTIFY_LOCAL_TEST_PROMOTIONS is `on`, and that refuses at boot unless the raw APP_ENV is
 * exactly dev or test. Edge never routes `/internal/*`.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { verifyServiceRequest, type ServiceAuthMode, type ServiceVerifier } from '@intafaced/contracts';
import type { NotifyService } from './notify-service.js';

export const LOCAL_TEST_PROMOTION_PATH = '/internal/local-test/promotion';
export const LOCAL_TEST_PROMOTION_KIND = 'promo.test';
export const LOCAL_TEST_PROMOTION_SUBJECT = 'local-test.notify.promotion';
export const LOCAL_TEST_PROMOTION_REFUSED = 'notify.local_test_promotion_refused';

const body = z
  .object({
    userId: z.string().guid(),
    /** Business key for this one promotion: a replay files nothing new. */
    key: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_.:-]+$/),
  })
  .strict();

/** Whether to mount the door. Throws for `on` outside APP_ENV exactly dev or test. */
export function localTestPromotionsEnabled(input: { flag: string | undefined; appEnv: string | undefined }): boolean {
  if (input.flag !== 'on') return false;
  if (input.appEnv !== 'dev' && input.appEnv !== 'test')
    throw new Error(`${LOCAL_TEST_PROMOTION_REFUSED}: allowed only when APP_ENV is exactly dev or test`);
  return true;
}

export function registerLocalTestPromotionDoor(
  app: FastifyInstance,
  deps: {
    readonly notify: Pick<NotifyService, 'create'>;
    readonly legacySecret: string | undefined;
    readonly s2s?: { readonly verifier: ServiceVerifier; readonly mode: ServiceAuthMode } | undefined;
  },
): void {
  app.post(LOCAL_TEST_PROMOTION_PATH, async (req, reply) => {
    const auth = verifyServiceRequest(req, {
      verifier: deps.s2s?.verifier,
      mode: deps.s2s?.mode,
      legacySecret: deps.legacySecret,
      bodyBindMode: 'require',
    });
    if (auth.service === null) return reply.code(401).send({ code: 'notify.unauthenticated' });
    const parsed = body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: 'notify.local_test_promotion_invalid' });
    const created = await deps.notify.create({
      userId: parsed.data.userId,
      kind: LOCAL_TEST_PROMOTION_KIND,
      titleKey: 'notify.promo.test.title',
      bodyKey: 'notify.promo.test.body',
      params: { label: 'TEST' },
      href: null,
      severity: 'info',
      sourceSubject: LOCAL_TEST_PROMOTION_SUBJECT,
      sourceIdempotencyKey: parsed.data.key,
    });
    return {
      inserted: created.inserted,
      notificationId: created.notification?.id ?? null,
      outcomes: (created.dispatch?.outcomes ?? []).map((o) => ({ channel: o.channel, status: o.status, code: o.code })),
    };
  });
}
