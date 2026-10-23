/**
 * The status page desk (SP-status-01, SP-status-05): what the founders define on svc-notify's public status page, what a
 * visitor reads there now, and the badge snippets another page can show. Pure and browser safe.
 *
 * Nothing here invents a state: a component's state, basis and reading come from `statusPage.read`, and a blank owner value
 * stays blank. A component with a `source` is an outside dependency whose readings a founder enters by hand.
 */
import {
  STATUS_COMPONENT_ID,
  STATUS_COMPONENTS_MAX,
  STATUS_PAGE_REASON_MAX,
  STATUS_STALENESS_SECONDS_MAX,
  STATUS_UPTIME_DAYS_MAX,
  statusPageSchema,
  type StatusComponentBasis,
  type StatusComponentDefinition,
  type StatusPage,
  type StatusPageState,
} from '@intafaced/contracts/status-page';
import type { Part } from '@/lib/desk/part';

export interface StatusDefinition {
  readonly components: readonly StatusComponentDefinition[];
  readonly componentCap: number | null;
  readonly stalenessSeconds: number | null;
  readonly uptimeDays: number | null;
  readonly challengeBits: number | null;
  readonly subscribeRatePerHour: number | null;
  readonly revision: number;
  readonly updatedAt: string | null;
  /** The public site address badge links are built on; null when svc-notify has none (NOTIFY_PUBLIC_ORIGIN). */
  readonly publicOrigin: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const intOrNull = (v: unknown): v is number | null => v === null || Number.isInteger(v);
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';

/** `statusPage.definition` and `statusPage.configure` answers; null for any other shape. */
export function readDefinition(raw: unknown): StatusDefinition | null {
  if (!isRecord(raw) || !Array.isArray(raw.components)) return null;
  const components: StatusComponentDefinition[] = [];
  for (const c of raw.components) {
    if (!isRecord(c) || typeof c.id !== 'string' || typeof c.name !== 'string' || !strOrNull(c.group) || !strOrNull(c.source)) return null;
    components.push({ id: c.id, name: c.name, group: c.group, source: c.source });
  }
  const { componentCap, stalenessSeconds, uptimeDays, challengeBits, subscribeRatePerHour, revision, updatedAt } = raw;
  // An svc-notify from before the address was added answers without it: no address, not an unreadable definition.
  const publicOrigin = raw.publicOrigin ?? null;
  if (
    !intOrNull(componentCap) ||
    !intOrNull(stalenessSeconds) ||
    !intOrNull(uptimeDays) ||
    !intOrNull(challengeBits) ||
    !intOrNull(subscribeRatePerHour) ||
    !Number.isInteger(revision) ||
    !strOrNull(updatedAt) ||
    !strOrNull(publicOrigin)
  )
    return null;
  return {
    components,
    componentCap,
    stalenessSeconds,
    uptimeDays,
    challengeBits,
    subscribeRatePerHour,
    revision: revision as number,
    updatedAt,
    publicOrigin,
  };
}

export { statusPageSchema };
export type { StatusPage };

export interface StatusDeskView {
  readonly definition: Part<StatusDefinition>;
  readonly page: Part<StatusPage>;
  readonly asOf: string;
}

/** What a founder sees after a change: the stored answer, or a refusal in words with whether anything changed. */
export type StatusDeskReply =
  | { readonly ok: true; readonly what: 'configured' | 'recorded' }
  | { readonly ok: false; readonly title: string; readonly body: string; readonly next: string; readonly changed: 'no' | 'unknown' };

export const STATE_WORDS: Readonly<Record<StatusPageState | 'none_defined', string>> = {
  operational: 'Operational',
  degraded: 'Degraded',
  partial_outage: 'Partial outage',
  major_outage: 'Major outage',
  maintenance: 'Maintenance',
  no_data: 'No data',
  none_defined: 'No components defined',
};

/** Why the page shows what it shows for one component, in a founder's words. */
export const BASIS_WORDS: Readonly<Record<StatusComponentBasis, string>> = {
  incident: 'set by an open incident',
  maintenance: 'set by a maintenance window in progress',
  reading: 'from its latest reading',
  no_reading: 'nothing has been read for it yet',
  stale: 'its latest reading is older than the staleness window',
  staleness_unset: 'the staleness window is not set, so no reading counts',
};

export const READING_STATES = ['operational', 'degraded', 'partial_outage', 'major_outage', 'maintenance'] as const;
export type ReadingState = (typeof READING_STATES)[number];

/** How long ago, in whole units, never in the future. `at` is the read time, so server and browser print the same. */
export function ageWords(observedAt: string, at: string): string {
  const ms = Date.parse(at) - Date.parse(observedAt);
  if (!Number.isFinite(ms)) return 'at an unknown time';
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}

/** One editable row. Blank group and source are null; ids follow the service's pattern. */
export interface ComponentDraft {
  readonly id: string;
  readonly name: string;
  readonly group: string;
  readonly source: string;
}

export const toDraft = (c: StatusComponentDefinition): ComponentDraft => ({
  id: c.id,
  name: c.name,
  group: c.group ?? '',
  source: c.source ?? '',
});

/** An owner value as typed: blank is null (cleared), anything else a whole number inside the service's bounds. */
function ownerValue(raw: string, max: number, label: string): { ok: true; value: number | null } | { ok: false; why: string } {
  const text = raw.trim();
  if (text === '') return { ok: true, value: null };
  if (!/^\d+$/.test(text)) return { ok: false, why: `${label} must be a whole number, or blank.` };
  const value = Number(text);
  if (value < 1 || value > max) return { ok: false, why: `${label} must be from 1 to ${max}, or blank.` };
  return { ok: true, value };
}

export interface DefinitionDraft {
  readonly components: readonly ComponentDraft[];
  readonly componentCap: string;
  readonly stalenessSeconds: string;
  readonly uptimeDays: string;
  readonly reason: string;
}

export type ConfigureBody = {
  readonly components: StatusComponentDefinition[];
  readonly componentCap: number | null;
  readonly stalenessSeconds: number | null;
  readonly uptimeDays: number | null;
  readonly expectedRevision: number;
  readonly reason: string;
};

/**
 * The change a founder asks for, checked before it leaves the browser. The service checks it again (and the cap), so this
 * only catches what can be said without it. Subscription safeguards are not part of this form and stay as they are.
 */
export function checkDefinition(
  draft: DefinitionDraft,
  expectedRevision: number,
): { ok: true; body: ConfigureBody } | { ok: false; why: string } {
  const components: StatusComponentDefinition[] = [];
  const seen = new Set<string>();
  if (draft.components.length > STATUS_COMPONENTS_MAX) return { ok: false, why: `At most ${STATUS_COMPONENTS_MAX} components.` };
  for (const [i, row] of draft.components.entries()) {
    const id = row.id.trim();
    const name = row.name.trim();
    if (!STATUS_COMPONENT_ID.test(id))
      return { ok: false, why: `Row ${i + 1}: the id is 2 to 40 lowercase letters, digits or dashes, starting with a letter.` };
    if (seen.has(id)) return { ok: false, why: `Row ${i + 1}: the id ${id} is used twice.` };
    seen.add(id);
    if (name === '' || name.length > 80) return { ok: false, why: `Row ${i + 1}: the name is 1 to 80 characters.` };
    const group = row.group.trim();
    const source = row.source.trim();
    if (group.length > 80 || source.length > 80) return { ok: false, why: `Row ${i + 1}: group and source are at most 80 characters.` };
    components.push({ id, name, group: group === '' ? null : group, source: source === '' ? null : source });
  }
  const cap = ownerValue(draft.componentCap, STATUS_COMPONENTS_MAX, 'The component cap');
  if (!cap.ok) return cap;
  const staleness = ownerValue(draft.stalenessSeconds, STATUS_STALENESS_SECONDS_MAX, 'The staleness window');
  if (!staleness.ok) return staleness;
  const uptime = ownerValue(draft.uptimeDays, STATUS_UPTIME_DAYS_MAX, 'The uptime window');
  if (!uptime.ok) return uptime;
  const reason = draft.reason.trim();
  if (reason === '' || reason.length > STATUS_PAGE_REASON_MAX)
    return { ok: false, why: `Write why (1 to ${STATUS_PAGE_REASON_MAX} characters); it is kept with the change.` };
  return {
    ok: true,
    body: {
      components,
      componentCap: cap.value,
      stalenessSeconds: staleness.value,
      uptimeDays: uptime.value,
      expectedRevision,
      reason,
    },
  };
}

/**
 * A reading entered by hand for an outside component: its state and the source the definition names. The console server
 * stamps the time when it sends it, so a founder's own clock never decides it.
 */
export function readingFor(component: StatusComponentDefinition, state: ReadingState) {
  if (component.source === null) return null;
  return { componentId: component.id, state, source: component.source };
}

const escapeAttr = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** The badge links for the whole page (`componentId` null) or one component, on the public site address. */
export function badgeSnippets(origin: string, componentId: string | null, name: string) {
  const site = origin.replace(/\/+$/, '');
  const image = `${site}/api/notify/status/badge.svg${componentId ? `?component=${encodeURIComponent(componentId)}` : ''}`;
  const page = `${site}/status`;
  const alt = `${name} status`;
  return {
    image,
    page,
    html: `<a href="${escapeAttr(page)}"><img src="${escapeAttr(image)}" alt="${escapeAttr(alt)}"></a>`,
    markdown: `[![${alt.replace(/[[\]]/g, '')}](${image})](${page})`,
  };
}
