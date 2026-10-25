'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  CAMPAIGN_TYPES,
  PARKED_CAMPAIGN_TYPES,
  type Campaign,
  type CampaignDefinitionInput,
  type CampaignGate,
  type ParticipationRules,
} from '@intafaced/contracts/campaigns-catalogue';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { fetchCampaignDetail, postCampaignChange } from '@/lib/campaigns-ops/builder-browser';
import {
  BUILDER_STEPS,
  GATE_FIELD_LABEL,
  MOVE_LABEL,
  STEP_LABEL,
  definitionOf,
  movesFor,
  parseRegions,
  resumeStep,
  type BuilderStep,
  type CampaignDeskReply,
  type CampaignDetailView,
} from '@/lib/campaigns-ops/builder-model';
import type { Part } from '@/lib/desk/part';
import { CampaignOutcome, PartFailed, StateChip } from '@/components/campaigns-desk';
import './desk.css';

/**
 * CAMPAIGN BUILDER (CM-campaign-types-02, CM-eligibility-rules-01 and -03, CM-campaign-admin-03; J-campaigns-16 #2, #3, #5,
 * #7, #8).
 *
 * Each step saves the draft in svc-campaigns as a new revision, so a founder who leaves comes back to the first step that
 * is still blank. The check lists every blank by its code from the service's own activation gate; asking for approval,
 * approving and taking it live are the service's moves, refused by name. The person who wrote or asked cannot approve.
 * Times are typed and shown in UTC, as everywhere on this console.
 */

