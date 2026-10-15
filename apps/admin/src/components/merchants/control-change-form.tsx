'use client';

import { useEffect, useRef, useState } from 'react';
import type { MerchantControlChangeResult, MerchantControlProfile } from '@intafaced/contracts';
import { newRequestId, postControl } from '@/lib/merchants/control-client';
import {
  buildControlChange,
  CAP_KINDS,
  CAP_LABEL,
  CHANGE_KINDS,
  EMPTY_BAND,
  EMPTY_CAP,
  formFromProfile,
  makeHandoff,
  summariseControlChange,
  type ChangeErrors,
  type ChangeFormValues,
  type ChangeKindId,
  type ControlChange,
  type PricingRuleView,
  type SummaryLine,
  type TierView,
} from '@/lib/merchants/control-model';
import type { RefusalView } from '@/lib/merchants/registry-client';
import { CopyButton } from './copy-button';
import { Field, RefusalBlock, Section } from './registry-form';
import { StateBlock } from './ui';

type Stage = 'edit' | 'review' | 'done';

export interface ControlChangeFormProps {
  merchantId: string;
  profile: MerchantControlProfile;
  tiers: readonly TierView[];
  /** False when the tier list could not be read: the tier change is then off rather than a free-text guess. */
  tiersReadable: boolean;
  merchantRules: readonly PricingRuleView[];
}

/**
 * Change one merchant's tier, caps, pricing or reserve.
 *
 * Two founders, always. Step 1 (this screen): you fill the form, read the change in words and submit it; it is
 * only RECORDED, nothing takes effect. Step 2 (another founder, in their own sign-in): they confirm it from
 * the pending-changes panel. The submit carries the version the form was loaded at, so a change made on stale
 * numbers comes back as a conflict, and it carries one request reference, so pressing it twice is safe.
 */
