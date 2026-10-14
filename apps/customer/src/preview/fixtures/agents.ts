import { definePreviewFixture } from './types';

/**
 * SAMPLE data for the agents Preview: the fleet, each agent's guardrails, a sample activity log and sample Navigator replies.
 * Invented, never mixed with real data. Money is a decimal string; a count is a whole number. See ../README.md.
 */
export type SampleAgentId =
  'navigator' | 'portfolio' | 'scanner' | 'copy-intel' | 'risk' | 'support' | 'coach' | 'launch' | 'merchant' | 'growth';
/** On duty, paused by the person, or not set up yet. */
export type SampleAgentState = 'on' | 'paused' | 'off';
/** How much an agent may do alone: only suggest, ask before each action, or act inside the limits. */
export type SampleAgentMode = 'suggest' | 'ask' | 'act';

export interface SampleActionRule {
  readonly id: string;
  /** Plain words for what the agent may do. */
  readonly label: string;
  readonly allowed: boolean;
  /** A rule the person cannot change. `why` says so in a line. */
  readonly locked?: boolean;
  readonly why?: string;
}

export interface SampleLimits {
  /** USD. The most one action may be. */
  readonly maxPerAction: string;
  /** USD. The most all actions may add up to in a day. */
  readonly dailyLimit: string;
  /** USD. Above this the agent must ask first, even in "Act inside limits". */
  readonly askAbove: string;
  /** Whole percent of the account value. The agent pauses itself after a loss this big in a day. */
  readonly stopAtLoss: string;
}

export interface SampleGuardrails {
  readonly mode: SampleAgentMode;
  /** Null for an agent that only reads and never moves money. */
  readonly limits: SampleLimits | null;
  readonly actions: readonly SampleActionRule[];
  /** Coins this agent may touch, by symbol. Empty for an agent that does not trade. */
  readonly markets: readonly string[];
}

export interface SampleAgent {
  readonly id: SampleAgentId;
  readonly name: string;
  /** What it does, in the vision's own words. */
  readonly job: string;
  readonly state: SampleAgentState;
  readonly canMoveMoney: boolean;
  readonly guardrails: SampleGuardrails;
}

export type SampleCheck = 'inside' | 'asked' | 'blocked';
export type SampleResult = 'done' | 'waiting' | 'declined' | 'stopped';

export interface SampleLogEntry {
  readonly id: string;
  /** A fixed instant (UTC). Drawn in the viewer's own time zone. */
  readonly at: string;
  readonly agent: SampleAgentId;
  readonly did: string;
  /** USD, or null when the action moved no money. */
  readonly size: string | null;
  readonly check: SampleCheck;
  readonly result: SampleResult;
}

export interface SampleCommand {
  readonly text: string;
  readonly reply: string;
  /** What Navigator would do, one step per line. */
  readonly steps: readonly string[];
  readonly size: string | null;
  readonly check: SampleCheck;
}

export interface SampleAgentsRows {
  /** The sample clock for "the last 24 hours". */
  readonly asOf: string;
  readonly agents: readonly SampleAgent[];
  readonly log: readonly SampleLogEntry[];
  readonly commands: readonly SampleCommand[];
  /** The starting limits came from the person's Identity Blueprint; this is the sample temperament it names. */
  readonly temperament: string;
}

const readOnly = (rules: ReadonlyArray<readonly [string, string, string?]>): readonly SampleActionRule[] =>
  rules.map(([id, label, why]) => ({ id, label, allowed: true, ...(why ? { locked: true, why } : {}) }));

