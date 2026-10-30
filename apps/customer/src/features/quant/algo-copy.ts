import { defineCopy } from '../../shared/i18n';

// Algo dev home (J-algo-dev-01 #1). Counts enter through parameters; nothing here is a sample number.
const en = {
  rooms: 'Algo dev rooms',
  home: 'Start',
  strategiesRoom: 'Strategies',
  studio: 'Studio',
  backtest: 'Backtest',
  sandbox: 'Sandbox',
  execution: 'Execution',
  title: 'Algo dev',
  description: 'Build a strategy, test it on history and run it on paper. Nothing here trades live.',
  simulated: 'Simulated only. Every figure here is a simulation, never live performance.',
  quickStart: 'Quick start',
  quickStartCount: '{done} of 3 steps done',
  stepStrategy: 'Save your first strategy',
  stepStrategyBody: 'Build one in Studio and save it to your library.',
  stepBacktest: 'Run your first backtest',
  stepBacktestBody: 'Test a saved strategy on historical prices.',
  stepPaper: 'Run your first paper run',
  stepPaperBody: 'Run strategy code on the paper book in the sandbox.',
  stepDone: 'Done',
  stepOpen: 'To do',
  openStudio: 'Open Studio',
  openBacktest: 'Open Backtest',
  openSandbox: 'Open Sandbox',
  learn: 'Learn how strategies work in Academy',
  strategies: 'Your strategies',
  strategiesNone: 'No strategy is saved yet.',
  strategiesNoneBody: 'Strategies you save in Studio are listed here.',
  signedOutTitle: 'Sign in to see your strategies',
  signedOutBody: 'Strategies and runs belong to your account. Every room stays open to look at.',
  signIn: 'Sign in',
} as const;

export const algoCopy = defineCopy('quant.algo', en);
