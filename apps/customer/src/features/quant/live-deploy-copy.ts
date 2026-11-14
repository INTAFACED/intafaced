import { defineCopy } from '../../shared/i18n';

// The deploy wizard (AL-live-02; J-algo-dev-06 #6 #7). Figures enter through parameters; every amount here is TEST.
const en = {
  title: 'Deploy a strategy live',
  intro:
    'Check a saved strategy version before it trades on your own venue account. The check names every order the live runner can’t place. Your funds stay in a venue sub-account your own wallet controls: INTAFACED holds none of it.',
  back: 'Back to Bots',
  noStrategy: 'Choose a strategy to deploy from the Paper strategies list in Bots.',
  strategy: 'Strategy: {name}',
  version: 'Version',
  versionOf: 'Version {version}',
  liveOff: 'Live trading for strategies is switched off on INTAFACED. You can run the check, and Deploy refuses until it is switched on.',
  liveOn: 'Live trading for strategies is switched on.',
  check: 'Run the compile check',
  checking: 'Checking…',
  checkTitle: 'Compile check',
  part: 'Order from',
  orderType: 'Order type',
  verdict: 'Live',
  block: 'Order block {n}',
  signal_entry: 'Signal rules: entry',
  stop_loss: 'Stop loss at {percent} %',
  take_profit: 'Take profit at {percent} %',
  market: 'Market order',
  stop: 'Stop order',
  takeProfitType: 'Take-profit order',
  supported: 'Can be placed live',
  refusedPlan: 'Refused: the live runner trades order blocks only in this build',
  refusedType: 'Refused: a live deploy places no {type}',
  compiles: 'Version {version} compiles: every order can be placed live.',
  notCompiles:
    'Version {version} does not compile for live: {count} of its orders can’t be placed. Change them in Quant Studio and save a new version.',
  nothing: 'This version places no order.',
  amount: 'Amount your wallet moves (TEST USDC)',
  fundingBlank: 'Enter the amount your wallet will move to the strategy’s sub-account.',
  funding:
    'TEST: your own wallet will sign one move of {amount} TEST USDC from your venue account to this strategy’s own venue sub-account. INTAFACED moves nothing and the ledger posts nothing; the venue holds the funds.',
  deploy: 'Deploy version {version}',
  deploying: 'Deploying…',
  refusedTitle: 'Not deployed',
  liveDisabled: 'Live trading for strategies is switched off on INTAFACED, so nothing was deployed and nothing was stored.',
  planUnsupported: 'This version trades by signal rules, which the live runner can’t run in this build. Nothing was stored.',
  typeUnsupported: 'This version has an order a live deploy can’t place. Nothing was stored.',
  unavailable: 'This build makes no funding move and starts no live run, so nothing was deployed and nothing was stored.',
} as const;

export const liveDeployCopy = defineCopy('quant.liveDeploy', en);
