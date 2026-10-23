import { describe, expect, it } from 'vitest';
import { SUPPORT_SURVEY_ID_CONFLICT, supportSurveyConfigureInputSchema } from './support-survey.js';

/** SP-csat-02 r2 #1: a create may carry the client-chosen survey id; an edit may not. */
const config = {
  scale: { min: 1, max: 5, labels: [] },
  followUp: null,
  sendAfterMinutes: 30,
  channels: ['in_app'],
  requestTypes: ['question'],
};
const NEW_ID = '44444444-4444-4444-8444-444444444444';

describe('survey configure newSurveyId (SP-csat-02)', () => {
  it('accepts a uuid on a create and keeps it', () => {
    const input = { surveyId: null, newSurveyId: NEW_ID, expectedRevision: 0, config, reason: 'Owner set it' };
    expect(supportSurveyConfigureInputSchema.parse(input)).toEqual(input);
  });
  it('refuses it on an edit, on a nonzero revision, and when it is not a uuid', () => {
    const base = { surveyId: null, expectedRevision: 0, config, reason: 'r' };
    expect(supportSurveyConfigureInputSchema.safeParse({ ...base, surveyId: NEW_ID, newSurveyId: NEW_ID }).success).toBe(false);
    expect(supportSurveyConfigureInputSchema.safeParse({ ...base, expectedRevision: 1, newSurveyId: NEW_ID }).success).toBe(false);
    expect(supportSurveyConfigureInputSchema.safeParse({ ...base, newSurveyId: 'nope' }).success).toBe(false);
  });
  it('names the conflict code', () => {
    expect(SUPPORT_SURVEY_ID_CONFLICT).toBe('support.survey_id_conflict');
  });
});
