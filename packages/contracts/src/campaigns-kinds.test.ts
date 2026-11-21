import { describe, expect, it } from 'vitest';
import * as base from './campaigns-base.js';
import * as catalogue from './campaigns-catalogue.js';
import {
  CAMPAIGN_KIND_REFUSAL_CODES,
  CAMPAIGN_REFUSAL_CODES,
  campaignDefinitionInputSchema,
  campaignKindTerms,
  campaignSchema,
  campaignViewSchema,
  customerKindTerms,
} from './campaigns-catalogue.js';
import * as earning from './campaigns-earning.js';
import * as feeSaver from './campaigns-fee-saver.js';
import * as kinds from './campaigns-kinds.js';
import * as points from './campaigns-points.js';
import * as rewards from './campaigns-rewards.js';
import { RISK_REFUSAL_CODES } from './campaigns-risk.js';
import * as rules from './campaigns-rules.js';
import * as tasks from './campaigns-tasks.js';
import * as vouchers from './campaigns-vouchers.js';

/** The modules campaigns-catalogue.ts re-exports: what it mounts from them is not its own declaration. */
const REEXPORTED = new Set([base, earning, feeSaver, kinds, points, rewards, rules, tasks, vouchers].flatMap((m) => Object.keys(m)));
const FIX =
  'a campaign kind goes in a file of its own, src/campaigns-<kind>.ts (its terms schema, its <KIND>_REFUSAL_CODES and its reads), ' +
  'and one line each in src/campaigns-kinds.ts; never in campaigns-catalogue.ts';

/** What campaigns-catalogue.ts itself declares: the campaign object, its catalogue, its definition and its gate. */
const CATALOGUE_OWN = [
  'CAMPAIGN_REFUSAL_CODES',
  'CampaignRefusalCode',
  'campaignSchema',
  'Campaign',
  'campaignEligibilitySchema',
  'CampaignEligibility',
  'campaignReviewResultSchema',
  'CampaignReviewResult',
  'participationSchema',
  'Participation',
  'campaignViewSchema',
  'CampaignView',
  'campaignTypeViewSchema',
  'campaignCatalogueSchema',
  'CampaignCatalogue',
  'campaignGetInputSchema',
  'campaignJoinInputSchema',
  'campaignReviewInputSchema',
  'campaignJoinResultSchema',
  'CampaignJoinResult',
  'myCampaignSchema',
  'myCampaignsSchema',
  'MyCampaigns',
  'campaignDefinitionInputSchema',
  'CampaignDefinitionInput',
  'campaignChangeSchema',
  'CampaignChange',
  'campaignUpdateInputSchema',
  'campaignTransitionInputSchema',
  'campaignGateSchema',
  'CampaignGate',
  'campaignCalendarSchema',
  'CampaignCalendar',
];
/** The refusal codes written in campaigns-catalogue.ts itself; every later one comes from its kind's file. */
const CATALOGUE_OWN_CODE_COUNT = 81;

describe('campaign kinds live in files of their own (project-state #2654)', () => {
  it('campaigns-catalogue.ts declares only the campaign object and its catalogue', () => {
    const declared = Object.keys(catalogue).filter((name) => !REEXPORTED.has(name));
    expect(declared, 'the catalogue declares its own campaign object').toContain('campaignSchema');
    expect(
      declared.filter((name) => !CATALOGUE_OWN.includes(name)),
      FIX,
    ).toEqual([]);
  });

  it('campaigns-catalogue.ts writes no new refusal code of its own', () => {
    const mounted = new Set<string>([...RISK_REFUSAL_CODES, ...CAMPAIGN_KIND_REFUSAL_CODES]);
    expect(CAMPAIGN_REFUSAL_CODES.filter((code) => !mounted.has(code)).length, FIX).toBe(CATALOGUE_OWN_CODE_COUNT);
  });

  it('every kind reaches the stored campaign, the definition and the refusal codes', () => {
    for (const field of Object.keys(campaignKindTerms)) {
      expect(campaignSchema.shape, field).toHaveProperty(field);
      expect(campaignDefinitionInputSchema.shape, field).toHaveProperty(field);
    }
    for (const field of Object.keys(customerKindTerms)) expect(campaignViewSchema.shape, field).toHaveProperty(field);
    expect(campaignViewSchema.shape).not.toHaveProperty('referral');
    for (const code of CAMPAIGN_KIND_REFUSAL_CODES) expect(CAMPAIGN_REFUSAL_CODES).toContain(code);
    expect(new Set(CAMPAIGN_REFUSAL_CODES).size).toBe(CAMPAIGN_REFUSAL_CODES.length);
  });
});
