'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  CAMPAIGN_TYPES,
  PARKED_CAMPAIGN_TYPES,
  type Campaign,
  type CampaignAction,
  type CampaignDefinitionInput,
  type CampaignGate,
  type EarningRule,
  type ParticipationRules,
} from '@intafaced/contracts/campaigns-catalogue';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { isoToZonedInput, zonedInputToIso } from '@/lib/time-zone';
import { fetchCampaignDetail, postCampaignChange } from '@/lib/campaigns-ops/builder-browser';
import {
  BUILDER_STEPS,
  GATE_FIELD_LABEL,
  MOVES,
  PARKED_STEPS,
  STEP_LABEL,
  baseDefinition,
  blankSentence,
  editedView,
  isEditable,
  latestRevision,
  parseRegions,
  refusalSentence,
  resumeStep,
  type BuilderStep,
  type CampaignDeskReply,
  type CampaignDetailView,
} from '@/lib/campaigns-ops/builder-model';
import type { Part } from '@/lib/desk/part';
import { PartFailed, StateChip } from '@/components/campaigns-desk';
import { RuleBuilder } from '@/components/campaigns-rule-builder';
import { EarningRules } from '@/components/campaigns-earning-rules';
import { CampaignVouchers } from '@/components/campaigns-vouchers';
import './desk.css';

/**
 * CAMPAIGN BUILDER (CM-campaign-types-02, CM-eligibility-rules-01 and -03, CM-campaign-admin-03; J-campaigns-16 #2, #3, #5,
 * #7, #8, #9).
 *
 * Each tab saves the draft in svc-campaigns as a new revision, so a founder who leaves comes back to the first tab that
 * is still blank. "Check the draft" lists every blank of the saved draft by the service's own activation gate; "Ask to
 * activate" saves the open tab, names each blank by its code, and with none sends the revision for approval. A second
 * founder approves that revision and takes it live; whoever wrote or asked cannot. Rules and earning rules are parked
 * with their blocker until svc-campaigns has them.
 */

const TYPE_LABEL: Record<(typeof CAMPAIGN_TYPES)[number], string> = {
  referral: 'Referral',
  task: 'Task',
  voucher: 'Voucher',
  competition: 'Competition',
  milestone: 'Milestone',
  draw: 'Draw',
  pool: 'Pool',
  distribution: 'Distribution',
  trial_pass: 'Trial pass',
  gift_card: 'Gift card',
  points: 'Points programme',
  welcome: 'Welcome checklist',
};

const EXCLUSIONS: { value: ParticipationRules['exclusions'][number]; label: string }[] = [
  { value: 'business', label: 'Business accounts' },
  { value: 'institution', label: 'Institutional accounts' },
  { value: 'market_maker', label: 'Market makers (identity holds no such mark: refuses until it does)' },
  { value: 'staff', label: 'Staff (identity holds no such mark: refuses until it does)' },
];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

type Fields = {
  name: string;
  type: string;
  rules: string;
  exclusions: ParticipationRules['exclusions'];
  regionScope: ParticipationRules['regionScope'];
  regions: string;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  weekdays: number[];
  hoursFrom: string;
  hoursTo: string;
  asset: string;
  budget: string;
  perPerson: string;
  /** How many rewards one customer may take in each period, and the period in whole hours (CM-eligibility-rules-03). */
  perCustomerCount: string;
  perCustomerHours: string;
  /** The most rewards for everyone together; blank: the budget is the only cap. */
  totalRedemptions: string;
};

/** The zone stored times are shown in: the campaign's own, else the platform's, else UTC as this console shows times. */
const shownZone = (c: Campaign | null, platform: string | null) => c?.timeZone ?? platform ?? 'UTC';

