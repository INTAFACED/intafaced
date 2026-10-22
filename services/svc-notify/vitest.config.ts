import { defineConfig } from 'vitest/config';

// Business fixtures isolate the blank screening socket. Mounted-request tests
// explicitly arm strict policy; production defaults remain unchanged.
//
// One file at a time: every *.pg.test.ts replays all drizzle migrations on the
// shared test database in its beforeAll. Replaying 0011/0013/0015 puts back an
// older notify.notice_published_immutable() (and 0018-0020 an older
// price_alerts_status_ck) until the replay reaches the newest file, so a
// parallel file's "frozen once published" or alert-status check runs against
// the older rule and goes red at random. Same remedy as svc-p2p and svc-token.
export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      APP_ENV: 'test',
      INTAFACED_SCREENING_FAIL_CLOSED: 'off',
    },
  },
});
