import { defineCopy } from '../../../shared/i18n';

// A position's stop and target on the futures chart, and the breakeven press (J-derivatives-32). English source only;
// other languages fall back to English. Curly apostrophes on purpose. Money words only, no service codes.
export const exitLinesCopy = defineCopy('trade.futures.exit-lines', {
  'Stop line': 'Stop {price} · {result} · {r}',
  'Target line': 'Target {price} · {result} · {r}',
  'New stop line': 'New stop {price} · {result}',
  'Entry line': 'Entry {price}',
  'R value': '{r}R',
  'R not known': 'R not known',
  'Not known': 'not known',
  'Not sent': 'not sent',
  'Stop handle': 'Stop line for {symbol} at {price}: drag to move it',
  'Target handle': 'Target line for {symbol} at {price}: drag to move it',
  'Entry handle': 'Entry line for {symbol} at {price}',
  'Entry handle drag': 'Entry line for {symbol} at {price}: drag out a stop',
  Breakeven: 'Breakeven',
  'Lines fixed': 'This venue doesn’t move a resting stop or target in place: change them from the position’s Exit orders.',
  'Breakeven on chart': 'Move the stop on {symbol} to breakeven',
  'Breakeven on row': 'Breakeven {symbol}',
  'Stop moved': 'The venue holds your stop at {price}.',
  'Target moved': 'The venue holds your target at {price}.',
  'Stop placed': 'Your stop rests on the venue at {price}, reduce-only for the whole position.',
  'Stop not on venue': 'The venue does not hold that stop, so nothing was sent.',
  'Not moved': '{detail}',
  'Venue refused move': 'The venue refused the move: {detail} Your order stays where the venue holds it.',
  'Breakeven done':
    'Your stop rests at breakeven, {price}: the entry {entry} with the venue’s fee and ours, in and out ({bps} bps on the way out).',
  'Breakeven refused': '{detail}',
  'No answer': 'No answer came back, so this may not have happened. Read your open orders: what the venue holds is what counts.',
  'Breakeven not finished':
    'The venue had not finished moving your stop after {calls} tries. Read your open orders: the stop it holds is the one that counts.',
});