export function ControlChangeForm({ merchantId, profile, tiers, tiersReadable, merchantRules }: ControlChangeFormProps) {
  const [values, setValues] = useState<ChangeFormValues>(() => formFromProfile(profile, merchantRules));
  const [errors, setErrors] = useState<ChangeErrors>({});
  const [stage, setStage] = useState<Stage>('edit');
  const [built, setBuilt] = useState<{ change: ControlChange; reason: string; requestId: string } | null>(null);
  const [result, setResult] = useState<MerchantControlChangeResult | null>(null);
  const [refusal, setRefusal] = useState<RefusalView | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = useRef(false);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty.current && stage !== 'done') {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [stage]);

  const set = <K extends keyof ChangeFormValues>(key: K, value: ChangeFormValues[K]) => {
    dirty.current = true;
    setValues((v) => ({ ...v, [key]: value }));
  };

  function review(e: React.FormEvent) {
    e.preventDefault();
    const attempt = buildControlChange(values, merchantId);
    if (!attempt.ok) {
      setErrors(attempt.errors);
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    setErrors({});
    setRefusal(null);
    // A new reference for every distinct review: the same reference with a different change is refused by the service.
    setBuilt({ change: attempt.change, reason: attempt.reason, requestId: newRequestId() });
    setStage('review');
  }

  async function submit() {
    if (busy || !built) return;
    setBusy(true);
    setRefusal(null);
    const reply = await postControl({
      action: 'submit',
      requestId: built.requestId,
      merchantId,
      change: built.change,
      reason: built.reason,
      expectedVersion: profile.version,
    });
    setBusy(false);
    if (!reply.ok || !reply.result) {
      if (!reply.ok) setRefusal(reply.refusal);
      return;
    }
    dirty.current = false;
    setResult(reply.result);
    setStage('done');
  }

  if (stage === 'done' && built && result) {
    return (
      <SubmittedStage
        outcome={result.outcome}
        merchantId={merchantId}
        requestId={built.requestId}
        expectedVersion={profile.version}
        change={built.change}
        reason={built.reason}
        onAgain={() => {
          setStage('edit');
          setResult(null);
        }}
      />
    );
  }

  if (stage === 'review' && built) {
    return (
      <ReviewStage
        change={built.change}
        reason={built.reason}
        profile={profile}
        tiers={tiers}
        busy={busy}
        refusal={refusal}
        onSubmit={submit}
        onBack={() => {
          setStage('edit');
          setRefusal(null);
        }}
      />
    );
  }

  const fp = (key: string) => ({
    id: `rf-cc-${key}`,
    'aria-invalid': errors[key] ? (true as const) : undefined,
    'aria-describedby': errors[key] ? `rf-cc-${key}-err` : `rf-cc-${key}-hint`,
  });
  const kindInfo = CHANGE_KINDS.find((k) => k.id === values.kind)!;

  return (
    <form className="mp-form" onSubmit={review} noValidate aria-label="Change controls">
      <p className="mp-muted">
        Fields marked <span aria-hidden="true">*</span>
        <span className="mp-visually-hidden">with an asterisk</span> are required. Nothing here has a default number: a blank stays
        unconfigured and payments refuse.
      </p>

      <fieldset className="mp-section">
        <legend>What to change</legend>
        <div className="mp-pills" role="radiogroup" aria-label="What to change">
          {CHANGE_KINDS.map((k) => (
            <label key={k.id} className="mp-pill" data-on={values.kind === k.id ? 'true' : undefined}>
              <input
                type="radio"
                name="cc-kind"
                value={k.id}
                checked={values.kind === k.id}
                onChange={() => {
                  set('kind', k.id as ChangeKindId);
                  setErrors({});
                }}
              />
              <span>{k.label}</span>
            </label>
          ))}
        </div>
        <p className="mp-hint">{kindInfo.hint}</p>
      </fieldset>

      {values.kind === 'set_tier' ? (
        <Section title="Tier">
          <Field label="Tier" required k="cc-tierId" error={errors.tierId} hint="Only tiers an owner has already defined can be chosen.">
            <select
              className="mp-input"
              {...fp('tierId')}
              value={values.tierId}
              onChange={(e) => set('tierId', e.target.value)}
              disabled={!tiersReadable}
            >
              <option value="">
                {tiersReadable ? (tiers.length === 0 ? 'No tiers exist yet' : 'Choose a tier') : 'Tier list unavailable'}
              </option>
              {tiers.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.id}), {t.merchants} merchant{t.merchants === 1 ? '' : 's'}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Archetype"
            k="cc-archetypeId"
            error={errors.archetypeId}
            hint="Optional. Leave empty to use the tier’s own archetype."
          >
            <input
              className="mp-input"
              {...fp('archetypeId')}
              value={values.archetypeId}
              onChange={(e) => set('archetypeId', e.target.value)}
              autoComplete="off"
            />
          </Field>
        </Section>
      ) : null}

      {values.kind === 'set_caps' ? (
        <Section title="Caps">
          <div className="mp-field" data-wide="true">
            <p className="mp-hint">
              These caps replace every cap this merchant has now, including the ones it gets from its tier. List every cap you want.
            </p>
            {errors.caps ? (
              <span className="mp-error" role="alert">
                {errors.caps}
              </span>
            ) : null}
            <ul className="mp-rows">
              {values.caps.map((row, i) => (
                <li key={i} className="mp-rowedit">
                  <Field label="Limit on" required k={`caps.${i}.kind`} error={errors[`caps.${i}.kind`]} hint="What this cap limits.">
                    <select
                      className="mp-input"
                      id={`rf-caps.${i}.kind`}
                      aria-invalid={errors[`caps.${i}.kind`] ? true : undefined}
                      value={row.kind}
                      onChange={(e) =>
                        set(
                          'caps',
                          values.caps.map((r, j) => (j === i ? { ...r, kind: e.target.value as typeof row.kind } : r)),
                        )
                      }
                    >
                      <option value="">Choose…</option>
                      {CAP_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {CAP_LABEL[k]}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {row.kind !== 'beneficiaries_per_day' ? (
                    <Field
                      label="Asset"
                      required
                      k={`caps.${i}.assetCode`}
                      error={errors[`caps.${i}.assetCode`]}
                      hint="Asset code, like the one on its balance."
                    >
                      <input
                        className="mp-input"
                        id={`rf-caps.${i}.assetCode`}
                        aria-invalid={errors[`caps.${i}.assetCode`] ? true : undefined}
                        value={row.assetCode}
                        autoComplete="off"
                        onChange={(e) =>
                          set(
                            'caps',
                            values.caps.map((r, j) => (j === i ? { ...r, assetCode: e.target.value } : r)),
                          )
                        }
                      />
                    </Field>
                  ) : null}
                  <Field
                    label={row.kind === 'beneficiaries_per_day' ? 'How many' : 'Limit'}
                    required
                    k={`caps.${i}.limit`}
                    error={errors[`caps.${i}.limit`]}
                    hint={row.kind === 'beneficiaries_per_day' ? 'A whole number.' : 'An amount, digits and one dot.'}
                  >
                    <input
                      className="mp-input"
                      inputMode="decimal"
                      id={`rf-caps.${i}.limit`}
                      aria-invalid={errors[`caps.${i}.limit`] ? true : undefined}
                      value={row.limit}
                      autoComplete="off"
                      onChange={(e) =>
                        set(
                          'caps',
                          values.caps.map((r, j) => (j === i ? { ...r, limit: e.target.value } : r)),
                        )
                      }
                    />
                  </Field>
                  <button
                    type="button"
                    className="mp-btn mp-btn--small"
                    onClick={() =>
                      set(
                        'caps',
                        values.caps.filter((_, j) => j !== i),
                      )
                    }
                    disabled={values.caps.length <= 1}
                    title={values.caps.length <= 1 ? 'A change needs at least one cap.' : undefined}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="mp-btn mp-btn--small"
              onClick={() => set('caps', [...values.caps, { ...EMPTY_CAP }])}
              disabled={values.caps.length >= 32}
            >
              Add a cap
            </button>
          </div>
        </Section>
      ) : null}

      {values.kind === 'set_reserve' ? (
        <Section title="Reserve">
          <Field
            label="Percentage withheld (basis points)"
            k="cc-reserveBps"
            error={errors.reserveBps}
            hint="100 bps is 1%. Leave both fields empty to hold no reserve."
          >
            <input
              className="mp-input"
              inputMode="numeric"
              {...fp('reserveBps')}
              value={values.reserveBps}
              onChange={(e) => set('reserveBps', e.target.value)}
              autoComplete="off"
            />
          </Field>
          <Field label="Held for (days)" k="cc-holdDays" error={errors.holdDays} hint="Whole days, 0 to 365.">
            <input
              className="mp-input"
              inputMode="numeric"
              {...fp('holdDays')}
              value={values.holdDays}
              onChange={(e) => set('holdDays', e.target.value)}
              autoComplete="off"
            />
          </Field>
        </Section>
      ) : null}

      {values.kind === 'set_pricing' ? (
        <>
          <Section title="Rule">
            <Field
              label="Asset"
              required
              k="cc-pricingAsset"
              error={errors.pricingAsset}
              hint="The asset this fee rule prices. One rule per asset."
            >
              <input
                className="mp-input"
                {...fp('pricingAsset')}
                value={values.pricingAsset}
                onChange={(e) => set('pricingAsset', e.target.value)}
                autoComplete="off"
              />
            </Field>
            <Field
              label="Conversion spread (basis points)"
              k="cc-pricingSpread"
              error={errors.pricingSpread}
              hint="Only applied when converting. Leave empty for none."
            >
              <input
                className="mp-input"
                inputMode="numeric"
                {...fp('pricingSpread')}
                value={values.pricingSpread}
                onChange={(e) => set('pricingSpread', e.target.value)}
                autoComplete="off"
              />
            </Field>
            <Field
              label="Fraction kept by"
              required
              k="cc-pricingRounding"
              error={errors.pricingRounding}
              hint="Who keeps the leftover when a fee does not divide evenly. Recorded on every payment."
            >
              <select
                className="mp-input"
                {...fp('pricingRounding')}
                value={values.pricingRounding}
                onChange={(e) => set('pricingRounding', e.target.value as ChangeFormValues['pricingRounding'])}
              >
                <option value="">Choose…</option>
                <option value="platform">The platform</option>
                <option value="merchant">The merchant</option>
              </select>
            </Field>
          </Section>
          <Section title="Fee bands">
            <div className="mp-field" data-wide="true">
              <p className="mp-hint">
                Bands are picked by this merchant’s volume this month. Each band must start higher than the one before.
              </p>
              {errors.bands ? (
                <span className="mp-error" role="alert">
                  {errors.bands}
                </span>
              ) : null}
              <ul className="mp-rows">
                {values.bands.map((band, i) => (
                  <li key={i} className="mp-rowedit">
                    <Field
                      label="Starts at"
                      required
                      k={`bands.${i}.fromAmount`}
                      error={errors[`bands.${i}.fromAmount`]}
                      hint="Monthly volume where this band begins."
                    >
                      <input
                        className="mp-input"
                        inputMode="decimal"
                        id={`rf-bands.${i}.fromAmount`}
                        aria-invalid={errors[`bands.${i}.fromAmount`] ? true : undefined}
                        value={band.fromAmount}
                        autoComplete="off"
                        onChange={(e) =>
                          set(
                            'bands',
                            values.bands.map((b, j) => (j === i ? { ...b, fromAmount: e.target.value } : b)),
                          )
                        }
                      />
                    </Field>
                    <Field
                      label="Fee (basis points)"
                      required
                      k={`bands.${i}.feeBps`}
                      error={errors[`bands.${i}.feeBps`]}
                      hint="100 bps is 1%."
                    >
                      <input
                        className="mp-input"
                        inputMode="numeric"
                        id={`rf-bands.${i}.feeBps`}
                        aria-invalid={errors[`bands.${i}.feeBps`] ? true : undefined}
                        value={band.feeBps}
                        autoComplete="off"
                        onChange={(e) =>
                          set(
                            'bands',
                            values.bands.map((b, j) => (j === i ? { ...b, feeBps: e.target.value } : b)),
                          )
                        }
                      />
                    </Field>
                    <Field
                      label="Flat fee"
                      k={`bands.${i}.flatFee`}
                      error={errors[`bands.${i}.flatFee`]}
                      hint="Optional, added to the percentage."
                    >
                      <input
                        className="mp-input"
                        inputMode="decimal"
                        id={`rf-bands.${i}.flatFee`}
                        aria-invalid={errors[`bands.${i}.flatFee`] ? true : undefined}
                        value={band.flatFee}
                        autoComplete="off"
                        onChange={(e) =>
                          set(
                            'bands',
                            values.bands.map((b, j) => (j === i ? { ...b, flatFee: e.target.value } : b)),
                          )
                        }
                      />
                    </Field>
                    <button
                      type="button"
                      className="mp-btn mp-btn--small"
                      onClick={() =>
                        set(
                          'bands',
                          values.bands.filter((_, j) => j !== i),
                        )
                      }
                      disabled={values.bands.length <= 1}
                      title={values.bands.length <= 1 ? 'A rule needs at least one band.' : undefined}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="mp-btn mp-btn--small"
                onClick={() => set('bands', [...values.bands, { ...EMPTY_BAND }])}
                disabled={values.bands.length >= 64}
              >
                Add a band
              </button>
            </div>
          </Section>
        </>
      ) : null}

      <Section title="Why">
        <Field
          label="Reason"
          required
          k="cc-reason"
          error={errors.reason}
          hint="Recorded with the change and shown to the second founder. At least 3 characters."
          wide
        >
          <textarea className="mp-input" rows={3} {...fp('reason')} value={values.reason} onChange={(e) => set('reason', e.target.value)} />
        </Field>
      </Section>

      <RefusalBlock refusal={refusal} />
      <div className="mp-inline">
        <button type="submit" className="mp-btn mp-btn--primary" disabled={busy}>
          Review change
        </button>
        <span className="mp-hint">
          Version {profile.version} of this merchant’s controls. If someone changes them before you submit, the service refuses yours.
        </span>
      </div>
    </form>
  );
}

/** Step 1 of 2: the change in words, next to what is in force now. Nothing is sent until the founder presses submit. */
export function ReviewStage({
  change,
  reason,
  profile,
  tiers,
  busy = false,
  refusal = null,
  onSubmit,
  onBack,
}: {
  change: ControlChange;
  reason: string;
  profile: MerchantControlProfile;
  tiers: readonly TierView[];
  busy?: boolean;
  refusal?: RefusalView | null;
  onSubmit?: () => void;
  onBack?: () => void;
}) {
  const rows = summariseControlChange(change, tiers);
  const now = currentAsChange(change.kind, profile);
  const before = now ? summariseControlChange(now, tiers) : null;
  return (
    <div className="mp-review">
      <h2 className="mp-h2">Review before submitting</h2>
      <div className="mp-two">
        <div>
          <h3 className="mp-h3">In force now</h3>
          {before ? <Lines rows={before} /> : <p className="mp-warn">Not configured: payments refuse</p>}
        </div>
        <div>
          <h3 className="mp-h3">After the second founder confirms</h3>
          <Lines rows={rows} />
        </div>
      </div>
      <dl className="mp-kv mp-kv--summary">
        <div>
          <dt>Reason you gave</dt>
          <dd>
            <bdi>{reason}</bdi>
          </dd>
        </div>
      </dl>
      <ol className="mp-steps" aria-label="Approval steps">
        <li data-state="done">
          <span className="mp-steps__n" aria-hidden="true">
            1
          </span>
          <div>
            <strong>You review this change</strong>
            <p className="mp-muted">Read both columns above. Submitting only records the request; nothing takes effect.</p>
          </div>
        </li>
        <li data-state="todo">
          <span className="mp-steps__n" aria-hidden="true">
            2
          </span>
          <div>
            <strong>A second founder confirms</strong>
            <p className="mp-muted">A different founder must confirm it in their own sign-in. You cannot confirm your own change.</p>
          </div>
        </li>
      </ol>
      <RefusalBlock refusal={refusal} />
      <div className="mp-inline">
        <button type="button" className="mp-btn mp-btn--primary" onClick={onSubmit} disabled={busy}>
          {busy ? 'Submitting…' : 'Submit for the second founder'}
        </button>
        <button type="button" className="mp-btn" onClick={onBack} disabled={busy}>
          Back to edit
        </button>
      </div>
    </div>
  );
}

function Lines({ rows }: { rows: readonly SummaryLine[] }) {
  return (
    <dl className="mp-kv mp-kv--summary mp-kv--stack">
      {rows.map((row) => (
        <div key={row.key}>
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The current value of the section a change touches, as a change, so both sides read in the same words. Null = unconfigured. */
export function currentAsChange(kind: ChangeKindId, profile: MerchantControlProfile): ControlChange | null {
  if (kind === 'set_tier') return profile.tierId === null ? null : { kind, tierId: profile.tierId, archetypeId: profile.archetypeId };
  if (kind === 'set_caps') return profile.caps === null ? null : { kind, caps: profile.caps };
  if (kind === 'set_reserve') return profile.reserve === null ? null : { kind, reserve: profile.reserve };
  const own = profile.pricing?.filter((p) => p.layer === 'merchant');
  return own && own.length > 0 ? { kind, pricing: own } : null;
}

/** What the service answered to the submit, in plain English. `pending_second_approval` is the normal, successful answer. */
export function SubmittedStage({
  outcome,
  merchantId,
  requestId,
  expectedVersion,
  change,
  reason,
  onAgain,
}: {
  outcome: MerchantControlChangeResult['outcome'];
  merchantId: string;
  requestId: string;
  expectedVersion: string;
  change: ControlChange;
  reason: string;
  onAgain?: () => void;
}) {
  const again = (
    <button type="button" className="mp-btn" onClick={onAgain}>
      Start another change
    </button>
  );
  if (outcome === 'pending_second_approval') {
    const handoff = makeHandoff({ requestId, merchantId, expectedVersion, change, reason });
    return (
      <div className="mp-handoff" role="status" data-stage="waiting">
        <h2 className="mp-h2">Waiting for a second founder</h2>
        <p>
          Your change is <strong>recorded but not applied</strong>. Today’s values stay in force until a different founder confirms it.
        </p>
        <ol className="mp-steps" aria-label="Approval steps">
          <li data-state="done">
            <span className="mp-steps__n" aria-hidden="true">
              1
            </span>
            <div>
              <strong>You submitted it</strong>
              <p className="mp-hash">
                Request reference <code>{requestId}</code>
              </p>
            </div>
          </li>
          <li data-state="todo">
            <span className="mp-steps__n" aria-hidden="true">
              2
            </span>
            <div>
              <strong>Waiting for the second founder</strong>
              <p className="mp-muted">
                Send them the request below. They open this merchant’s Controls tab in their own sign-in, paste it into “Confirm a change
                from another founder”, read it and confirm or decline.
              </p>
              <CopyButton value={handoff} label="Copy request for the second founder" />
            </div>
          </li>
        </ol>
        <div className="mp-inline">{again}</div>
      </div>
    );
  }
  if (outcome === 'changed')
    return (
      <StateBlock kind="success" title="Changed" action={again}>
        The change is in force. Reload the page to see the new values.
      </StateBlock>
    );
  if (outcome === 'noop')
    return (
      <StateBlock kind="info" title="Nothing to change" action={again}>
        These are already the values in force, so no request was recorded and no second founder is needed.
      </StateBlock>
    );
  if (outcome === 'conflict')
    return (
      <StateBlock kind="error" title="These controls changed while you were editing" action={again}>
        Someone saved a change after you opened this page, so submitting yours would overwrite theirs. Nothing was recorded. Reload the
        page, look at the new values and redo your change.
      </StateBlock>
    );
  return (
    <StateBlock kind="error" title="The service refused this change" action={again}>
      It did not record the change, for example because a tier no longer exists, a value failed the service’s own check, or a cap is listed
      twice. Nothing was changed. Review the values and try again.
    </StateBlock>
  );
}
