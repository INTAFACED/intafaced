import { describe, expect, it } from 'vitest';
import { supportSurveyCapEnv } from './survey-cap-env.js';
import { MemorySurveyBook } from './survey-settings.js';

/** SP-csat-02 — SUPPORT_SURVEY_CAP is the owner's survey cap: blank stays unset, a positive integer reaches list().cap. */
const capFrom = (raw: string | undefined) => supportSurveyCapEnv.parse(raw);

describe('SUPPORT_SURVEY_CAP', () => {
  it('blank or absent reads unset; a positive integer reaches list().cap; zero and junk are refused', async () => {
    for (const raw of ['', undefined]) {
      expect((await new MemorySurveyBook(undefined, capFrom(raw) ?? null).list()).cap).toEqual({
        status: 'unset',
        code: 'support.survey_cap_unset',
      });
    }
    expect((await new MemorySurveyBook(undefined, capFrom('3') ?? null).list()).cap).toEqual({ status: 'set', cap: 3 });
    expect(() => capFrom('0')).toThrow();
    expect(() => capFrom('two')).toThrow();
  });
});
