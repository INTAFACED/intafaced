import { describe, expect, it } from 'vitest';
import {
  SUPPORT_SURVEY_CAP_REACHED,
  SUPPORT_SURVEY_CAP_UNSET,
  supportSurveyConfigureInputSchema,
  supportSurveyErrorCodeSchema,
  supportSurveyListSchema,
  supportSurveyScaleSchema,
} from './support-survey.js';

const uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const config = {
  scale: { min: 1, max: 5, labels: [] },
  followUp: { question: 'What went wrong?', askAtOrBelow: 2 },
  sendAfterMinutes: 60,
  channels: ['in_app'],
  requestTypes: ['question', 'problem'],
};
const input = { surveyId: null, expectedRevision: 0, config, reason: 'Owner set the survey' };

describe('survey configuration (SP-csat-02)', () => {
  it('declares the new codes', () => {
    expect(supportSurveyErrorCodeSchema.options).toEqual([
      'support.survey_cap_unset',
      'support.survey_cap_reached',
      'support.survey_scale_invalid',
    ]);
  });
  it('names the cap-reached refusal beside cap-unset', () => {
    expect(SUPPORT_SURVEY_CAP_REACHED).toBe('support.survey_cap_reached');
    expect(supportSurveyErrorCodeSchema.safeParse(SUPPORT_SURVEY_CAP_REACHED).success).toBe(true);
  });
  it('accepts a complete configuration', () => {
    expect(supportSurveyConfigureInputSchema.parse(input)).toEqual(input);
  });
  it('refuses a bad scale with support.survey_scale_invalid', () => {
    for (const scale of [
      { min: 5, max: 5, labels: [] },
      { min: 1, max: 5, labels: ['a', 'b'] },
    ]) {
      const r = supportSurveyScaleSchema.safeParse(scale);
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues[0]?.message).toBe('support.survey_scale_invalid');
    }
    expect(supportSurveyScaleSchema.safeParse({ min: 1, max: 3, labels: ['bad', 'ok', 'good'] }).success).toBe(true);
  });
  it('refuses a follow-up threshold outside the scale', () => {
    expect(
      supportSurveyConfigureInputSchema.safeParse({ ...input, config: { ...config, followUp: { question: 'q', askAtOrBelow: 9 } } })
        .success,
    ).toBe(false);
  });
  it('refuses blank timing, no channel, duplicate channels, unknown request type and missing revision', () => {
    for (const change of [
      { sendAfterMinutes: undefined },
      { channels: [] },
      { channels: ['email', 'email'] },
      { requestTypes: ['refund'] },
      { requestTypes: [] },
    ])
      expect(supportSurveyConfigureInputSchema.safeParse({ ...input, config: { ...config, ...change } }).success).toBe(false);
    const { expectedRevision: _r, ...noRev } = input;
    expect(supportSurveyConfigureInputSchema.safeParse(noRev).success).toBe(false);
  });
  it('cap is unset with its code or a positive count; only one active survey', () => {
    const survey = { surveyId: uuid, revision: 1, active: true, config, updatedAt: '2026-10-22T00:00:00Z' };
    expect(supportSurveyListSchema.safeParse({ cap: { status: 'unset', code: SUPPORT_SURVEY_CAP_UNSET }, surveys: [] }).success).toBe(true);
    expect(supportSurveyListSchema.safeParse({ cap: { status: 'unset' }, surveys: [] }).success).toBe(false);
    expect(supportSurveyListSchema.safeParse({ cap: { status: 'set', cap: 0 }, surveys: [] }).success).toBe(false);
    expect(
      supportSurveyListSchema.safeParse({
        cap: { status: 'set', cap: 2 },
        surveys: [survey, { ...survey, surveyId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }],
      }).success,
    ).toBe(false);
  });
});