const agents: readonly SampleAgent[] = [
  {
    id: 'navigator',
    name: 'Navigator',
    job: 'Answers anything and carries out your commands, by text or voice, on every screen.',
    state: 'on',
    canMoveMoney: true,
    guardrails: {
      mode: 'ask',
      limits: { maxPerAction: '500.00', dailyLimit: '1500.00', askAbove: '250.00', stopAtLoss: '5' },
      markets: ['BTC', 'ETH', 'SOL', 'USDT'],
      actions: [
        { id: 'spot', label: 'Place spot orders', allowed: true },
        { id: 'convert', label: 'Convert one coin to another', allowed: true },
        { id: 'earn', label: 'Move funds into Earn', allowed: true },
        { id: 'bots', label: 'Start and stop my bots', allowed: false },
        { id: 'copy', label: 'Change my copy trading settings', allowed: false },
        { id: 'send', label: 'Send money to another person', allowed: false, locked: true, why: 'Sending always needs you.' },
        { id: 'withdraw', label: 'Withdraw to an outside wallet', allowed: false, locked: true, why: 'Withdrawals always need you.' },
      ],
    },
  },
  {
    id: 'portfolio',
    name: 'Portfolio',
    job: 'Watches your holdings all day, flags concentration risk and proposes rebalances.',
    state: 'on',
    canMoveMoney: true,
    guardrails: {
      mode: 'suggest',
      limits: { maxPerAction: '300.00', dailyLimit: '900.00', askAbove: '100.00', stopAtLoss: '4' },
      markets: ['BTC', 'ETH', 'USDT'],
      actions: [
        { id: 'rebalance', label: 'Rebalance toward my targets', allowed: true },
        { id: 'convert', label: 'Convert one coin to another', allowed: true },
        { id: 'earn', label: 'Move idle funds into Earn', allowed: false },
        { id: 'trim', label: 'Sell part of an oversized holding', allowed: false },
        { id: 'withdraw', label: 'Withdraw to an outside wallet', allowed: false, locked: true, why: 'Withdrawals always need you.' },
      ],
    },
  },
  {
    id: 'scanner',
    name: 'Market Scanner',
    job: 'Sweeps every listed coin for momentum, volume jumps and funding shifts, and sends ranked signals.',
    state: 'on',
    canMoveMoney: false,
    guardrails: {
      mode: 'suggest',
      limits: null,
      markets: [],
      actions: readOnly([
        ['read', 'Read market data', 'This agent only reads. It cannot move money.'],
        ['alert', 'Send me alerts'],
        ['digest', 'Send a morning summary'],
      ]),
    },
  },
  {
    id: 'copy-intel',
    name: 'Copy-Intel',
    job: 'Checks the traders you follow: real risk, honest drawdown and style drift.',
    state: 'on',
    canMoveMoney: false,
    guardrails: {
      mode: 'ask',
      limits: null,
      markets: [],
      actions: [
        { id: 'read', label: 'Read trader track records', allowed: true, locked: true, why: 'This agent only reads.' },
        { id: 'warn', label: 'Warn me about a trader I follow', allowed: true },
        { id: 'pause', label: 'Pause a copy when risk jumps', allowed: true },
        { id: 'stop', label: 'Stop a copy for good', allowed: false },
      ],
    },
  },
  {
    id: 'risk',
    name: 'Risk & Compliance',
    job: 'Watches account activity around the clock and flags anything unusual before it costs you.',
    state: 'on',
    canMoveMoney: false,
    guardrails: {
      mode: 'suggest',
      limits: null,
      markets: [],
      actions: readOnly([
        ['watch', 'Watch my account activity', 'This agent only reads. It cannot move money.'],
        ['flag', 'Flag unusual moves'],
        ['report', 'Draft a report for me to read'],
      ]),
    },
  },
  {
    id: 'support',
    name: 'Support',
    job: 'First-line help on every product, tied to your live account, with a full case file if a person steps in.',
    state: 'on',
    canMoveMoney: false,
    guardrails: {
      mode: 'suggest',
      limits: null,
      markets: [],
      actions: readOnly([
        ['status', 'Read my account status to answer me', 'This agent only reads.'],
        ['case', 'Open a case with a person'],
      ]),
    },
  },
  {
    id: 'coach',
    name: 'Academy Coach',
    job: 'A personal tutor: adaptive pacing, weak-spot drills and certification tracking.',
    state: 'paused',
    canMoveMoney: false,
    guardrails: {
      mode: 'suggest',
      limits: null,
      markets: [],
      actions: readOnly([
        ['lessons', 'Suggest lessons'],
        ['track', 'Track my certifications'],
      ]),
    },
  },
  {
    id: 'launch',
    name: 'Launch',
    job: 'Guides token creators from tokenomics template to launch-day liquidity plan.',
    state: 'off',
    canMoveMoney: false,
    guardrails: {
      mode: 'suggest',
      limits: null,
      markets: [],
      actions: [{ id: 'draft', label: 'Draft a launch checklist', allowed: false }],
    },
  },
  {
    id: 'merchant',
    name: 'Merchant',
    job: 'For payment clients: watches approval rates, proposes routing changes and drafts dispute replies.',
    state: 'off',
    canMoveMoney: false,
    guardrails: {
      mode: 'suggest',
      limits: null,
      markets: [],
      actions: [{ id: 'routing', label: 'Propose routing changes', allowed: false }],
    },
  },
  {
    id: 'growth',
    name: 'Growth',
    job: 'Runs campaign experiments, drafts posts in your brand voice and scores affiliates.',
    state: 'off',
    canMoveMoney: false,
    guardrails: { mode: 'suggest', limits: null, markets: [], actions: [{ id: 'drafts', label: 'Draft campaign posts', allowed: false }] },
  },
];

