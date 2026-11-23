import type { Language } from './isolate.js';

/**
 * The sandbox escape corpus (AL-limits-02, ENGINE T-14, J-algo-dev-12 #5): untrusted strategy code that tries to leave
 * the sandbox or take the host down. Every case must end in a typed refusal, the host process must keep serving, and the
 * account's next ordinary run must be unaffected. The cases are the attacks, written as a developer could type them;
 * the language has no loop, so an endless loop and a memory bomb are written the only ways it allows (a loop keyword,
 * and text that doubles itself line after line).
 */
export interface EscapeCase {
  readonly id: string;
  readonly attack: string;
  readonly language: Language;
  readonly source: string;
}

/** Thirty lines that each double one text: about 2 GB if nothing stopped it, past any sane memory limit. */
const doubling = (name: string, lines: number) =>
  [`let ${name} = "xxxxxxxxxxxxxxxx"`, ...Array.from({ length: lines }, () => `${name} = ${name} + ${name}`)].join('\n');

export const ESCAPE_CORPUS: readonly EscapeCase[] = [
  {
    id: 'prototype-pollution',
    attack: 'Prototype pollution',
    language: 'javascript',
    source: 'const o = book\no.__proto__.polluted = "yes"',
  },
  {
    id: 'constructor-chain',
    attack: 'Constructor chain to Function',
    language: 'javascript',
    source: 'const f = market.last.constructor("return process")',
  },
  { id: 'dynamic-import', attack: 'Dynamic import', language: 'javascript', source: 'const m = import("node:child_process")' },
  { id: 'require', attack: 'Module require', language: 'typescript', source: 'const fs: any = require("fs")' },
  { id: 'timer', attack: 'Timer callback', language: 'javascript', source: 'setTimeout(console.log, 0)' },
  { id: 'infinite-loop', attack: 'Endless loop', language: 'javascript', source: 'while (true) { console.log("x") }' },
  { id: 'memory-bomb', attack: 'Memory bomb', language: 'javascript', source: doubling('s', 30) },
  {
    id: 'huge-output',
    attack: 'Huge output',
    language: 'javascript',
    source: `${doubling('s', 14)}\nconsole.log(s)\nconsole.log(s)\nconsole.log(s)`,
  },
  { id: 'network', attack: 'Network call', language: 'javascript', source: 'fetch("http://169.254.169.254/latest/meta-data/")' },
  { id: 'filesystem', attack: 'File read', language: 'python', source: 'data = open("/etc/passwd")' },
  { id: 'python-import', attack: 'Python import of os', language: 'python', source: 'os = __import__("os")' },
  { id: 'environment', attack: 'Environment read', language: 'javascript', source: 'console.log(process.env.DATABASE_URL)' },
  { id: 'host-global', attack: 'Host global object', language: 'javascript', source: 'const g = globalThis' },
  { id: 'host-method', attack: 'Unlisted host method', language: 'javascript', source: 'oms.withdraw("BTC", "1")' },
  { id: 'eval', attack: 'Eval of text', language: 'javascript', source: 'eval("1 + 1")' },
];

/** The ordinary run after the corpus: it must still start, run and log. */
export const CONTROL_RUN = { language: 'javascript' as const, source: 'console.log("control run after the escape corpus")' };
