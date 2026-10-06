import { add, div, formatAmount, mul, parseAmount, sub } from '@intafaced/ledger-client/money';
import { QUANT_SANDBOX_ESCAPE, QUANT_SANDBOX_SYNTAX, QUANT_SANDBOX_TIMEOUT, QUANT_SANDBOX_UNWIRED, QuantError } from '../errors.js';
import type { PaperBook, PaperFill } from './book.js';
import { assertPublishedSandboxMaxOps, assertPublishedSandboxMaxSource } from './max.js';

/**
 * Restricted strategy isolate.
 *
 * User source is tokenised and interpreted here. It is never `eval`'d, never
 * handed to Node `Function`, and never given `fetch` / `require` / `process`.
 * Market data and OMS are the only host objects. That is the sandbox: a runtime
 * that can reach the network is not a sandbox with a gap.
 */

export type Language = 'javascript' | 'typescript' | 'python';

export interface IsolateLimits {
  readonly maxOps: number | undefined;
  readonly maxSource: number | undefined;
}

export interface IsolateResult {
  readonly logs: string[];
  readonly cash: string;
  readonly pnl: string;
  readonly fills: readonly PaperFill[];
  readonly positions: readonly { symbol: string; qty: string }[];
}

const FORBIDDEN =
  /\b(require|import|fetch|eval|Function|process|globalThis|global|window|Deno|Bun|XMLHttpRequest|WebSocket|SharedArrayBuffer|Atomics|Worker|child_process|__import__|subprocess|socket|urllib|requests|httpx|aiohttp|dgram|cluster)\b|import\s*\(|new\s+Function|constructor\s*\(|__proto__|prototype\s*\[/;

type Tok = { k: 'num'; v: string } | { k: 'str'; v: string } | { k: 'id'; v: string } | { k: 'op'; v: string } | { k: 'nl' } | { k: 'eof' };

type Val = string | boolean | null | Host | readonly unknown[];

interface Host {
  readonly $host: 'market' | 'oms' | 'book' | 'console';
}

export function assertIsolateWired(wired: boolean): void {
  if (!wired) throw new QuantError(QUANT_SANDBOX_UNWIRED, 'strategy isolate is not wired');
}

export function scanEscape(source: string): void {
  if (FORBIDDEN.test(source)) {
    throw new QuantError(QUANT_SANDBOX_ESCAPE, 'user code may not reach the network or the host runtime');
  }
  if (/\bopen\s*\(/.test(source) || /\bexec\s*\(/.test(source) || /\bcompile\s*\(/.test(source)) {
    throw new QuantError(QUANT_SANDBOX_ESCAPE, 'user code may not open files or exec');
  }
}

function tokenize(source: string, python: boolean): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = source.length;
  const pushOp = (v: string, len = v.length) => {
    out.push({ k: 'op', v });
    i += len;
  };
  while (i < n) {
    const c = source[i]!;
    if (c === '#' && python) {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '\n') {
      out.push({ k: 'nl' });
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      let s = '';
      while (i < n && source[i] !== q) {
        if (source[i] === '\\' && i + 1 < n) {
          s += source[i + 1];
          i += 2;
          continue;
        }
        s += source[i];
        i++;
      }
      if (source[i] !== q) throw new QuantError(QUANT_SANDBOX_SYNTAX, 'unterminated string');
      i++;
      out.push({ k: 'str', v: s });
      continue;
    }
    if ((c >= '0' && c <= '9') || (c === '.' && source[i + 1] !== undefined && source[i + 1]! >= '0' && source[i + 1]! <= '9')) {
      let s = '';
      while (i < n && ((source[i]! >= '0' && source[i]! <= '9') || source[i] === '.')) {
        s += source[i];
        i++;
      }
      out.push({ k: 'num', v: s });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let s = '';
      while (i < n && /[A-Za-z0-9_]/.test(source[i]!)) {
        s += source[i];
        i++;
      }
      out.push({ k: 'id', v: s });
      continue;
    }
    const two = source.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '&&', '||', '===', '!=='].includes(two) || two === '===') {
      if (source.slice(i, i + 3) === '===' || source.slice(i, i + 3) === '!==') {
        pushOp(source.slice(i, i + 3), 3);
        continue;
      }
      pushOp(two, 2);
      continue;
    }
    if ('(){},.;:+-*/<>!='.includes(c)) {
      pushOp(c, 1);
      continue;
    }
    throw new QuantError(QUANT_SANDBOX_SYNTAX, `unexpected character ${JSON.stringify(c)}`);
  }
  out.push({ k: 'eof' });
  return out;
}

function isAmountString(v: Val): v is string {
  return typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v);
}

function isHost(v: Val): v is Host {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && '$host' in v;
}

function stringify(v: Val): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return JSON.stringify(v);
  if (isHost(v)) return `[${v.$host}]`;
  return 'unknown';
}

export function runIsolate(language: Language, source: string, book: PaperBook, limits: IsolateLimits, wired: boolean): IsolateResult {
  const maxSource = assertPublishedSandboxMaxSource(limits.maxSource);
  const maxOps = assertPublishedSandboxMaxOps(limits.maxOps);
  assertIsolateWired(wired);
  if (source.length > maxSource) {
    throw new QuantError(QUANT_SANDBOX_SYNTAX, `source longer than ${maxSource} characters`);
  }
  scanEscape(source);

  const python = language === 'python';
  const tokens = tokenize(source, python);
  const logs: string[] = [];
  const env = new Map<string, Val>();

  const market: Host = { $host: 'market' };
  const oms: Host = { $host: 'oms' };
  const bookHost: Host = { $host: 'book' };
  const cons: Host = { $host: 'console' };
  env.set('market', market);
  env.set('oms', oms);
  env.set('book', bookHost);
  env.set('console', cons);
  env.set('true', true);
  env.set('false', false);
  env.set('null', null);
  env.set('None', null);

  let ops = 0;
  let live = true;
  const bump = () => {
    ops += 1;
    if (ops > maxOps) throw new QuantError(QUANT_SANDBOX_TIMEOUT, `exceeded ${maxOps} operations`);
  };

  const callHost = (host: Host, method: string, args: Val[]): Val => {
    bump();
    if (!live) return null;
    const a0 = () => {
      const v = args[0];
      if (typeof v !== 'string') throw new QuantError(QUANT_SANDBOX_SYNTAX, `${host.$host}.${method} needs a string`);
      return v;
    };
    const a1 = () => {
      const v = args[1];
      if (typeof v !== 'string') throw new QuantError(QUANT_SANDBOX_SYNTAX, `${host.$host}.${method} needs a decimal string qty`);
      return v;
    };
    if (host.$host === 'market') {
      if (method === 'last') return book.last(a0());
      if (method === 'bid') return book.bid(a0());
      if (method === 'ask') return book.ask(a0());
      throw new QuantError(QUANT_SANDBOX_ESCAPE, `unknown market method ${method}`);
    }
    if (host.$host === 'oms') {
      if (method === 'buy') {
        book.buy(a0(), a1());
        return null;
      }
      if (method === 'sell') {
        book.sell(a0(), a1());
        return null;
      }
      if (method === 'venueBuy') return book.venueBuy(a0(), a1()) as unknown as Val;
      if (method === 'venueSell') return book.venueSell(a0(), a1()) as unknown as Val;
      throw new QuantError(QUANT_SANDBOX_ESCAPE, `unknown oms method ${method}`);
    }
    if (host.$host === 'book') {
      if (method === 'cash') return book.cash();
      if (method === 'pnl') return book.pnl();
      if (method === 'position') return book.position(a0());
      if (method === 'fills') return book.fills();
      throw new QuantError(QUANT_SANDBOX_ESCAPE, `unknown book method ${method}`);
    }
    if (host.$host === 'console') {
      if (method === 'log') {
        logs.push(args.map(stringify).join(' '));
        return null;
      }
      throw new QuantError(QUANT_SANDBOX_ESCAPE, `unknown console method ${method}`);
    }
    throw new QuantError(QUANT_SANDBOX_ESCAPE, 'unknown host');
  };

  const printFn = (args: Val[]): Val => {
    if (!live) return null;
    logs.push(args.map(stringify).join(' '));
    return null;
  };

  let p = 0;
  const peek = (): Tok => tokens[p] ?? { k: 'eof' };
  const skipNl = () => {
    for (;;) {
      const t = peek();
      if (t.k === 'nl') {
        p++;
        continue;
      }
      if (t.k === 'op' && t.v === ';') {
        p++;
        continue;
      }
      break;
    }
  };
  const eatOp = (v: string) => {
    const t = peek();
    if (t.k !== 'op' || t.v !== v) throw new QuantError(QUANT_SANDBOX_SYNTAX, `expected ${v}`);
    p++;
  };
  const tryOp = (v: string): boolean => {
    const t = peek();
    if (t.k === 'op' && t.v === v) {
      p++;
      return true;
    }
    return false;
  };

  const parseArgs = (): Val[] => {
    eatOp('(');
    const args: Val[] = [];
    if (!(peek().k === 'op' && (peek() as { v: string }).v === ')')) {
      args.push(parseExpr());
      while (tryOp(',')) args.push(parseExpr());
    }
    eatOp(')');
    return args;
  };

  const parseAtom = (): Val => {
    bump();
    const t = peek();
    if (t.k === 'num') {
      p++;
      return t.v;
    }
    if (t.k === 'str') {
      p++;
      return t.v;
    }
    if (t.k === 'id') {
      p++;
      if (t.v === 'print' && python) {
        return printFn(parseArgs());
      }
      if (t.v === 'log' && !python) {
        return printFn(parseArgs());
      }
      const got = env.get(t.v);
      if (got === undefined) throw new QuantError(QUANT_SANDBOX_SYNTAX, `unknown identifier ${t.v}`);
      return got;
    }
    if (t.k === 'op' && t.v === '(') {
      p++;
      const inner = parseExpr();
      eatOp(')');
      return inner;
    }
    throw new QuantError(QUANT_SANDBOX_SYNTAX, 'expected expression');
  };

  const parsePost = (): Val => {
    let v = parseAtom();
    for (;;) {
      if (tryOp('.')) {
        const m = peek();
        if (m.k !== 'id') throw new QuantError(QUANT_SANDBOX_SYNTAX, 'expected method name');
        p++;
        if (m.v === 'constructor' || m.v === '__proto__' || m.v === 'prototype') {
          throw new QuantError(QUANT_SANDBOX_ESCAPE, 'prototype access is forbidden');
        }
        if (peek().k === 'op' && (peek() as { v: string }).v === '(') {
          if (v && typeof v === 'object' && !Array.isArray(v) && '$host' in v) {
            v = callHost(v, m.v, parseArgs());
            continue;
          }
          throw new QuantError(QUANT_SANDBOX_ESCAPE, 'only runtime API methods may be called');
        }
        throw new QuantError(QUANT_SANDBOX_ESCAPE, 'property access is limited to runtime API methods');
      }
      break;
    }
    return v;
  };

  const parseUnary = (): Val => {
    if (tryOp('!')) {
      const v = parseUnary();
      return !v;
    }
    if (tryOp('-')) {
      const v = parseUnary();
      if (!isAmountString(v)) throw new QuantError(QUANT_SANDBOX_SYNTAX, 'unary minus needs a decimal');
      return formatAmount(sub(parseAmount('0'), parseAmount(v)));
    }
    return parsePost();
  };

  const binMul = (op: string, a: Val, b: Val): Val => {
    if (!isAmountString(a) || !isAmountString(b)) throw new QuantError(QUANT_SANDBOX_SYNTAX, 'arithmetic needs decimal strings');
    if (op === '*') return formatAmount(mul(parseAmount(a), parseAmount(b), 'half-up'));
    return formatAmount(div(parseAmount(a), parseAmount(b), 'half-up'));
  };

  const binAdd = (op: string, a: Val, b: Val): Val => {
    if (typeof a === 'string' && typeof b === 'string' && !(isAmountString(a) && isAmountString(b))) return a + b;
    if (!isAmountString(a) || !isAmountString(b)) throw new QuantError(QUANT_SANDBOX_SYNTAX, 'arithmetic needs decimal strings');
    if (op === '+') return formatAmount(add(parseAmount(a), parseAmount(b)));
    return formatAmount(sub(parseAmount(a), parseAmount(b)));
  };

  const parseMul = (): Val => {
    let v = parseUnary();
    for (;;) {
      if (tryOp('*')) v = binMul('*', v, parseUnary());
      else if (tryOp('/')) v = binMul('/', v, parseUnary());
      else break;
    }
    return v;
  };

  const parseAdd = (): Val => {
    let v = parseMul();
    for (;;) {
      if (tryOp('+')) v = binAdd('+', v, parseMul());
      else if (tryOp('-')) v = binAdd('-', v, parseMul());
      else break;
    }
    return v;
  };

  const parseCmp = (): Val => {
    let v = parseAdd();
    for (;;) {
      const t = peek();
      if (t.k !== 'op' || !['==', '!=', '===', '!==', '<', '>', '<=', '>='].includes(t.v)) break;
      p++;
      const r = parseAdd();
      bump();
      if (t.v === '==' || t.v === '===') v = stringify(v) === stringify(r);
      else if (t.v === '!=' || t.v === '!==') v = stringify(v) !== stringify(r);
      else {
        if (!isAmountString(v) || !isAmountString(r)) throw new QuantError(QUANT_SANDBOX_SYNTAX, 'compare needs decimals');
        const c = parseAmount(v) - parseAmount(r);
        if (t.v === '<') v = c < 0n;
        else if (t.v === '>') v = c > 0n;
        else if (t.v === '<=') v = c <= 0n;
        else v = c >= 0n;
      }
    }
    return v;
  };

  function parseExpr(): Val {
    return parseCmp();
  }

  const parseStmt = (): void => {
    skipNl();
    const t = peek();
    if (t.k === 'eof') return;
    if (t.k === 'id' && (t.v === 'const' || t.v === 'let' || t.v === 'var')) {
      p++;
      const name = peek();
      if (name.k !== 'id') throw new QuantError(QUANT_SANDBOX_SYNTAX, 'expected identifier');
      p++;
      if (tryOp(':')) {
        const ty = peek();
        if (ty.k === 'id') p++;
      }
      eatOp('=');
      const val = parseExpr();
      if (live) env.set(name.v, val);
      tryOp(';');
      return;
    }
    if (
      t.k === 'id' &&
      tokens[p + 1]?.k === 'op' &&
      (tokens[p + 1] as { v: string }).v === '=' &&
      t.v !== 'market' &&
      t.v !== 'oms' &&
      t.v !== 'book'
    ) {
      p++;
      eatOp('=');
      const val = parseExpr();
      if (live) env.set(t.v, val);
      tryOp(';');
      return;
    }
    if (t.k === 'id' && t.v === 'if') {
      p++;
      if (!python) eatOp('(');
      const cond = parseExpr();
      if (!python) eatOp(')');
      if (python) eatOp(':');
      else eatOp('{');
      // Indentation is discarded, so a python if body is the next statement, not a brace block.
      if (python) {
        while (peek().k === 'nl') p++;
        if (!cond) {
          const prev = live;
          live = false;
          parseStmt();
          live = prev;
        } else {
          parseStmt();
        }
        return;
      }
      if (cond) {
        while (
          peek().k !== 'eof' &&
          !(peek().k === 'op' && ((peek() as { v: string }).v === '}' || (peek() as { v: string }).v === 'else'))
        ) {
          if (python && peek().k === 'nl') break;
          parseStmt();
          skipNl();
        }
      } else {
        let depth = python ? 0 : 1;
        while (peek().k !== 'eof' && depth > 0) {
          const x = peek();
          if (x.k === 'op' && x.v === '{') depth++;
          if (x.k === 'op' && x.v === '}') {
            depth--;
            if (depth === 0 && !python) {
              p++;
              break;
            }
          }
          p++;
        }
      }
      if (!python) tryOp('}');
      return;
    }
    parseExpr();
    tryOp(';');
  };

  skipNl();
  while (peek().k !== 'eof') {
    parseStmt();
    skipNl();
  }

  const symbols = new Set(book.fills().map((f) => f.symbol));
  return {
    logs,
    cash: book.cash(),
    pnl: book.pnl(),
    fills: book.fills(),
    positions: [...symbols].map((symbol) => ({ symbol, qty: book.position(symbol) })),
  };
}