const fieldsOf = (c: Campaign | null, platform: string | null): Fields => ({
  name: c?.name ?? '',
  type: c?.type ?? 'task',
  rules: c?.rules ?? '',
  exclusions: c?.participation?.exclusions ?? [],
  // A compliance list is asked for: a new rule set lists the regions that cannot take part, blank until typed.
  regionScope: c?.participation?.regionScope ?? 'listed',
  regions: c?.participation?.restrictedRegions?.join(', ') ?? '',
  startsAt: c?.startsAt ? isoToZonedInput(c.startsAt, shownZone(c, platform)) : '',
  endsAt: c?.endsAt ? isoToZonedInput(c.endsAt, shownZone(c, platform)) : '',
  timeZone: c && !c.timeZoneBlank ? (c.timeZone ?? '') : '',
  weekdays: c?.windows.weekdays ?? [],
  hoursFrom: c?.windows.hours?.from ?? '',
  hoursTo: c?.windows.hours?.to ?? '',
  asset: c?.budget?.asset ?? c?.reward?.asset ?? 'USDT',
  budget: c?.budget?.limit ?? '',
  perPerson: c?.reward?.amount ?? '',
  perCustomerCount: c?.limits?.perCustomer?.count ? String(c.limits.perCustomer.count) : '',
  perCustomerHours: c?.limits?.perCustomer?.periodSeconds ? String(Number((c.limits.perCustomer.periodSeconds / 3600).toFixed(4))) : '',
  totalRedemptions: c?.limits?.totalRedemptions ? String(c.limits.totalRedemptions) : '',
});

/** A whole number from 1 to `max` typed in a field, or null when blank; NaN when it is not one. */
const wholeOf = (raw: string, max: number): number | null => {
  const t = raw.trim();
  if (t === '') return null;
  const n = /^[1-9]\d*$/.test(t) ? Number(t) : NaN;
  return n <= max ? n : NaN;
};

/** A period typed in hours (a decimal is allowed) as whole seconds, from a minute to a year; null when blank. */
const periodOf = (raw: string): number | null => {
  const t = raw.trim();
  if (t === '') return null;
  const seconds = /^\d+(\.\d+)?$/.test(t) ? Math.round(Number(t) * 3600) : NaN;
  return seconds >= 60 && seconds <= 31_536_000 ? seconds : NaN;
};

type Outcome =
  | { kind: 'done'; text: string }
  | { kind: 'refused'; title: string; body: string; lines: readonly string[]; next: string; code: string | null };

type Refused = Extract<Outcome, { kind: 'refused' }>;

const refusedFrom = (reply: Extract<CampaignDeskReply, { ok: false }>, campaign: Campaign | null, me: string): Refused => ({
  kind: 'refused',
  title: reply.title,
  body: refusalSentence(reply.code, campaign, me) ?? reply.body,
  lines: [],
  next: reply.next,
  code: reply.code,
});

const local = (body: string): Outcome => ({
  kind: 'refused',
  title: 'That tab is not complete',
  body,
  lines: [],
  next: 'Nothing was saved. Correct it and try again.',
  code: null,
});

/** The fields one tab owns, laid over the stored definition, so a tab never blanks another tab's answers. */
function patchFor(step: BuilderStep, f: Fields, rule: ParticipationRules['rule']): Partial<CampaignDefinitionInput> | string | null {
  switch (step) {
    case 'basics':
      return { name: f.name.trim(), type: f.type, rules: f.rules };
    case 'who': {
      const regions = parseRegions(f.regions);
      if (!regions.ok) return `"${regions.bad}" is not a two-letter region code (ISO 3166, for example DE).`;
      return {
        participation: {
          ...(rule ? { rule } : {}),
          exclusions: f.exclusions,
          regionScope: f.regionScope,
          // A listed campaign with no region typed stays blank, and the gate refuses it by name: never "no region".
          restrictedRegions: f.regionScope === 'listed' && regions.regions.length > 0 ? regions.regions : null,
        },
      };
    }
    case 'time': {
      const typed = f.startsAt.trim() || f.endsAt.trim();
      if (typed && !f.timeZone) return 'Pick the time zone first: the start and end are read in it.';
      // A time that is not one in the zone (30 February, or one a clock change skips) refuses; it is never moved.
      const at = (typed: string) => (typed.trim() ? zonedInputToIso(typed, f.timeZone) : undefined);
      const startsAt = at(f.startsAt);
      const endsAt = at(f.endsAt);
      if (startsAt === null || endsAt === null) return `A start or end time is not a time in ${f.timeZone}.`;
      if ((f.hoursFrom === '') !== (f.hoursTo === '')) return 'Daily hours need both a from and a to time, or neither.';
      const asset = f.asset.trim().toUpperCase();
      const [count, period, total] = [
        wholeOf(f.perCustomerCount, 1_000_000),
        periodOf(f.perCustomerHours),
        wholeOf(f.totalRedemptions, 100_000_000),
      ];
      if (Number.isNaN(count)) return 'Rewards per customer is a whole number from 1 to 1,000,000, or blank.';
      if (Number.isNaN(period)) return 'The period is in hours, from one minute (0.0167) to a year (8,760), or blank.';
      if (Number.isNaN(total)) return 'Rewards in all is a whole number from 1 to 100,000,000, or blank.';
      // Blank stays blank: the gate names a blank budget or limit, and svc-campaigns checks every amount.
      return {
        startsAt: startsAt ?? null,
        endsAt: endsAt ?? null,
        timeZone: f.timeZone || null,
        weekdays: f.weekdays.length > 0 ? [...f.weekdays].sort((a, b) => a - b) : null,
        hours: f.hoursFrom ? { from: f.hoursFrom, to: f.hoursTo } : null,
        budget: f.budget.trim() ? { asset, limit: f.budget.trim() } : null,
        reward: f.perPerson.trim() ? { asset, amount: f.perPerson.trim() } : null,
        limits: {
          perCustomer: count === null && period === null ? null : { count, periodSeconds: period },
          totalRedemptions: total,
        },
      };
    }
    case 'rules':
    case 'earning':
      return null;
  }
}

