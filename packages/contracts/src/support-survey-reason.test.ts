import { describe, expect, it } from 'vitest';
import { SUPPORT_SURVEY_REASON_MAX, supportSurveyConfigureInputSchema } from './support-survey.js';

const config = {
  scale: { min: 1, max: 5, labels: [] },
  followUp: null,
  sendAfterMinutes: 30,
  channels: ['in_app'],
  requestTypes: ['question'],
};
const input = { surveyId: null, expectedRevision: 0, config, reason: 'Owner set the survey' };

describe('survey configure reason (SP-csat-02)', () => {
  it('refuses a blank reason and a reason past the bound', () => {
    expect(supportSurveyConfigureInputSchema.safeParse({ ...input, reason: '   ' }).success).toBe(false);
    expect(supportSurveyConfigureInputSchema.safeParse({ ...input, reason: 'x'.repeat(SUPPORT_SURVEY_REASON_MAX + 1) }).success).toBe(
      false,
    );
    expect(supportSurveyConfigureInputSchema.safeParse({ ...input, reason: 'x'.repeat(SUPPORT_SURVEY_REASON_MAX) }).success).toBe(true);
  });
});
