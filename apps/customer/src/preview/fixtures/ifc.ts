import { definePreviewFixture } from './types';

/**
 * SAMPLE data for the IFC Preview. Invented amounts, tiers and proposals; never mixed with real data. IFC has no market price
 * and no live supply, so nothing here is a price, a yield or a buyback. Any reward figure is a labelled sample and NOT a promise
 * (COPY-OPTIONS-v2 claims register C1 to C4). Amounts are decimal STRINGS. See ../README.md.
 */

export type ProposalStatus = 'voting' | 'passed' | 'rejected' | 'draft';

export interface IfcStakeOption {
  readonly id: string;
  readonly label: string;
  readonly lock: string;
  readonly detail: string;
  /** SAMPLE reward in IFC for every 1,000 IFC staked for one month (decimal string). Not a promise. */
  readonly sampleRewardPer1000: string;
}
export interface IfcTier {
  readonly id: string;
  readonly label: string;
  /** IFC to hold (balance plus staked) to reach the tier (decimal string). */
  readonly hold: string;
  /** Percent off trading fees, a whole-number decimal string such as "20". */
  readonly discountPct: string;
}
export interface IfcProposal {
  readonly id: string;
  readonly number: string;
  readonly title: string;
  readonly summary: string;
  readonly status: ProposalStatus;
  /** Relative time, so no time zone is involved. */
  readonly timing: string;
  /** Whole-number percent strings; both null while a proposal is still a draft. */
  readonly forPct: string | null;
  readonly againstPct: string | null;
  readonly yourVote: 'for' | 'against' | null;
}
export interface IfcActivity {
  readonly id: string;
  readonly label: string;
  readonly when: string;
  /** Signed decimal string in IFC. */
  readonly amount: string;
}
export interface IfcFixtureRows {
  readonly balance: { readonly available: string; readonly staked: string; readonly pendingRewards: string };
  readonly stakeOptions: readonly IfcStakeOption[];
  readonly tiers: readonly IfcTier[];
  readonly proposals: readonly IfcProposal[];
  readonly uses: readonly { readonly id: string; readonly title: string; readonly detail: string }[];
  readonly activity: readonly IfcActivity[];
  readonly notPromises: readonly string[];
  readonly mining: { readonly title: string; readonly detail: string };
}

export const ifcFixture = definePreviewFixture<IfcFixtureRows>('ifc', 'IFC: sample balance, staking, fee tiers and votes.', {
  balance: { available: '8230.50', staked: '4250.00', pendingRewards: '12.40' },
  stakeOptions: [
    { id: 'flex', label: 'Flexible', lock: 'No lock', detail: 'Unstake any time.', sampleRewardPer1000: '0.60' },
    { id: 'd30', label: '30 days', lock: 'Locked 30 days', detail: 'Funds stay locked until the end.', sampleRewardPer1000: '1.10' },
    { id: 'd90', label: '90 days', lock: 'Locked 90 days', detail: 'Funds stay locked until the end.', sampleRewardPer1000: '1.80' },
  ],
  tiers: [
    { id: 't0', label: 'No tier', hold: '0', discountPct: '0' },
    { id: 't1', label: 'Tier 1', hold: '100', discountPct: '5' },
    { id: 't2', label: 'Tier 2', hold: '1000', discountPct: '10' },
    { id: 't3', label: 'Tier 3', hold: '10000', discountPct: '20' },
    { id: 't4', label: 'Tier 4', hold: '100000', discountPct: '30' },
  ],
  proposals: [
    {
      id: 'p14',
      number: 'Proposal 14',
      title: 'Add a Tier 4 fee discount',
      summary: 'Create a fourth tier for people who hold 100,000 IFC or more.',
      status: 'voting',
      timing: 'Ends in 3 days',
      forPct: '72',
      againstPct: '28',
      yourVote: null,
    },
    {
      id: 'p13',
      number: 'Proposal 13',
      title: 'Lower the P2P merchant badge threshold',
      summary: 'Let merchants with a shorter record apply for the Verified merchant badge.',
      status: 'voting',
      timing: 'Ends in 6 days',
      forPct: '41',
      againstPct: '59',
      yourVote: 'against',
    },
    {
      id: 'p12',
      number: 'Proposal 12',
      title: 'Open the Academy lobby host role to Tier 2',
      summary: 'Anyone holding Tier 2 and a certificate could host a live lobby.',
      status: 'passed',
      timing: 'Closed 2 weeks ago',
      forPct: '81',
      againstPct: '19',
      yourVote: 'for',
    },
    {
      id: 'p11',
      number: 'Proposal 11',
      title: 'Pause new staking options for 30 days',
      summary: 'Hold the current staking options steady while the terms are reviewed.',
      status: 'rejected',
      timing: 'Closed 5 weeks ago',
      forPct: '23',
      againstPct: '77',
      yourVote: null,
    },
    {
      id: 'p15',
      number: 'Proposal 15',
      title: 'Publish a quarterly report',
      summary: 'A plain-language report on how fee discounts were used.',
      status: 'draft',
      timing: 'Opens for votes soon',
      forPct: null,
      againstPct: null,
      yourVote: null,
    },
  ],
  uses: [
    { id: 'fees', title: 'Fee discounts', detail: 'Hold IFC to pay less on trading fees.' },
    { id: 'votes', title: 'Votes', detail: 'Staked IFC counts as your say on proposals.' },
    { id: 'rewards', title: 'Rewards', detail: 'Card cashback and lobby prizes could be paid in IFC.' },
  ],
  activity: [
    { id: 'a1', label: 'Staked, flexible', when: '3 weeks ago', amount: '4250.00' },
    { id: 'a2', label: 'Reward paid', when: '2 weeks ago', amount: '2.55' },
    { id: 'a3', label: 'Card cashback', when: '4 days ago', amount: '6.27' },
    { id: 'a4', label: 'Lobby prize', when: '2 days ago', amount: '25.00' },
  ],
  notPromises: [
    'The reward figures on this page are samples. They are not a promise of any return.',
    'Nothing here says IFC will keep or gain value. IFC has no market price yet.',
    'Any buyback in the founders’ plan is not a promise and is not part of this screen.',
  ],
  mining: {
    title: 'Mining',
    detail: 'In build. There is nothing to run or buy yet, and no details to share.',
  },
});
