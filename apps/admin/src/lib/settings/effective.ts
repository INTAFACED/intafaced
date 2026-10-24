import { parseFlagEnv } from '@intafaced/config';
import { AUTHORITY_REACH } from '@/lib/console-status';
import { hstsSettings } from '@/lib/security-headers.mjs';

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
  /**
   * For a value the console parses: why this value is not one it can use, or null when it can. A set value the reader
   * rejects stops the same action a blank one does, so it is listed with the blanks.
   */
  readonly check?: (raw: string) => string | null;
}

const isInstant = (raw: string) => (Number.isFinite(Date.parse(raw)) ? null : 'Not an ISO-8601 instant, so it is read as absent.');
const isSeconds = (raw: string) =>
  /^\d+(\.\d+)?$/.test(raw) && Number.isFinite(Number(raw)) ? null : 'Not a number of seconds, so it is read as unset.';

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
    check: (raw) => (raw === 'true' ? null : 'Only `true` turns the replica read on; any other value leaves it off.'),
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
    check: isSeconds,
  },
  {
    name: 'ANALYTICS_ETL_WATERMARK_AT',
    what: 'When the warehouse load last completed.',
    blocks: 'Labelling a warehouse figure as live.',
    secret: false,
    check: isInstant,
  },
  {
    name: 'ADMIN_BFF_SHARED_SECRET',
    what: 'A legacy front-door secret; the console only reports whether it is present.',
    blocks: null,
    blankMeans: 'Nothing changes: every page and route checks the founder session on its own.',
    secret: true,
  },
  {
    name: 'LAUNCH_DROP',
    what: 'The launch drop flags resolve at.',
    blocks: null,
    blankMeans: 'Drop 0: every drop-gated flag is off.',
    secret: false,
    check: (raw) =>
      ['0', 'I', 'II', 'III', 'IV', 'V'].includes(raw) ? null : 'Not a drop (0, I, II, III, IV or V); the console refuses to start.',
  },
  {
    name: 'HSTS_MAX_AGE_SECONDS',
    what: 'How long browsers keep this console on HTTPS only (the HSTS stage).',
    blocks: null,
    blankMeans: 'One day (86400 seconds), the first stage.',
    secret: false,
    check: (raw) =>
      hstsSettings({ HSTS_MAX_AGE_SECONDS: raw }).ok ? null : 'Not whole seconds up to two years; the console refuses to start.',
  },
  {
    name: 'HSTS_INCLUDE_SUBDOMAINS',
    what: 'Whether the HSTS stage covers subdomains.',
    blocks: null,
    blankMeans: 'Subdomains are not covered.',
    secret: false,
    check: (raw) => (hstsSettings({ HSTS_INCLUDE_SUBDOMAINS: raw }).ok ? null : 'Only `true` or `false`; the console refuses to start.'),
  },
];

export interface SettingRow {
  readonly name: string;
  readonly what: string;
  /** `invalid`: set to a value the console's reader does not accept. */
  readonly state: 'set' | 'blank' | 'invalid';
  /** The value, for a set (or invalid) non-secret only. */
  readonly value: string | null;
  /** What this blank or unusable setting stops; null when set, or when blank stops nothing. */
  readonly blocks: string | null;
  readonly blankMeans: string | null;
  /** Why an invalid value is not used. */
  readonly problem: string | null;
}

type Env = Readonly<Record<string, string | undefined>>;

export function settingRows(env: Env): readonly SettingRow[] {
  return CONSOLE_SETTINGS.map((def) => {
    const raw = (env[def.name] ?? '').trim();
    const set = raw.length > 0;
    const problem = set && def.check ? def.check(raw) : null;
    const usable = set && problem === null;
    return {
      name: def.name,
      what: def.what,
      state: usable ? 'set' : set ? 'invalid' : 'blank',
      value: set && !def.secret ? raw : null,
      blocks: usable ? null : def.blocks,
      blankMeans: set ? null : (def.blankMeans ?? null),
      problem,
    };
  });
}

/** The blank (or unusable) settings that stop something, the list the page leads with. */
export const blockingBlanks = (rows: readonly SettingRow[]): readonly SettingRow[] => rows.filter((r) => r.state !== 'set' && r.blocks);

export interface FlagOverride {
  readonly name: string;
  /** What the override resolves to, the way every service reads it (`parseFlagEnv`). */
  readonly resolved: 'on' | 'off';
  /** The raw value, when it is not one of the recognised words (it then resolves off). */
  readonly unrecognised: string | null;
}

/**
 * The `INTAFACED_FLAG_*` pins in force, from `readOperatorEnv().flagEnv` (the one scan of this process's flags). An empty
 * value is no pin, as `parseFlagEnv` reads it, so it is left out.
 */
export function flagOverrides(flagEnv: Readonly<Record<string, string>>): readonly FlagOverride[] {
  return Object.keys(flagEnv)
    .sort()
    .flatMap((name) => {
      const raw = flagEnv[name] ?? '';
      const pin = parseFlagEnv(raw);
      if (pin === undefined) return [];
      const known = ['1', 'true', 'on', 'yes', '0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase());
      return [{ name, resolved: pin ? 'on' : 'off', unrecognised: known ? null : raw }];
    });
}

/** Staff counts by role and recent activity need a staff directory read the console does not have yet. */
export const STAFF_COUNTS_UNWIRED = {
  id: 'settings.staff-counts',
  label: 'Staff by role and recently active',
  reason:
    'No read lists console staff by role with their last activity (OPS-admin-access-03, role counts). Founders are the two identity founders; no count is shown rather than one made up.',
  code: 'ops.settings_read_unavailable',
} as const;
