import { AUTHORITY_REACH } from '@/lib/console-status';

/**
 * The effective settings viewer (OPS-admin-access-08, ops-console-admin-access-037): what this console runs with, and every
 * owner setting that is blank, with the action it stops. It reads names and presence only: no secret is ever shown, and a
 * blank value is said to be blank, never filled in with a default.
 *
 * The console can read its own environment and nothing else's: each service keeps its own owner settings and refuses with
 * its own `*_unset` code, so those are listed where the service reports them (svc-edge's screening and network posture
 * below), and never guessed from here.
 *
 * Pure: the environment is an argument, so a test drives what a half-configured console shows.
 */

export interface SettingDef {
  readonly name: string;
  readonly what: string;
  /** What stops while this is blank. Null: blank is a legitimate value, it stops nothing. */
  readonly blocks: string | null;
  /** When blank, what the console does instead (for a setting whose blank is legitimate). */
  readonly blankMeans?: string;
  /** A secret is shown as set or blank only. A non-secret's value is shown as it is. */
  readonly secret: boolean;
}

/** Every environment setting this console reads (each is read in this app; a test pins the list to the code). */
export const CONSOLE_SETTINGS: readonly SettingDef[] = [
  {
    name: 'EDGE_URL',
    what: 'Where this console reaches the platform (svc-edge).',
    blocks: 'Founder sign-in and every read and control in this console.',
    secret: false,
  },
  {
    name: 'ADMIN_ORIGIN',
    what: 'The address founders open this console at; the session’s origin check.',
    blocks: 'Founder sign-in.',
    secret: false,
  },
  { name: 'ADMIN_SESSION_SECRET', what: 'The key that seals founder sessions.', blocks: 'Founder sign-in.', secret: true },
  {
    name: 'ADMIN_OPERATOR_TOKEN',
    what: 'The deployment’s module operator credential.',
    blocks: `${AUTHORITY_REACH.module} Also the live jurisdiction and compliance queue read.`,
    secret: true,
  },
  {
    name: 'ADMIN_TREASURY_TOKEN',
    what: 'The deployment’s treasury credential.',
    blocks: AUTHORITY_REACH.treasury,
    secret: true,
  },
  {
    name: 'ADMIN_MODULES',
    what: 'Which console modules are switched on.',
    blocks: null,
    blankMeans: 'Every module is on.',
    secret: false,
  },
  {
    name: 'ANALYTICS_REPLICA_CONFIGURED',
    what: 'Whether the analytics read replica is wired for the warehouse read.',
    blocks: 'The warehouse cubes on Operator tools (they refuse rather than show a number).',
    secret: false,
  },
  {
    name: 'ANALYTICS_REPLICA_LEDGER_URL',
    what: 'The analytics replica of the ledger.',
    blocks: 'The warehouse cubes on Operator tools.',
    secret: true,
  },
  {
    name: 'ANALYTICS_REPLICA_TRADE_URL',
    what: 'The analytics replica of trade.',
    blocks: 'The warehouse cubes on Operator tools.',
    secret: true,
  },
  {
    name: 'ANALYTICS_REPLICA_IDENTITY_URL',
    what: 'The analytics replica of identity.',
    blocks: 'The warehouse cubes on Operator tools.',
    secret: true,
  },
  {
    name: 'ANALYTICS_REPLICA_LAG_SECONDS',
    what: 'The replica lag the owner accepts.',
    blocks: 'Labelling a warehouse figure as live.',
    secret: false,
  },
  {
    name: 'ANALYTICS_ETL_WATERMARK_AT',
    what: 'When the warehouse load last completed.',
    blocks: 'Labelling a warehouse figure as live.',
    secret: false,
  },
];

export interface SettingRow {
  readonly name: string;
  readonly what: string;
  readonly state: 'set' | 'blank';
  /** The value, for a set non-secret only. */
  readonly value: string | null;
  /** What this blank setting stops; null when set, or when blank stops nothing. */
  readonly blocks: string | null;
  readonly blankMeans: string | null;
}

type Env = Readonly<Record<string, string | undefined>>;

export function settingRows(env: Env): readonly SettingRow[] {
  return CONSOLE_SETTINGS.map((def) => {
    const raw = (env[def.name] ?? '').trim();
    const set = raw.length > 0;
    return {
      name: def.name,
      what: def.what,
      state: set ? 'set' : 'blank',
      value: set && !def.secret ? raw : null,
      blocks: set ? null : def.blocks,
      blankMeans: set ? null : (def.blankMeans ?? null),
    };
  });
}

/** The blank settings that stop something, the list the page leads with. */
export const blockingBlanks = (rows: readonly SettingRow[]): readonly SettingRow[] => rows.filter((r) => r.state === 'blank' && r.blocks);

/** `INTAFACED_FLAG_*` overrides on this process, by name and value (a flag value is on or off, never a secret). */
export function flagOverrides(env: Env): readonly { readonly name: string; readonly value: string }[] {
  return Object.keys(env)
    .filter((name) => name.startsWith('INTAFACED_FLAG_') && env[name] !== undefined)
    .sort()
    .map((name) => ({ name, value: String(env[name]) }));
}

/** Staff counts by role and recent activity need a staff directory read the console does not have yet. */
export const STAFF_COUNTS_UNWIRED = {
  id: 'settings.staff-counts',
  label: 'Staff by role and recently active',
  reason:
    'No read lists console staff by role with their last activity (OPS-admin-access-03, role counts). Founders are the two identity founders; no count is shown rather than one made up.',
  code: 'ops.settings_read_unavailable',
} as const;
