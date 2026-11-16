/**
 * The TEST age door: on a TEST stack it makes one of a service's own records older, as if it had been made `ms`
 * earlier, so a journey sees that record's expiry or window pass without waiting the time out.
 *
 * It moves no clock. Every service keeps reading the real time; only the one record's own times move back, all by the
 * same amount, so their order and the gaps between them stay as they were. With the door closed (the default) nothing
 * in the service changes: the route still answers, with the typed refusal `test_age.door_closed`.
 *
 * A service opens it with `TEST_AGE_DOOR=on`, and refuses to start with that anywhere but `APP_ENV` exactly `dev` or
 * `test`, or under `NODE_ENV=production`. Each service names the records it may age (its `subjects`) and mounts
 * `answerTestAgeDoor` behind its signed service auth.
 */
import { z } from 'zod';

export const TEST_AGE_DOOR_ENV = 'TEST_AGE_DOOR';
/** One call ages a record by at most a day: past every TEST expiry and window a journey waits on today. */
export const TEST_AGE_MAX_MS = 86_400_000;

export type TestAgeRefusalCode = 'test_age.door_closed' | 'test_age.invalid' | 'test_age.not_found';

const STATUS: Record<TestAgeRefusalCode, number> = {
  'test_age.door_closed': 403,
  'test_age.invalid': 400,
  'test_age.not_found': 404,
};

/** `TEST_AGE_DOOR` set to something the service must not start with. */
export class TestAgeDoorBootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestAgeDoorBootError';
  }
}

/**
 * Whether this process opens the door. Unset, blank or `off`: closed. `on`: open, only with `APP_ENV` exactly `dev` or
 * `test` and `NODE_ENV` not `production`; otherwise the service refuses to start. Any other value refuses to start.
 */
export function testAgeDoorOpen(env: Readonly<Record<string, string | undefined>>): boolean {
  const raw = env[TEST_AGE_DOOR_ENV]?.trim().toLowerCase() ?? '';
  if (raw === '' || raw === 'off') return false;
  if (raw !== 'on') throw new TestAgeDoorBootError(`${TEST_AGE_DOOR_ENV} must be unset, off or on`);
  if ((env.APP_ENV !== 'dev' && env.APP_ENV !== 'test') || env.NODE_ENV === 'production') {
    throw new TestAgeDoorBootError(
      `${TEST_AGE_DOOR_ENV}=on is a TEST stack's door and is refused unless APP_ENV is exactly dev or test and NODE_ENV is not production (got APP_ENV ${JSON.stringify(env.APP_ENV ?? null)}, NODE_ENV ${JSON.stringify(env.NODE_ENV ?? null)})`,
    );
  }
  return true;
}

/** One record kind a service may age: moves that record's own times back `ms`, and returns them, or null when there is none. */
export type TestAgeSubject = (id: string, ms: number) => Promise<Readonly<Record<string, string | null>> | null>;

export interface TestAgeAnswer {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

const refusal = (code: TestAgeRefusalCode, message: string): TestAgeAnswer => ({ status: STATUS[code], body: { error: code, message } });

/**
 * The door's answer to one authenticated call. Closed: `test_age.door_closed`, whatever the body. Open: the body names a
 * subject this service ages, a record id and whole milliseconds from 1 to a day; that record's times move back once.
 */
export async function answerTestAgeDoor(
  open: boolean,
  subjects: Readonly<Record<string, TestAgeSubject>>,
  body: unknown,
): Promise<TestAgeAnswer> {
  if (!open) return refusal('test_age.door_closed', `the TEST age door is closed: ${TEST_AGE_DOOR_ENV} is not on, so no record is aged`);
  const parsed = z
    .object({ subject: z.string(), id: z.string().trim().min(1).max(200), ms: z.number().int().min(1).max(TEST_AGE_MAX_MS) })
    .strict()
    .safeParse(body);
  if (!parsed.success) return refusal('test_age.invalid', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const { subject, id, ms } = parsed.data;
  const age = Object.hasOwn(subjects, subject) ? subjects[subject] : undefined;
  if (!age) return refusal('test_age.invalid', `subject must be one of ${Object.keys(subjects).join(', ')}`);
  const aged = await age(id, ms);
  if (aged === null) return refusal('test_age.not_found', `no ${subject} ${id} this door may age`);
  return { status: 200, body: { ok: true, subject, id, agedMs: ms, ...aged } };
}
