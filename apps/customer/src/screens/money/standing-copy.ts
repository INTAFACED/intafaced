import { defineCopy } from '../../shared/i18n';

// Where a person stands on the launch model (J-home-ia-01 #1 #3): Home's total and Assets' total, one rule. English source
// only. No venue, partner or price-source brand is written here: each name is the one its own source gives.
export const standingCopy = defineCopy('money.standing', {
  Title: 'Where you stand',
  'No total': 'No total',
  'No price published':
    'No price is published for what you hold here, so nothing is valued and there is no total. Each amount is shown as its source reports it.',
  'Nothing priced': 'None of what you hold here has a published price, so there is no total.',
  'Prices failed': 'Prices couldn’t be read right now, so nothing is valued and there is no total.',
  'Prices source': 'Valued at the prices {source} states.',
  TEST: 'TEST',
  'TEST note': 'TEST prices and TEST figures from TEST sources. No real money.',
  'Shown in BTC': 'Shown in BTC at the BTC price {source} states. In dollars: {usd}',
  'Shown in BTC hidden': 'Shown in BTC at the BTC price {source} states.',
  'BTC price missing': 'There is no BTC price right now, so the total is shown in dollars.',
  'Other currency': 'No {currency} rate is published here, so the total is shown in dollars.',
  'Part wallet': 'Your wallet on {name}',
  'Part venue': 'Your venue account on {name}',
  'Part partner': 'Your account at {name}',
  'Part partner unnamed': 'Your partner account',
  'Source wallet': 'read from the chain',
  'Source venue': 'the venue’s own figures',
  'Source partner': 'the partner’s own figures',
  'Part reading': 'Reading…',
  'Part unread': 'Couldn’t be read, so it is left out of the total.',
  'Part not valued': 'Not valued: no published price',
  'Part empty': 'Holds nothing',
  'Unread note': 'Left out of the total because it couldn’t be read: {parts}.',
  'Unpriced note': 'Not counted, because no price is published for them: {assets}.',
  'Connect first': 'Connect your wallet to see what your wallet and your venue account hold.',
});