const log: readonly SampleLogEntry[] = [
  {
    id: 'l1',
    at: '2026-10-14T08:41:00Z',
    agent: 'navigator',
    did: 'Converted USDT to BTC',
    size: '150.00',
    check: 'inside',
    result: 'done',
  },
  {
    id: 'l2',
    at: '2026-10-14T08:12:00Z',
    agent: 'portfolio',
    did: 'Proposed selling part of ETH to ease concentration',
    size: '420.00',
    check: 'asked',
    result: 'waiting',
  },
  {
    id: 'l3',
    at: '2026-10-14T07:55:00Z',
    agent: 'scanner',
    did: 'Flagged ETH volume up 2.1x',
    size: null,
    check: 'inside',
    result: 'done',
  },
  {
    id: 'l4',
    at: '2026-10-14T07:30:00Z',
    agent: 'navigator',
    did: 'Tried to send USDT to a new address',
    size: '300.00',
    check: 'blocked',
    result: 'stopped',
  },
  {
    id: 'l5',
    at: '2026-10-14T06:58:00Z',
    agent: 'copy-intel',
    did: 'Warned: Trader C drew down more than they report',
    size: null,
    check: 'inside',
    result: 'done',
  },
  {
    id: 'l6',
    at: '2026-10-14T06:20:00Z',
    agent: 'portfolio',
    did: 'Rebalanced toward your targets',
    size: '85.00',
    check: 'inside',
    result: 'done',
  },
  {
    id: 'l7',
    at: '2026-10-14T05:47:00Z',
    agent: 'risk',
    did: 'Flagged a sign-in from a new device',
    size: null,
    check: 'inside',
    result: 'done',
  },
  { id: 'l8', at: '2026-10-13T22:10:00Z', agent: 'navigator', did: 'Moved USDT into Earn', size: '500.00', check: 'asked', result: 'done' },
  {
    id: 'l9',
    at: '2026-10-13T19:35:00Z',
    agent: 'navigator',
    did: 'Placed a limit buy of BTC',
    size: '200.00',
    check: 'inside',
    result: 'done',
  },
  {
    id: 'l10',
    at: '2026-10-13T16:02:00Z',
    agent: 'portfolio',
    did: 'Proposed moving USDT into Earn',
    size: '1000.00',
    check: 'asked',
    result: 'declined',
  },
  {
    id: 'l11',
    at: '2026-10-13T11:30:00Z',
    agent: 'support',
    did: 'Answered a question about card limits',
    size: null,
    check: 'inside',
    result: 'done',
  },
  {
    id: 'l12',
    at: '2026-10-13T09:15:00Z',
    agent: 'navigator',
    did: 'Showed this month profit and loss',
    size: null,
    check: 'inside',
    result: 'done',
  },
];

const commands: readonly SampleCommand[] = [
  {
    text: 'Move half my USDT into Earn',
    reply: 'You hold $2,400.00 of USDT in this sample. Half is $1,200.00, which is above the $250.00 you asked me to check with you first.',
    steps: ['Check free USDT: $2,400.00', 'Move $1,200.00 into Earn', 'Log the move so you can read it later'],
    size: '1200.00',
    check: 'asked',
  },
  {
    text: 'Show my profit and loss this month',
    reply: 'This month so far, across spot and bots: up $214.60, which is 3.1% of your starting value. Reading only, nothing moves.',
    steps: ['Read this month of filled orders', 'Add up bot results', 'Show the total'],
    size: null,
    check: 'inside',
  },
  {
    text: 'Buy $100 of BTC',
    reply: 'A $100.00 market buy of BTC is inside your limits, so I can place it now.',
    steps: ['Check the BTC price: $64,250.00', 'Place a $100.00 market buy', 'Log the order'],
    size: '100.00',
    check: 'inside',
  },
];

export const agentsFixture = definePreviewFixture<SampleAgentsRows>(
  'agents',
  'Your agent fleet: sample agents, limits and activity. They suggest, you approve.',
  {
    asOf: '2026-10-14T09:00:00Z',
    agents,
    log,
    commands,
    temperament: 'Balanced',
  },
);
