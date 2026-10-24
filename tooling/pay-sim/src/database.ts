import { randomUUID } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { assertTestDatabase } from '@intafaced/db';
import { parseOptions } from './safety.js';

/** How long dropping the owned database may take: inside the CLI's 10 s cleanup allowance (cli.ts). */
const CLEANUP_MS = 9_000;

/** Owns exactly one randomly named database. Never lists or sweeps other databases. */
export class SimulationDatabase {
  readonly database = `pay_sim_${randomUUID().replaceAll('-', '')}_test`;
  private readonly admin: Sql;
  private client: Sql | undefined;
  private attemptedCreate = false;
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(private readonly adminUrl: string) {
    parseOptions([], { APP_ENV: process.env.APP_ENV, TEST_DATABASE_URL: adminUrl });
    this.admin = this.connect(adminUrl);
  }

  private connect(url: string, work = false, timeouts = { statement: 5000, lock: 1000 }): Sql {
    return postgres(url, {
      max: work ? 8 : 1,
      connect_timeout: 3,
      idle_timeout: 1,
      connection: {
        statement_timeout: timeouts.statement,
        lock_timeout: timeouts.lock,
        ...(work ? { search_path: 'pay,public', application_name: this.database } : {}),
      },
      onnotice: () => undefined,
    });
  }

  private check(): void {
    if (this.closed) throw new Error('pay-sim deadline cancelled database setup');
  }

  async open(): Promise<Sql> {
    this.check();
    await assertTestDatabase(this.admin, 'pay-sim admin');
    this.check();
    // The identifier contains only the fixed prefix, UUID hex and suffix.
    this.attemptedCreate = true;
    await this.admin.unsafe(`CREATE DATABASE "${this.database}"`);
    this.check();
    const url = new URL(this.adminUrl);
    url.pathname = `/${this.database}`;
    this.client = this.connect(url.toString(), true);
    const sql = this.client;
    await assertTestDatabase(sql, 'pay-sim owned database');
    this.check();
    await sql.unsafe('CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS citext; CREATE SCHEMA pay');
    this.check();
    return sql;
  }

  /** Idempotent, bounded, and restricted to the generated name even after lost CREATE ack. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = this.cleanup();
    return this.closing;
  }

  private async cleanup(): Promise<void> {
    // Stop all setup/work clients before dropping. This also cancels active SQL.
    await Promise.allSettled([this.admin.end({ timeout: 0 }), this.client?.end({ timeout: 0 })]);
    if (!this.attemptedCreate) return;
    // DROP DATABASE waits for a forced checkpoint, which on a busy shared test server (CI shards drop many databases
    // at once) can pass the setup clients' 5 s statement and 1 s lock timeouts. The drop gets most of the CLI's 10 s
    // cleanup allowance instead, so a slow server still confirms cleanup rather than reporting it unconfirmed.
    const cleanup = this.connect(this.adminUrl, false, { statement: CLEANUP_MS - 500, lock: CLEANUP_MS - 1000 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        cleanup.unsafe(`DROP DATABASE IF EXISTS "${this.database}" WITH (FORCE)`),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            void cleanup.end({ timeout: 0 });
            reject(new Error('pay-sim owned database cleanup deadline exceeded'));
          }, CLEANUP_MS);
        }),
      ]);
    } catch (error) {
      // The driver's error names a code and the database, never the URL or credentials.
      throw new Error('pay-sim could not confirm cleanup of its owned TEST DATA database', { cause: error });
    } finally {
      if (timer) clearTimeout(timer);
      await cleanup.end({ timeout: 0 });
    }
  }
}