const EXCLUSIONS: { value: ParticipationRules['exclusions'][number]; label: string }[] = [
  { value: 'business', label: 'Business accounts' },
  { value: 'institution', label: 'Institutional accounts' },
  { value: 'market_maker', label: 'Market makers (identity holds no such mark: refuses until it does)' },
  { value: 'staff', label: 'Staff (identity holds no such mark: refuses until it does)' },
];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/** `2026-10-25T10:00:00.000Z` as the `datetime-local` value typed in UTC; blank stays blank. */
const typedUtc = (iso: string | null) => (iso ? iso.slice(0, 16) : '');
/** A typed UTC `datetime-local` back to an instant with its offset; blank is null, an unreadable value is undefined. */
function instantOf(value: string): string | null | undefined {
  if (!value.trim()) return null;
  const ms = Date.parse(`${value.length === 16 ? `${value}:00` : value}Z`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

type Fields = {
  name: string;
  type: string;
  rules: string;
  exclusions: ParticipationRules['exclusions'];
  regionScope: ParticipationRules['regionScope'];
  regions: string;
  startsAt: string;
  endsAt: string;
  weekdays: number[];
  hoursFrom: string;
  hoursTo: string;
  budgetAsset: string;
  budgetLimit: string;
  rewardAsset: string;
  rewardAmount: string;
};

const fieldsOf = (c: Campaign | null): Fields => ({
  name: c?.name ?? '',
  type: c?.type ?? 'task',
  rules: c?.rules ?? '',
  exclusions: c?.participation?.exclusions ?? [],
  regionScope: c?.participation?.regionScope ?? 'platform',
  regions: c?.participation?.restrictedRegions?.join(', ') ?? '',
  startsAt: typedUtc(c?.startsAt ?? null),
  endsAt: typedUtc(c?.endsAt ?? null),
  weekdays: c?.windows.weekdays ?? [],
  hoursFrom: c?.windows.hours?.from ?? '',
  hoursTo: c?.windows.hours?.to ?? '',
  budgetAsset: c?.budget?.asset ?? '',
  budgetLimit: c?.budget?.limit ?? '',
  rewardAsset: c?.reward?.asset ?? '',
  rewardAmount: c?.reward?.amount ?? '',
});

const local = (body: string): CampaignDeskReply => ({
  ok: false,
  title: 'That step is not complete',
  body,
  next: 'Nothing was saved. Correct it and save again.',
  code: null,
  changed: 'no',
});

/** The fields one step owns, laid over the stored definition, so a step never blanks another step's answers. */
function patchFor(step: BuilderStep, f: Fields): Partial<CampaignDefinitionInput> | string {
  switch (step) {
    case 'basics':
      return { name: f.name.trim(), type: f.type, rules: f.rules };
    case 'who': {
      const regions = parseRegions(f.regions);
      if (!regions.ok) return `"${regions.bad}" is not a two-letter region code (ISO 3166, for example DE).`;
      return {
        participation: {
          exclusions: f.exclusions,
          regionScope: f.regionScope,
          // A listed campaign with no region typed stays blank, and the gate refuses it by name: never "no region".
          restrictedRegions: f.regionScope === 'listed' && regions.regions.length > 0 ? regions.regions : null,
        },
      };
    }
    case 'time': {
      const startsAt = instantOf(f.startsAt);
      const endsAt = instantOf(f.endsAt);
      if (startsAt === undefined || endsAt === undefined) return 'A start or end time could not be read.';
      if ((f.hoursFrom === '') !== (f.hoursTo === '')) return 'Daily hours need both a from and a to time, or neither.';
      return {
        startsAt,
        endsAt,
        weekdays: f.weekdays.length > 0 ? [...f.weekdays].sort((a, b) => a - b) : null,
        hours: f.hoursFrom ? { from: f.hoursFrom, to: f.hoursTo } : null,
      };
    }
    case 'money':
      // Blank stays blank: the gate names a blank budget or reward, and svc-campaigns checks every amount.
      return {
        budget: f.budgetAsset.trim() || f.budgetLimit.trim() ? { asset: f.budgetAsset.trim(), limit: f.budgetLimit.trim() } : null,
        reward: f.rewardAsset.trim() || f.rewardAmount.trim() ? { asset: f.rewardAsset.trim(), amount: f.rewardAmount.trim() } : null,
      };
    case 'review':
      return {};
  }
}

const nextStep = (step: BuilderStep): BuilderStep => BUILDER_STEPS[Math.min(BUILDER_STEPS.indexOf(step) + 1, BUILDER_STEPS.length - 1)]!;

function Gate({ gate }: { gate: Part<CampaignGate> | null }) {
  if (!gate) return null;
  if (gate.kind === 'failed') return <PartFailed title="The check could not be read" message={gate.message} code={gate.code} />;
  if (gate.data.missing.length === 0)
    return (
      <p className="dk-muted" data-testid="campaign-gate-clear">
        Nothing is blank: this revision may be sent for approval.
      </p>
    );
  return (
    <div data-testid="campaign-gate">
      <p>This revision cannot go live until each of these is set:</p>
      <ul>
        {gate.data.missing.map((m) => (
          <li key={`${m.code}:${m.field}`} data-testid="campaign-gate-blank" data-code={m.code} data-field={m.field}>
            {GATE_FIELD_LABEL[m.field] ?? m.field} <span className="dk-muted">({m.code})</span>
          </li>
        ))}
      </ul>
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
      <dd data-testid="campaign-revision">{c.revision}</dd>
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
      <dt>Time frame (UTC)</dt>
      <dd>{c.startsAt && c.endsAt ? `${formatWhen(c.startsAt)} to ${formatWhen(c.endsAt)}` : 'Not set'}</dd>
      <dt>Budget</dt>
      <dd>{c.budget ? `${c.budget.left} left of ${c.budget.limit} ${c.budget.asset}` : 'Not set'}</dd>
      <dt>Reward</dt>
      <dd>{c.reward ? `${c.reward.amount} ${c.reward.asset}` : 'Not set'}</dd>
    </dl>
  );
}

export function CampaignBuilder({ initial }: { initial: CampaignDetailView | null }) {
  const router = useRouter();
  const first = initial?.campaign.kind === 'ok' ? initial.campaign.data : null;
  const [view, setView] = useState(initial);
  const [campaign, setCampaign] = useState<Campaign | null>(first);
  const [step, setStep] = useState<BuilderStep>(first ? resumeStep(first) : 'basics');
  const [fields, setFields] = useState<Fields>(fieldsOf(first));
  const [reply, setReply] = useState<CampaignDeskReply | null>(null);
  const [busy, setBusy] = useState(false);
  // True once the form answers typing: a value typed before then would not reach a save.
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const set = (patch: Partial<Fields>) => setFields((f) => ({ ...f, ...patch }));

  const reload = useCallback(async (id: string) => {
    const next = await fetchCampaignDetail(id);
    setView(next);
    if (next?.campaign.kind === 'ok' && next.campaign.data) {
      setCampaign(next.campaign.data);
      setFields(fieldsOf(next.campaign.data));
    }
  }, []);

  const editable = campaign === null || campaign.state === 'draft';

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const patch = patchFor(step, fields);
    if (typeof patch === 'string') {
      setReply(local(patch));
      return;
    }
    setBusy(true);
    const answer = campaign
      ? await postCampaignChange({
          op: 'update',
          id: campaign.id,
          revision: campaign.revision,
          definition: { ...definitionOf(campaign), ...patch },
        })
      : await postCampaignChange({ op: 'create', definition: { name: fields.name.trim(), type: fields.type, rules: fields.rules } });
    setReply(answer);
    if (answer.ok) {
      setCampaign(answer.campaign);
      setStep(nextStep(step));
      if (!campaign) router.replace(`/more-ops/campaigns/builder?id=${encodeURIComponent(answer.campaign.id)}`);
      await reload(answer.campaign.id);
    } else if (campaign) await reload(campaign.id);
    setBusy(false);
  };

  const move = async (action: ReturnType<typeof movesFor>[number]) => {
    if (!campaign) return;
    setBusy(true);
    const answer = await postCampaignChange({ op: 'move', id: campaign.id, action, revision: campaign.revision });
    setReply(answer);
    await reload(campaign.id);
    setBusy(false);
  };

  const missing = view?.campaign.kind === 'ok' && view.campaign.data === null;
  return (
    <div className="dk" data-testid="campaign-builder" data-step={step} data-campaign-id={campaign?.id ?? ''} data-ready={ready}>
      <div className="adm-pagehead">
        <div>
          <h1>{campaign ? campaign.name : 'New campaign'}</h1>
          <p>
            Every step saves the draft. Leave at any point: the draft is listed on the desk and resumes at the first step still blank. A
            second founder approves the revision before it goes live.
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
      <nav aria-label="Builder steps" className="dk-row" data-testid="campaign-steps">
        {BUILDER_STEPS.map((s) => (
          <button
            key={s}
            type="button"
            className="adm-btn"
            aria-current={s === step ? 'step' : undefined}
            disabled={(!campaign && s !== 'basics') || busy}
            onClick={() => setStep(s)}
          >
            {STEP_LABEL[s]}
          </button>
        ))}
      </nav>
      <CampaignOutcome reply={reply} />
      {campaign && <Summary c={campaign} />}
      {!editable && step !== 'review' && (
        <p className="dk-muted" data-testid="campaign-not-draft">
          Only a draft is edited. This campaign is past draft, so its definition is read-only here.
        </p>
      )}

      {step !== 'review' && (
        <form onSubmit={save} aria-label={STEP_LABEL[step]} data-testid={`campaign-step-${step}`}>
          <fieldset disabled={!editable || busy}>
            <legend>{STEP_LABEL[step]}</legend>
            {step === 'basics' && (
              <>
                <div className="adm-field">
                  <label htmlFor="cmp-name">Name</label>
                  <input id="cmp-name" value={fields.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} />
                  <p className="dk-muted">The name is the campaign&apos;s key: two campaigns never share one.</p>
                </div>
                <div className="adm-field">
                  <label htmlFor="cmp-type">Type</label>
                  <select id="cmp-type" value={fields.type} onChange={(e) => set({ type: e.target.value })}>
                    {CAMPAIGN_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {(PARKED_CAMPAIGN_TYPES as readonly string[]).includes(t) ? `${t} (parked: waits for an owner decision)` : t}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="adm-field">
                  <label htmlFor="cmp-rules">Rules customers read</label>
                  <textarea
                    id="cmp-rules"
                    rows={4}
                    maxLength={4000}
                    value={fields.rules}
                    onChange={(e) => set({ rules: e.target.value })}
                  />
                </div>
              </>
            )}
            {step === 'who' && (
              <>
                <fieldset className="adm-field">
                  <legend>Who cannot take part</legend>
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
                      checked={fields.regionScope === 'platform'}
                      onChange={() => set({ regionScope: 'platform' })}
                    />{' '}
                    Every region the platform serves
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="cmp-scope"
                      checked={fields.regionScope === 'listed'}
                      onChange={() => set({ regionScope: 'listed' })}
                    />{' '}
                    Every region except a restricted list
                  </label>
                </fieldset>
                {fields.regionScope === 'listed' && (
                  <div className="adm-field">
                    <label htmlFor="cmp-regions">Restricted regions</label>
                    <input
                      id="cmp-regions"
                      value={fields.regions}
                      placeholder="DE, FR"
                      onChange={(e) => set({ regions: e.target.value })}
                    />
                    <p className="dk-muted">Two-letter codes. The list is a compliance value: left blank, the campaign cannot go live.</p>
                  </div>
                )}
              </>
            )}
            {step === 'time' && (
              <>
                <div className="dk-row">
                  <div className="adm-field">
                    <label htmlFor="cmp-starts">Starts (UTC)</label>
                    <input
                      id="cmp-starts"
                      type="datetime-local"
                      value={fields.startsAt}
                      onChange={(e) => set({ startsAt: e.target.value })}
                    />
                  </div>
                  <div className="adm-field">
                    <label htmlFor="cmp-ends">Ends (UTC)</label>
                    <input id="cmp-ends" type="datetime-local" value={fields.endsAt} onChange={(e) => set({ endsAt: e.target.value })} />
                  </div>
                </div>
                <fieldset className="adm-field">
                  <legend>Weekdays (none ticked: every day, in the platform time zone)</legend>
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
              </>
            )}
            {step === 'money' && (
              <>
                <div className="dk-row">
                  <div className="adm-field">
                    <label htmlFor="cmp-budget-limit">Budget limit</label>
                    <input
                      id="cmp-budget-limit"
                      inputMode="decimal"
                      value={fields.budgetLimit}
                      onChange={(e) => set({ budgetLimit: e.target.value })}
                    />
                  </div>
                  <div className="adm-field">
                    <label htmlFor="cmp-budget-asset">Budget asset</label>
                    <input
                      id="cmp-budget-asset"
                      maxLength={12}
                      value={fields.budgetAsset}
                      onChange={(e) => set({ budgetAsset: e.target.value })}
                    />
                  </div>
                </div>
                <p className="dk-muted">
                  The most the campaign may ask the reward pot for. It is a limit, not a balance: nothing is reserved or paid until a
                  customer qualifies.
                </p>
                <div className="dk-row">
                  <div className="adm-field">
                    <label htmlFor="cmp-reward-amount">Reward per customer</label>
                    <input
                      id="cmp-reward-amount"
                      inputMode="decimal"
                      value={fields.rewardAmount}
                      onChange={(e) => set({ rewardAmount: e.target.value })}
                    />
                  </div>
                  <div className="adm-field">
                    <label htmlFor="cmp-reward-asset">Reward asset</label>
                    <input
                      id="cmp-reward-asset"
                      maxLength={12}
                      value={fields.rewardAsset}
                      onChange={(e) => set({ rewardAsset: e.target.value })}
                    />
                  </div>
                </div>
              </>
            )}
            <div className="dk-row">
              <button type="submit" className="adm-btn" data-variant="primary">
                {campaign ? 'Save and continue' : 'Save the draft and continue'}
              </button>
            </div>
          </fieldset>
        </form>
      )}

      {step === 'review' && campaign && (
        <section aria-labelledby="cmp-review-h" data-testid="campaign-step-review">
          <h2 id="cmp-review-h">{STEP_LABEL.review}</h2>
          <div className="dk-row">
            <button type="button" className="adm-btn" disabled={busy} onClick={() => void reload(campaign.id)}>
              Check what is missing
            </button>
          </div>
          <Gate gate={view?.gate ?? null} />
          <div className="dk-row" data-testid="campaign-moves">
            {movesFor(campaign.state).map((m) => (
              <button key={m} type="button" className="adm-btn" data-move={m} disabled={busy} onClick={() => void move(m)}>
                {MOVE_LABEL[m]}
              </button>
            ))}
          </div>
          {campaign.state === 'pending_approval' && (
            <p className="dk-muted" data-testid="campaign-waits-approval">
              Revision {campaign.revision} waits for a second founder. Whoever wrote it or asked for approval cannot approve it.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
