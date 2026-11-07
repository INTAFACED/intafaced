import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { retainRawBody, serviceAuthHeadersForBody } from '@intafaced/contracts';
import { categoryFromKind } from './preferences/categories.js';
import type { CreateNotificationInput, CreateResult } from './notify-service.js';
import {
  LOCAL_TEST_PROMOTION_KIND,
  LOCAL_TEST_PROMOTION_PATH,
  localTestPromotionsEnabled,
  registerLocalTestPromotionDoor,
} from './local-test-promotion.js';

const SECRET = 's'.repeat(40);
const USER = '88888888-8888-4888-8888-888888888888';

describe('the LOCAL TEST promotion door', () => {
  const created: CreateNotificationInput[] = [];
  const app = Fastify({ logger: false });

  beforeAll(async () => {
    retainRawBody(app);
    registerLocalTestPromotionDoor(app, {
      notify: {
        async create(input: CreateNotificationInput): Promise<CreateResult> {
          created.push(input);
          return { inserted: true, notification: { id: 'n-1' } as CreateResult['notification'], dispatch: null };
        },
      },
      legacySecret: SECRET,
    });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const post = (payload: unknown, secret: string | null = SECRET) => {
    const raw = JSON.stringify(payload);
    return app.inject({
      method: 'POST',
      url: LOCAL_TEST_PROMOTION_PATH,
      payload: raw,
      headers: { 'content-type': 'application/json', ...(secret ? serviceAuthHeadersForBody('local-test-stack', secret, raw) : {}) },
    });
  };

  it('is mounted only for `on`, and `on` refuses outside APP_ENV exactly dev or test', () => {
    expect(localTestPromotionsEnabled({ flag: undefined, appEnv: 'prod' })).toBe(false);
    expect(localTestPromotionsEnabled({ flag: 'on', appEnv: 'dev' })).toBe(true);
    expect(localTestPromotionsEnabled({ flag: 'on', appEnv: 'test' })).toBe(true);
    for (const appEnv of [undefined, '', 'staging', 'prod'])
      expect(() => localTestPromotionsEnabled({ flag: 'on', appEnv }), String(appEnv)).toThrow(/notify.local_test_promotion_refused/);
  });

  it('refuses an unsigned or wrongly signed call and files nothing', async () => {
    expect((await post({ userId: USER, key: 'local-test:promotion:a:1' }, null)).statusCode).toBe(401);
    expect((await post({ userId: USER, key: 'local-test:promotion:a:1' }, 'w'.repeat(40))).statusCode).toBe(401);
    expect(created).toEqual([]);
  });

  it('refuses a body off its shape', async () => {
    expect((await post({ userId: 'not-a-uuid', key: 'k' })).statusCode).toBe(400);
    expect((await post({ userId: USER, key: 'k', title: 'free text' })).statusCode).toBe(400);
    expect(created).toEqual([]);
  });

  it('files one TEST promotion through NotifyService.create, in the promotions category, with the out-of-app fan-out', async () => {
    const res = await post({ userId: USER, key: 'local-test:promotion:a:2' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ inserted: true, notificationId: 'n-1' });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      userId: USER,
      kind: LOCAL_TEST_PROMOTION_KIND,
      severity: 'info',
      sourceIdempotencyKey: 'local-test:promotion:a:2',
    });
    expect(created[0]!.outOfApp).toBeUndefined();
    expect(categoryFromKind(created[0]!.kind)).toBe('promotions');
  });
});
