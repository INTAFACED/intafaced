import { SCALE, parseAmount } from '@intafaced/ledger-client';
import { CampaignsError } from './codes.js';

/**
 * The incentive formula grammar of an earning rule (CM-rewards-hub-05). Closed and small: no outside code ever runs.
 *
 *   formula := sum
 *   sum     := product (('+' | '-') product)*
 *   product := atom (('*' | '/') atom)*
 *   atom    := number | name | '(' sum ')' | ('min' | 'max') '(' sum ',' sum ')'
 *   number  := digits, with up to 18 places after a point
 *   name    := one of the trigger's names (`amount`, `fee`, `qty` …)
 *
 * Values are decimals held as bigint scaled by 10^18; a quotient rounds down, and the result is never below zero (an
 * incentive is never a charge). Anything outside the grammar refuses `campaigns.formula_invalid`, naming where.
 */

export type Formula =
  | { kind: 'number'; value: bigint }
  | { kind: 'name'; name: string }
  | { kind: 'op'; op: '+' | '-' | '*' | '/'; left: Formula; right: Formula }
  | { kind: 'call'; fn: 'min' | 'max'; left: Formula; right: Formula };

const MAX_TOKENS = 60;

type Token = { text: string; at: number };

function refuse(why: string): never {
  throw new CampaignsError('campaigns.formula_invalid', `The incentive formula is not in the formula grammar: ${why}`);
}

function tokens(source: string): Token[] {
  const out: Token[] = [];
  const re = /\s*(\d+(?:\.\d+)?|[a-z]+|[-+*/(),])/gy;
  let at = 0;
  while (at < source.length) {
    re.lastIndex = at;
    const m = re.exec(source);
    if (!m) {
      if (/^\s*$/.test(source.slice(at))) break;
      refuse(`"${source.slice(at).trim()[0]}" at position ${at + 1} is not a number, a name or an operator`);
    }
    out.push({ text: m[1]!, at: m.index + m[0].length - m[1]!.length + 1 });
    at = re.lastIndex;
  }
  if (out.length > MAX_TOKENS) refuse(`it is longer than ${MAX_TOKENS} parts`);
  return out;
}

const decimal = (text: string): bigint => {
  if ((text.split('.')[1] ?? '').length > 18) refuse(`${text} has more than 18 places`);
  try {
    return parseAmount(text);
  } catch {
    return refuse(`${text} is larger than an amount can be`);
  }
};

/** Parses a formula against the names its trigger allows. */
export function parseFormula(source: string, names: readonly string[]): Formula {
  const list = tokens(source);
  if (list.length === 0) refuse('it is empty');
  let i = 0;
  const peek = () => list[i]?.text;
  const where = () => (list[i] ? `"${list[i]!.text}" at position ${list[i]!.at}` : 'the end');
  const expect = (text: string) => {
    if (peek() !== text) refuse(`expected "${text}" but found ${where()}`);
    i += 1;
  };
  const atom = (): Formula => {
    const t = peek();
    if (t === undefined) refuse('it ends where a number, a name or ( is expected');
    if (/^\d/.test(t)) {
      i += 1;
      return { kind: 'number', value: decimal(t) };
    }
    if (t === '(') {
      i += 1;
      const inner = sum();
      expect(')');
      return inner;
    }
    if (t === 'min' || t === 'max') {
      i += 1;
      expect('(');
      const left = sum();
      expect(',');
      const right = sum();
      expect(')');
      return { kind: 'call', fn: t, left, right };
    }
    if (/^[a-z]+$/.test(t)) {
      if (!names.includes(t)) refuse(`"${t}" is not a name this trigger has (${names.join(', ')})`);
      i += 1;
      return { kind: 'name', name: t };
    }
    refuse(`expected a number, a name or ( but found ${where()}`);
  };
  const product = (): Formula => {
    let left = atom();
    while (peek() === '*' || peek() === '/') {
      const op = peek() as '*' | '/';
      i += 1;
      left = { kind: 'op', op, left, right: atom() };
    }
    return left;
  };
  const sum = (): Formula => {
    let left = product();
    while (peek() === '+' || peek() === '-') {
      const op = peek() as '+' | '-';
      i += 1;
      left = { kind: 'op', op, left, right: product() };
    }
    return left;
  };
  const out = sum();
  if (i < list.length) refuse(`unexpected ${where()}`);
  return out;
}

/** Works out a formula for one event's values (scaled decimals). Division by zero is zero; the result is never below zero. */
export function evaluateFormula(f: Formula, values: Readonly<Record<string, bigint>>): bigint {
  const run = (n: Formula): bigint => {
    switch (n.kind) {
      case 'number':
        return n.value;
      case 'name':
        return values[n.name] ?? 0n;
      case 'call': {
        const [a, b] = [run(n.left), run(n.right)];
        return n.fn === 'min' ? (a < b ? a : b) : a > b ? a : b;
      }
      case 'op': {
        const [a, b] = [run(n.left), run(n.right)];
        if (n.op === '+') return a + b;
        if (n.op === '-') return a - b;
        if (n.op === '*') return (a * b) / SCALE;
        return b === 0n ? 0n : (a * SCALE) / b;
      }
    }
  };
  const out = run(f);
  return out > 0n ? out : 0n;
}

/** Whether a formula reads any of its trigger's names (a fixed incentive reads none). */
export function readsNames(f: Formula): boolean {
  if (f.kind === 'name') return true;
  if (f.kind === 'number') return false;
  return readsNames(f.left) || readsNames(f.right);
}