const nextStep = (step: BuilderStep): BuilderStep => BUILDER_STEPS[Math.min(BUILDER_STEPS.indexOf(step) + 1, BUILDER_STEPS.length - 1)]!;

function StillMissing({ gate }: { gate: Part<CampaignGate> | null }) {
  if (!gate) return null;
  if (gate.kind === 'failed') return <PartFailed title="The check could not be read" message={gate.message} code={gate.code} />;
  if (gate.data.missing.length === 0)
    return (
      <p className="dk-muted" data-testid="campaign-gate-clear">
        Nothing is blank in the saved draft: it may be sent for approval.
      </p>
    );
  return (
    <div data-testid="campaign-gate">
      <p id="cmp-missing-h">Still missing in the saved draft. It cannot go live until each is set:</p>
      <ul aria-label="Still missing">
        {gate.data.missing.map((m) => (
          <li key={`${m.code}:${m.field}`} data-testid="campaign-gate-blank" data-code={m.code} data-field={m.field}>
            {GATE_FIELD_LABEL[m.field] ?? m.field} <span className="dk-muted">({m.code})</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function OutcomeBox({ outcome }: { outcome: Outcome | null }) {
  if (!outcome) return null;
  if (outcome.kind === 'done')
    return (
      <div className="adm-callout" role="status" data-tone="ok" data-testid="campaign-outcome">
        <strong>{outcome.text}</strong>
      </div>
    );
  return (
    <div className="adm-callout" role="alert" data-tone="danger" data-testid="campaign-outcome" data-code={outcome.code ?? ''}>
      <strong>{outcome.title}</strong>
      <p>{outcome.body}</p>
      {outcome.lines.length > 0 && (
        <ul>
          {outcome.lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      <p className="dk-muted">{outcome.next}</p>
      {outcome.code && <p className="dk-muted">Code: {outcome.code}</p>}
    </div>
  );
}

function Summary({ c }: { c: Campaign }) {
  return (
    <dl className="dk-kv" data-testid="campaign-summary">
      <dt>State</dt>
      <dd>
        <StateChip state={c.state} />
      </dd>
      <dt>Revision</dt>
      <dd data-testid="campaign-revision">Revision {c.revision}</dd>
      <dt>Next revision</dt>
      <dd data-testid="campaign-pending">
        {c.pendingChange
          ? `Revision ${c.pendingChange.revision}, ${c.pendingChange.state === 'draft' ? 'a draft not yet sent for approval' : 'waiting for another founder to approve it'} (written by ${c.pendingChange.createdBy})`
          : 'None: an edit of a live campaign is saved here as the next revision'}
      </dd>
      <dt>Written by</dt>
      <dd className="dk-packet">{c.createdBy}</dd>
      <dt>Approval asked by</dt>
      <dd className="dk-packet" data-testid="campaign-submitted-by">
        {c.submittedBy ?? 'Not asked yet'}
      </dd>
      <dt>Approved by</dt>
      <dd className="dk-packet" data-testid="campaign-approved-by">
        {c.approvedBy ?? 'Not approved'}
      </dd>
      <dt>Time frame</dt>
      <dd>{c.startsAt && c.endsAt ? `${formatWhen(c.startsAt)} to ${formatWhen(c.endsAt)} (UTC)` : 'Not set'}</dd>
      <dt>Time zone</dt>
      <dd>{c.timeZone ?? 'Not set'}</dd>
      <dt>Budget</dt>
      <dd>{c.budget ? `${c.budget.left} left of ${c.budget.limit} ${c.budget.asset}` : 'Not set'}</dd>
      <dt>Reward per person</dt>
      <dd>{c.reward ? `${c.reward.amount} ${c.reward.asset}` : 'Not set'}</dd>
    </dl>
  );
}

export function CampaignBuilder({
  initial,
  platformTimeZone,
  me,
}: {
  initial: CampaignDetailView | null;
  platformTimeZone: string | null;
  me: string;
}) {
  const first = initial?.campaign.kind === 'ok' ? initial.campaign.data : null;
  const [view, setView] = useState(initial);
  const [campaign, setCampaign] = useState<Campaign | null>(first);
  const [step, setStep] = useState<BuilderStep>(first ? resumeStep(first) : 'basics');
  const [fields, setFields] = useState<Fields>(fieldsOf(first ? editedView(first) : null, platformTimeZone));
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  // True once the form answers typing: a value typed or a button pressed before then would be lost.
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const set = (patch: Partial<Fields>) => setFields((f) => ({ ...f, ...patch }));

  /**
   * Reads the campaign and its gate again. What the founder typed stays: the fields are read from the store only when the
   * builder opens. A read that fails keeps the last one on screen and says so.
   */
  const reload = useCallback(async (id: string) => {
    const next = await fetchCampaignDetail(id);
    if (!next) {
      setOutcome({
        kind: 'refused',
        title: 'svc-campaigns could not be read again',
        body: 'What is shown is from the last read. The check and the state may be out of date.',
        lines: [],
        next: 'Try again in a moment.',
        code: null,
      });
      return null;
    }
    setView(next);
    if (next.campaign.kind === 'ok' && next.campaign.data) setCampaign(next.campaign.data);
    return next;
  }, []);

  const editable = campaign === null || isEditable(campaign);

  /** Saves one tab's fields. Null when nothing was saved (refused, or a parked tab). */
  const saveTab = async (tab: BuilderStep): Promise<Campaign | null> => {
    const patch = patchFor(tab, fields, campaign ? baseDefinition(campaign).participation?.rule : null);
    if (patch === null) return campaign;
    if (typeof patch === 'string') {
      setOutcome(local(patch));
      return null;
    }
    const answer = campaign
      ? await postCampaignChange({
          op: 'update',
          id: campaign.id,
          revision: latestRevision(campaign),
          definition: { ...baseDefinition(campaign), ...patch },
        })
      : // A new draft's time zone is left for the founder to pick, so the check names it until they do.
        await postCampaignChange({
          op: 'create',
          definition: { name: fields.name.trim(), type: fields.type, rules: fields.rules, timeZone: null },
        });
    if (!answer.ok) {
      // Read again first, so the refusal is what stays on screen even when that read fails.
      if (campaign) await reload(campaign.id);
      setOutcome(refusedFrom(answer, campaign, me));
      return null;
    }
    setCampaign(answer.campaign);
    return answer.campaign;
  };

  const next = async (event: FormEvent) => {
    event.preventDefault();
    const from = step;
    setOutcome(null);
    // While the tab saves, no tab is selected: the next one opens only once the draft holds what this one asked.
    setSaving(true);
    const saved = editable ? await saveTab(from) : campaign;
    if (saved) setStep(nextStep(from));
    setSaving(false);
    // The new draft's address, without a route change: the builder already holds the draft it just saved.
    if (saved && !campaign) window.history.replaceState(null, '', `/more-ops/campaigns/builder?id=${encodeURIComponent(saved.id)}`);
    if (saved && editable) {
      const change = saved.pendingChange;
      setOutcome({
        kind: 'done',
        text: change
          ? `Saved as revision ${change.revision}. Revision ${saved.revision} stays live until another founder approves it.`
          : `Saved as revision ${saved.revision}.`,
      });
      await reload(saved.id);
    }
  };

  /** Puts a library revision on the campaign's rules: the draft, or the next revision of a live campaign. */
  const putRule = async (rule: NonNullable<ParticipationRules['rule']>) => {
    if (!campaign) return;
    const base = baseDefinition(campaign);
    if (!base.participation) {
      setOutcome(local('Set who can take part first: the rule is checked alongside the exclusions and the region list.'));
      return;
    }
    setBusy(true);
    const answer = await postCampaignChange({
      op: 'update',
      id: campaign.id,
      revision: latestRevision(campaign),
      definition: { ...base, participation: { ...base.participation, rule } },
    });
    if (answer.ok) {
      setCampaign(answer.campaign);
      setOutcome({
        kind: 'done',
        text: `Put ${rule.name}, revision ${rule.revision}, on the campaign as revision ${latestRevision(answer.campaign)}.`,
      });
      await reload(answer.campaign.id);
    } else setOutcome(refusedFrom(answer, campaign, me));
    setBusy(false);
  };

  /** Saves the earning rules: the draft, or the next revision of a live campaign. The tab shows a refusal itself. */
  const saveEarning = async (earning: EarningRule[]): Promise<CampaignDeskReply> => {
    if (!campaign)
      return {
        ok: false,
        title: 'No draft yet',
        body: 'Save the name and type first.',
        next: 'Nothing was saved.',
        code: null,
        changed: 'no',
      };
    const answer = await postCampaignChange({
      op: 'update',
      id: campaign.id,
      revision: latestRevision(campaign),
      definition: { ...baseDefinition(campaign), earning },
    });
    if (answer.ok) {
      setCampaign(answer.campaign);
      setOutcome({ kind: 'done', text: `Saved the earning rules as revision ${latestRevision(answer.campaign)}.` });
      await reload(answer.campaign.id);
    }
    return answer;
  };

  const checkDraft = async () => {
    if (!campaign) {
      setOutcome(local('Save the name and type first: there is no draft to check yet.'));
      return;
    }
    setBusy(true);
    await reload(campaign.id);
    setChecked(true);
    setBusy(false);
  };

  const move = async (c: Campaign, action: CampaignAction, revision = c.revision): Promise<CampaignDeskReply> =>
    postCampaignChange({ op: 'move', id: c.id, action, revision });

  const askToActivate = async () => {
    if (!campaign) {
      setOutcome(local('Save the name and type first: there is no draft to send for approval yet.'));
      return;
    }
    setBusy(true);
    setOutcome(null);
    let current: Campaign | null = campaign;
    if (isEditable(campaign)) current = await saveTab(step);
    if (current) {
      const read = await reload(current.id);
      const gate = read?.gate;
      const asking = current.state === 'draft' || current.pendingChange !== null;
      if (asking && gate?.kind === 'ok' && gate.data.missing.length > 0) {
        setOutcome({
          kind: 'refused',
          title: 'This draft cannot go to approval yet',
          body: 'Each blank below has its own code. Set them and ask again.',
          lines: gate.data.missing.map(blankSentence),
          next: 'The draft is saved; nothing was sent for approval.',
          code: gate.data.missing[0]!.code,
        });
      } else {
        const answer = await move(current, 'submit', latestRevision(current));
        setOutcome(
          answer.ok
            ? { kind: 'done', text: `Asked for approval of revision ${latestRevision(answer.campaign)}. Another founder approves it.` }
            : refusedFrom(answer, current, me),
        );
        await reload(current.id);
      }
    }
    setBusy(false);
  };

  const runMove = async (action: (typeof MOVES)[number]['action']) => {
    if (!campaign) return;
    setBusy(true);
    setOutcome(null);
    const change = campaign.pendingChange;
    if (action === 'approve_live' && change) {
      // A change of a live campaign goes live as it is approved: the campaign keeps its state.
      const approved = await move(campaign, 'approve', change.revision);
      setOutcome(
        approved.ok
          ? { kind: 'done', text: `Approved revision ${change.revision}. It replaces revision ${campaign.revision} as the live one.` }
          : refusedFrom(approved, campaign, me),
      );
    } else if (action === 'approve_live') {
      const approved = await move(campaign, 'approve');
      if (!approved.ok) setOutcome(refusedFrom(approved, campaign, me));
      else {
        const live = await move(approved.campaign, 'activate');
        const revision = approved.campaign.revision;
        setOutcome(
          live.ok
            ? {
                kind: 'done',
                text:
                  live.campaign.state === 'scheduled' && live.campaign.startsAt
                    ? `Approved revision ${revision}. It is scheduled and goes live at ${formatWhen(live.campaign.startsAt)} (UTC).`
                    : `Approved revision ${revision}. It is live.`,
              }
            : { ...refusedFrom(live, approved.campaign, me), title: `Approved revision ${revision}, but it did not go live` },
        );
      }
    } else {
      const answer = await move(campaign, action);
      setOutcome(answer.ok ? { kind: 'done', text: `Done: ${answer.what}.` } : refusedFrom(answer, campaign, me));
    }
    await reload(campaign.id);
    setBusy(false);
  };

  const missing = view?.campaign.kind === 'ok' && view.campaign.data === null;
  const parked = PARKED_STEPS[step];
  return (
    <div className="dk" data-testid="campaign-builder" data-step={step} data-campaign-id={campaign?.id ?? ''} data-ready={ready}>
      <div className="adm-pagehead">
        <div>
          <h1>{campaign ? campaign.name : 'New campaign'}</h1>
          <p>
            Every tab saves the draft. Leave at any point: the draft is listed on the desk and resumes at the first tab still blank. A
            second founder approves the revision and takes it live.
          </p>
        </div>
      </div>
      <div className="dk-row">
        <Link href="/more-ops/campaigns">All campaigns</Link>
        {view && <span className="dk-asof">As of {formatAsOf(view.asOf)} (when this console read svc-campaigns)</span>}
      </div>
      {missing && <PartFailed title="No such campaign" message="svc-campaigns lists no campaign with this id." code="campaign.unknown" />}
      {view?.campaign.kind === 'failed' && (
        <PartFailed title="Campaign unavailable" message={view.campaign.message} code={view.campaign.code} />
      )}
      {campaign && <Summary c={campaign} />}

      <form onSubmit={(e) => void next(e)} aria-label="Campaign builder" data-testid={`campaign-step-${step}`}>
        <OutcomeBox outcome={outcome} />
        <div role="tablist" aria-label="Builder steps" className="dk-row" data-testid="campaign-steps">
          {BUILDER_STEPS.map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={!saving && s === step}
              className="adm-btn"
              data-active={!saving && s === step}
              disabled={!ready || (!campaign && s !== 'basics')}
              onClick={() => setStep(s)}
            >
              {STEP_LABEL[s]}
            </button>
          ))}
        </div>
        {!editable && (
          <p className="dk-muted" data-testid="campaign-not-draft">
            A draft, or an approved, scheduled, active or paused campaign, is edited. This campaign is in none of those states, so its
            definition is read-only here.
          </p>
        )}
        <fieldset disabled={!ready || busy || saving || !editable} role="tabpanel" aria-label={STEP_LABEL[step]}>
          {step === 'basics' && (
            <>
              <div className="adm-field">
                <label htmlFor="cmp-name">Name</label>
                <input id="cmp-name" value={fields.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} />
                <p className="dk-muted">The name is the campaign&apos;s key: two campaigns never share one.</p>
              </div>
              <fieldset className="adm-field">
                <legend>Type</legend>
                {CAMPAIGN_TYPES.map((t) => (
                  <label key={t}>
                    <input type="radio" name="cmp-type" value={t} checked={fields.type === t} onChange={() => set({ type: t })} />{' '}
                    {(PARKED_CAMPAIGN_TYPES as readonly string[]).includes(t)
                      ? `${TYPE_LABEL[t]} (parked: waits for an owner decision)`
                      : TYPE_LABEL[t]}
                  </label>
                ))}
              </fieldset>
              <div className="adm-field">
                <label htmlFor="cmp-rules">What customers read</label>
                <textarea id="cmp-rules" rows={4} maxLength={4000} value={fields.rules} onChange={(e) => set({ rules: e.target.value })} />
              </div>
            </>
          )}
          {step === 'who' && (
            <>
              <fieldset className="adm-field">
                <legend>Exclusions</legend>
                {EXCLUSIONS.map((x) => (
                  <label key={x.value}>
                    <input
                      type="checkbox"
                      checked={fields.exclusions.includes(x.value)}
                      onChange={(e) =>
                        set({
                          exclusions: e.target.checked ? [...fields.exclusions, x.value] : fields.exclusions.filter((v) => v !== x.value),
                        })
                      }
                    />{' '}
                    {x.label}
                  </label>
                ))}
              </fieldset>
              <fieldset className="adm-field">
                <legend>Regions</legend>
                <label>
                  <input
                    type="radio"
                    name="cmp-scope"
                    checked={fields.regionScope === 'listed'}
                    onChange={() => set({ regionScope: 'listed' })}
                  />{' '}
                  Every region except a restricted list
                </label>
                <label>
                  <input
                    type="radio"
                    name="cmp-scope"
                    checked={fields.regionScope === 'platform'}
                    onChange={() => set({ regionScope: 'platform' })}
                  />{' '}
                  Every region the platform serves, with no list of its own
                </label>
              </fieldset>
              {fields.regionScope === 'listed' && (
                <div className="adm-field">
                  <label htmlFor="cmp-regions">Restricted regions</label>
                  <input id="cmp-regions" value={fields.regions} onChange={(e) => set({ regions: e.target.value })} />
                  <p className="dk-muted">
                    Two-letter codes (ISO 3166), separated by commas. The list is a compliance value: left blank, the campaign cannot go
                    live.
                  </p>
                </div>
              )}
            </>
          )}
          {step === 'rules' && campaign && (
            <RuleBuilder
              campaignName={campaign.name}
              current={editedView(campaign).participation?.rule ?? null}
              disabled={!editable}
              onNotice={(n) => setOutcome(n.kind === 'done' ? n : { ...n, lines: [] })}
              onUse={(rule) => void putRule(rule)}
            />
          )}
          {step === 'earning' && campaign && (
            <EarningRules
              rules={editedView(campaign).earning}
              asset={editedView(campaign).reward?.asset ?? editedView(campaign).budget?.asset ?? null}
              disabled={!editable}
              onSave={(earning) => saveEarning(earning)}
            />
          )}
          {parked && (
            <section aria-label={`${STEP_LABEL[step]}: not built`} data-testid={`campaign-parked-${step}`}>
              <p>{parked.what}</p>
              <p className="dk-muted">Blocker: {parked.slice}. Nothing on this tab is saved, and the draft goes to approval without it.</p>
            </section>
          )}
          {step === 'time' && (
            <>
              <div className="adm-field">
                <label htmlFor="cmp-zone">Time zone</label>
                <select id="cmp-zone" value={fields.timeZone} onChange={(e) => set({ timeZone: e.target.value })}>
                  <option value="">Not set</option>
                  {platformTimeZone && <option value={platformTimeZone}>{platformTimeZone}</option>}
                </select>
                <p className="dk-muted">
                  {platformTimeZone
                    ? `The start, the end and the daily windows are read in this zone. In this version a campaign runs in the platform time zone, ${platformTimeZone}.`
                    : 'The platform time zone is not set (owner value CAMPAIGNS_PLATFORM_TIME_ZONE): no campaign time zone can be picked until it is.'}
                </p>
              </div>
              <div className="dk-row">
                <div className="adm-field">
                  <label htmlFor="cmp-starts">Starts</label>
                  <input
                    id="cmp-starts"
                    type="datetime-local"
                    value={fields.startsAt}
                    onChange={(e) => set({ startsAt: e.target.value })}
                  />
                </div>
                <div className="adm-field">
                  <label htmlFor="cmp-ends">Ends</label>
                  <input id="cmp-ends" type="datetime-local" value={fields.endsAt} onChange={(e) => set({ endsAt: e.target.value })} />
                </div>
              </div>
              <fieldset className="adm-field">
                <legend>Weekdays (none ticked: every day)</legend>
                {WEEKDAYS.map((d, i) => (
                  <label key={d}>
                    <input
                      type="checkbox"
                      checked={fields.weekdays.includes(i + 1)}
                      onChange={(e) =>
                        set({ weekdays: e.target.checked ? [...fields.weekdays, i + 1] : fields.weekdays.filter((v) => v !== i + 1) })
                      }
                    />{' '}
                    {d}
                  </label>
                ))}
              </fieldset>
              <div className="dk-row">
                <div className="adm-field">
                  <label htmlFor="cmp-hours-from">Daily from</label>
                  <input id="cmp-hours-from" type="time" value={fields.hoursFrom} onChange={(e) => set({ hoursFrom: e.target.value })} />
                </div>
                <div className="adm-field">
                  <label htmlFor="cmp-hours-to">Daily to</label>
                  <input id="cmp-hours-to" type="time" value={fields.hoursTo} onChange={(e) => set({ hoursTo: e.target.value })} />
                </div>
                <p className="dk-muted">Both blank: all day.</p>
              </div>
              <div className="dk-row">
                <div className="adm-field">
                  <label htmlFor="cmp-asset">Asset</label>
                  <input id="cmp-asset" maxLength={12} value={fields.asset} onChange={(e) => set({ asset: e.target.value })} />
                </div>
                <div className="adm-field">
                  <label htmlFor="cmp-budget">Budget, {fields.asset.trim().toUpperCase() || 'asset not set'}</label>
                  <input id="cmp-budget" inputMode="decimal" value={fields.budget} onChange={(e) => set({ budget: e.target.value })} />
                </div>
                <div className="adm-field">
                  <label htmlFor="cmp-per-person">Reward per person</label>
                  <input
                    id="cmp-per-person"
                    inputMode="decimal"
                    value={fields.perPerson}
                    onChange={(e) => set({ perPerson: e.target.value })}
                  />
                </div>
              </div>
              <div className="dk-row">
                <div className="adm-field">
                  <label htmlFor="cmp-per-customer">Rewards per customer</label>
                  <input
                    id="cmp-per-customer"
                    inputMode="numeric"
                    value={fields.perCustomerCount}
                    onChange={(e) => set({ perCustomerCount: e.target.value })}
                  />
                </div>
                <div className="adm-field">
                  <label htmlFor="cmp-per-customer-hours">In any period of, hours</label>
                  <input
                    id="cmp-per-customer-hours"
                    inputMode="numeric"
                    value={fields.perCustomerHours}
                    onChange={(e) => set({ perCustomerHours: e.target.value })}
                  />
                </div>
                <div className="adm-field">
                  <label htmlFor="cmp-total">Rewards in all</label>
                  <input
                    id="cmp-total"
                    inputMode="numeric"
                    value={fields.totalRedemptions}
                    onChange={(e) => set({ totalRedemptions: e.target.value })}
                  />
                </div>
              </div>
              <p className="dk-muted">
                One customer takes at most that many rewards (a reward, a welcome task or a voucher redemption each count once) in any
                period of that length; both must be set before the campaign can go live. Rewards in all, when set, caps everyone together;
                blank leaves the budget as the only cap.
              </p>
              <p className="dk-muted">
                The budget is the most the campaign may ask the reward pot for: a limit, not a balance. Nothing is reserved or paid until a
                customer qualifies. The reward per person is what one customer receives from this campaign, and the most they may: a task
                campaign pays it once per customer.
              </p>
            </>
          )}
          <div className="dk-row">
            <button type="submit" className="adm-btn" data-variant="primary">
              Next
            </button>
          </div>
        </fieldset>

        <section aria-labelledby="cmp-moves-h" data-testid="campaign-moves">
          <h2 id="cmp-moves-h">Check, approve and take live</h2>
          <div className="dk-row">
            <button type="button" className="adm-btn" disabled={!ready || busy} onClick={() => void checkDraft()}>
              Check the draft
            </button>
            <button type="button" className="adm-btn" data-variant="primary" disabled={!ready || busy} onClick={() => void askToActivate()}>
              Ask to activate
            </button>
            {MOVES.map((m) => (
              <button
                key={m.action}
                type="button"
                className="adm-btn"
                data-move={m.action}
                disabled={!ready || busy || !campaign}
                onClick={() => void runMove(m.action)}
              >
                {m.label}
              </button>
            ))}
          </div>
          {checked && <StillMissing gate={view?.gate ?? null} />}
          {campaign?.state === 'pending_approval' && (
            <p className="dk-muted" data-testid="campaign-waits-approval">
              Revision {campaign.revision} waits for a second founder. Whoever wrote it or asked for approval cannot approve it.
            </p>
          )}
        </section>
      </form>
      {campaign && campaign.type === 'voucher' && campaign.state !== 'draft' && <CampaignVouchers campaign={campaign} />}
    </div>
  );
}
