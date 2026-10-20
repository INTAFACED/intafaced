/**
 * Unit card — no svc-bank code holds one pool connection while waiting for a second
 *
 * 1. Promise: inside a transaction callback, a claim callback, or a session-lock
 *    body, nothing reaches for the pool-level `this.sql` (or a space lookup that
 *    would use it). The transaction's own `tx` is the only handle there.
 * 2. Break: a request holding a connection waits for another one from the same
 *    pool. postgres.js waits with no timeout, so POOL such requests overlapping
 *    freeze the whole service until restart (GitHub issue #4621).
 * 3. Done bar: this file reads every non-test source file under src/ and fails
 *    on the first `this.sql` inside a `transaction(...)` / `serializable(...)` /
 *    `.begin(...)` callback or a `claim:` callback, on a `this.spaces.<lookup>`
 *    there that is not handed the transaction, and on a `reserve()` or a
 *    `pg_advisory_lock` outside `session-lock.ts`.
 * 4. Class M
 * 5. Paths: services/svc-bank/src/**, session-lock.ts
 * 6. RED: put `this.sql` back inside `fireOccurrenceInner`'s transaction, or call
 *    `this.sql.reserve()` from a service, and this file fails naming the line.
 *
 * It is a syntax check, deliberately small. It cannot see a `this.someMethod()`
 * that reads the pool inside it; `pool-starvation.test.ts` is the behavioural
 * half, with a real pool of N and N racers. A new method that takes `tx` and a
 * new lookup that takes a `db` argument belong on this list when they appear.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from '@typescript/typescript6';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

/** Space lookups that read through `this.sql` unless handed another connection. */
const SPACE_LOOKUPS = new Set(['find', 'get', 'resolveForDebit', 'resolveForCredit']);

function isThis(node: ts.Node): boolean {
  return node.kind === ts.SyntaxKind.ThisKeyword;
}

function isTransactionCall(call: ts.CallExpression): boolean {
  const callee = call.expression.getText();
  return callee === 'transaction' || callee === 'serializable' || callee.endsWith('.begin');
}

function findings(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const where = (node: ts.Node) => `${relative(here, file)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const out: string[] = [];

  function inspectScope(scope: ts.Node, what: string) {
    (function walk(node: ts.Node) {
      if (ts.isPropertyAccessExpression(node) && isThis(node.expression) && node.name.text === 'sql') {
        out.push(`${where(node)}: this.sql inside ${what}`);
      }
      // this.spaces.get(id) / .resolveForDebit(id, now): the last argument must be the transaction.
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        SPACE_LOOKUPS.has(node.expression.name.text) &&
        ts.isPropertyAccessExpression(node.expression.expression) &&
        isThis(node.expression.expression.expression) &&
        node.expression.expression.name.text === 'spaces'
      ) {
        const last = node.arguments[node.arguments.length - 1];
        if (!last || !/^(tx|db)$/.test(last.getText()))
          out.push(`${where(node)}: ${node.expression.getText()}(...) inside ${what} without the transaction`);
      }
      ts.forEachChild(node, walk);
    })(scope);
  }

  (function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && isTransactionCall(node)) {
      for (const arg of node.arguments) {
        if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) inspectScope(arg.body, `a ${node.expression.getText()}() callback`);
      }
    }
    if (ts.isPropertyAssignment(node) && node.name.getText() === 'claim') {
      inspectScope(node.initializer, 'a claim callback (it runs inside the claim transaction)');
    }
    ts.forEachChild(node, visit);
  })(sf);

  return out;
}

describe('svc-bank never holds one pool connection while waiting for a second', () => {
  const files = sources(here);
  // Parsed once while the file loads. Doing it inside the test is what hit the 5s CI limit.
  const poolFindings = files.flatMap(findings);

  it('reads a real set of source files', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.endsWith('transfers/transfer-service.ts'))).toBe(true);
  });

  it('no transaction callback or claim callback uses the pool-level sql', () => {
    expect(poolFindings).toEqual([]);
  });

  it('the scheduled-transfer claim reads its spaces on the transaction', () => {
    const src = readFileSync(join(here, 'transfers', 'transfer-service.ts'), 'utf8');
    expect(src).toMatch(/resolveForDebit\(schedule\.fromSpaceId, now, tx\)/);
    expect(src).toMatch(/resolveForCredit\(schedule\.toSpaceId, \{ actingUserId: from\.userId \}, tx\)/);
    // and does not queue on a schedule row another pass holds across the ledger post
    expect(src).toMatch(/FROM bank\.scheduled_transfers WHERE id = \$\{schedule\.id\} FOR UPDATE SKIP LOCKED/);
  });

  it('a reserved connection or a session advisory lock is taken only through session-lock.ts', () => {
    // Comments may talk about the lock; code may not take it.
    const code = (f: string) =>
      readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
    const offenders = files
      .filter((f) => !f.endsWith('session-lock.ts'))
      .filter((f) => /\.reserve\(\)|pg_advisory_lock|pg_try_advisory_lock/.test(code(f)))
      .map((f) => relative(here, f));
    expect(offenders).toEqual([]);
  });

  it('loan repay and liquidation take both historical keys on one session (rolling deploys still collide)', () => {
    const loans = readFileSync(join(here, 'loans', 'loan-service.ts'), 'utf8');
    const ramps = readFileSync(join(here, 'ramps', 'ramp-service.ts'), 'utf8');
    expect(loans).toContain("withSessionAdvisoryLocks(this.sql, ['bank.loan.liquidate', 'bank.loan.repay'], loanId, body)");
    expect(loans).toContain("withSessionAdvisoryLock(this.sql, 'bank.loan.open', loanId, body)");
    expect(ramps).toContain("withSessionAdvisoryLock(this.sql, 'bank.ramp.offramp', offrampId, body)");
  });
});
