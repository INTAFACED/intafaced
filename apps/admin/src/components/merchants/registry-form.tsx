'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { dualControlChip } from '@/lib/merchants/chips';
import { postRegistry, type ApprovalView, type RefusalView } from '@/lib/merchants/registry-client';
import {
  buildChange,
  changedKeys,
  EMPTY_FORM,
  REGISTRY_INFO,
  summariseChange,
  type FieldErrors,
  type RegistryFormValues,
  type RegistryKind,
  type RegistryPreview,
} from '@/lib/merchants/registry-model';
import { CopyButton } from './copy-button';
import { StateBlock, StatusChip } from './ui';

type Stage = 'edit' | 'review' | 'saved';

export interface RegistryFormProps {
  kind: RegistryKind;
  mode: 'create' | 'edit';
  initial?: RegistryFormValues;
  /** The version the entry was loaded at; null creates. */
  expectedVersion: number | null;
  /** Fields that identify the entry and cannot change on edit. */
  lockedKeys?: readonly (keyof RegistryFormValues)[];
  listHref: string;
}

/**
 * Add or edit one registry entry.
 *
 * Three stages. Edit: type, with the same rules the service applies, shown next
 * to the field. Review: the service says whether a second founder is needed and
 * gives the hash the approval must be bound to. Dual control is two visible
 * steps: (1) you ask for approval, (2) the OTHER founder approves in their own
 * sign-in, then you save. Any edit after approval voids it, so Back is explicit.
 */
export function RegistryForm({ kind, mode, initial, expectedVersion, lockedKeys = [], listHref }: RegistryFormProps) {
  const info = REGISTRY_INFO[kind];
  const [values, setValues] = useState<RegistryFormValues>(initial ?? EMPTY_FORM);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [stage, setStage] = useState<Stage>('edit');
  const [change, setChange] = useState<Record<string, unknown> | null>(null);
  const [preview, setPreview] = useState<RegistryPreview | null>(null);
  const [approval, setApproval] = useState<ApprovalView | null>(null);
  const [refusal, setRefusal] = useState<RefusalView | null>(null);
  const [busy, setBusy] = useState<null | 'preview' | 'propose' | 'save'>(null);
  const dirty = useRef(false);
  const initialRef = useRef(initial ?? EMPTY_FORM);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty.current && stage !== 'saved') {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [stage]);

  const set = <K extends keyof RegistryFormValues>(key: K, value: RegistryFormValues[K]) => {
    dirty.current = true;
    setValues((v) => ({ ...v, [key]: value }));
  };
  const locked = (key: keyof RegistryFormValues) => lockedKeys.includes(key);

  async function review(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setRefusal(null);
    const built = buildChange(kind, values, expectedVersion);
    if (!built.ok) {
      setErrors(built.errors);
      // Focus the first invalid field in page order, once the errors have rendered.
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    setErrors({});
    setBusy('preview');
    const reply = await postRegistry({ action: 'preview', registry: kind, change: built.change });
    setBusy(null);
    if (!reply.ok || !reply.preview) {
      setRefusal(
        reply.ok
          ? {
              title: 'No answer to the review',
              body: 'The service did not say what this change needs.',
              next: 'Try again.',
              code: null,
              requestId: null,
            }
          : reply.refusal,
      );
      return;
    }
    setChange(built.change);
    setPreview(reply.preview);
    setApproval(null);
    setStage('review');
  }

  async function requestApproval() {
    if (busy || !change) return;
    setRefusal(null);
    setBusy('propose');
    const reply = await postRegistry({ action: 'propose', registry: kind, change });
    setBusy(null);
    if (!reply.ok) return setRefusal(reply.refusal);
    if (reply.approval) setApproval(reply.approval);
  }

  async function save() {
    if (busy || !change) return;
    setRefusal(null);
    setBusy('save');
    const body = approval?.operationId ? { ...change, approvalId: approval.approvalId, operationId: approval.operationId } : change;
    const reply = await postRegistry({ action: 'save', registry: kind, change: body });
    setBusy(null);
    if (!reply.ok) return setRefusal(reply.refusal);
    dirty.current = false;
    setStage('saved');
  }

  if (stage === 'saved') {
    return (
      <div className="mp-state" data-kind="success" role="status">
        <strong>Saved</strong>
        <p>
          The {info.singular} was saved and the change is in its history, with who made it
          {preview?.needsDualControl ? ' and who approved it' : ''}.
        </p>
        <div className="mp-state__action">
          <a className="mp-btn mp-btn--primary" href={listHref}>
            Back to {info.title.toLowerCase()}
          </a>
        </div>
      </div>
    );
  }

  if (stage === 'review' && change && preview) {
    const rows = summariseChange(kind, change);
    const changed = changedKeys(kind, mode === 'edit' ? changeFromValues(kind, initialRef.current, expectedVersion) : null, change);
    const needs = preview.needsDualControl;
    const approved = approval !== null;
    return (
      <div className="mp-review">
        <h2 className="mp-h2">Review before saving</h2>
        <dl className="mp-kv mp-kv--summary">
          {rows.map((row) => (
            <div key={row.key} data-changed={changed.has(row.key) ? 'true' : undefined}>
              <dt>{row.label}</dt>
              <dd>
                {row.value}
                {changed.has(row.key) && mode === 'edit' ? <span className="mp-changed"> changed</span> : null}
              </dd>
            </div>
          ))}
        </dl>

        <ol className="mp-steps" aria-label="Approval steps">
          <li data-state="done">
            <span className="mp-steps__n" aria-hidden="true">
              1
            </span>
            <div>
              <strong>You review this change</strong>
              <p>
                <StatusChip spec={dualControlChip(needs)} />
              </p>
              {needs ? (
                <ul className="mp-reasons">
                  {preview.reasons.map((r) => (
                    <li key={r}>{r.replace(/_/g, ' ')}</li>
                  ))}
                </ul>
              ) : (
                <p className="mp-muted">This change does not need a second founder.</p>
              )}
            </div>
          </li>
          {needs ? (
            <li data-state={approved ? 'done' : 'todo'}>
              <span className="mp-steps__n" aria-hidden="true">
                2
              </span>
              <div>
                <strong>A second founder approves</strong>
                <p className="mp-muted">
                  A different founder must approve this exact change in their own sign-in. You cannot approve it yourself. Approval is tied
                  to the hash below, so changing anything afterwards voids it.
                </p>
                <p className="mp-hash">
                  Hash <code>{preview.payloadHash}</code>
                </p>
                {!approved ? (
                  <button type="button" className="mp-btn mp-btn--primary" onClick={requestApproval} disabled={busy !== null}>
                    {busy === 'propose' ? 'Requesting…' : 'Request second-founder approval'}
                  </button>
                ) : (
                  <ApprovalHandoff kind={kind} change={change} approval={approval} />
                )}
              </div>
            </li>
          ) : null}
          <li data-state={needs && !approved ? 'blocked' : 'todo'}>
            <span className="mp-steps__n" aria-hidden="true">
              {needs ? 3 : 2}
            </span>
            <div>
              <strong>Save the change</strong>
              <p className="mp-muted">
                {needs
                  ? 'Once the second founder has approved, save. If they have not yet, the service refuses and nothing changes.'
                  : 'This writes the change and records who made it and why.'}
              </p>
              <div className="mp-inline">
                <button type="button" className="mp-btn mp-btn--primary" onClick={save} disabled={busy !== null || (needs && !approved)}>
                  {busy === 'save' ? 'Saving…' : 'Save change'}
                </button>
                <button
                  type="button"
                  className="mp-btn"
                  onClick={() => {
                    setStage('edit');
                    setRefusal(null);
                  }}
                  disabled={busy !== null}
                >
                  Back to edit
                </button>
              </div>
              {needs && !approved ? <p className="mp-hint">Save unlocks after you request approval in step 2.</p> : null}
            </div>
          </li>
        </ol>
        <RefusalBlock refusal={refusal} />
      </div>
    );
  }

  const fieldProps = (key: keyof RegistryFormValues) => ({
    id: `rf-${key}`,
    'aria-invalid': errors[key] ? (true as const) : undefined,
    'aria-describedby': errors[key] ? `rf-${key}-err` : `rf-${key}-hint`,
    disabled: locked(key),
  });

  return (
    <form className="mp-form" onSubmit={review} noValidate aria-label={`${mode === 'create' ? 'Add' : 'Edit'} ${info.singular}`}>
      <p className="mp-muted">
        Fields marked <span aria-hidden="true">*</span>
        <span className="mp-visually-hidden">with an asterisk</span> are required. Credentials, keys and secrets are never stored here.
      </p>

      {kind === 'venue' ? (
        <>
          <Section title="Identity">
            <Field
              label="Venue id"
              required
              error={errors.venueId}
              hint="Lowercase words joined by hyphens. Cannot change after creating."
              k="venueId"
            >
              <input
                className="mp-input"
                {...fieldProps('venueId')}
                value={values.venueId}
                onChange={(e) => set('venueId', e.target.value)}
                disabled={locked('venueId') || mode === 'edit'}
              />
            </Field>
            <Field label="Name" required error={errors.displayName} hint="What people see in lists." k="displayName">
              <input
                className="mp-input"
                {...fieldProps('displayName')}
                value={values.displayName}
                onChange={(e) => set('displayName', e.target.value)}
              />
            </Field>
          </Section>
          <Section title="Routing">
            <Field
              label="Mode"
              required
              error={errors.mode}
              hint="Disabled is never used. Testnet moves no real money. Live is not allowed yet."
              k="mode"
            >
              <select className="mp-input" {...fieldProps('mode')} value={values.mode} onChange={(e) => set('mode', e.target.value)}>
                <option value="disabled">Disabled</option>
                <option value="testnet">Testnet</option>
                <option value="live">Live (not allowed yet)</option>
              </select>
            </Field>
            <Field label="Priority" required error={errors.priority} hint="Lower numbers are tried first." k="priority">
              <input
                className="mp-input"
                inputMode="numeric"
                {...fieldProps('priority')}
                value={values.priority}
                onChange={(e) => set('priority', e.target.value)}
              />
            </Field>
            <SwitchField
              label="Switched on"
              hint={
                mode === 'create'
                  ? 'New entries start switched off. Switching one on is a separate change that needs a second founder.'
                  : 'Switching a venue on needs a second founder.'
              }
              checked={values.enabled}
              disabled={mode === 'create'}
              onChange={(v) => set('enabled', v)}
              id="rf-enabled"
            />
          </Section>
          <Section title="Limits and pairs">
            <Field
              label="Smallest order"
              error={errors.minOrder}
              hint="Leave blank for not configured. A venue with a blank limit is never routed to."
              k="minOrder"
            >
              <input
                className="mp-input"
                inputMode="decimal"
                {...fieldProps('minOrder')}
                value={values.minOrder}
                onChange={(e) => set('minOrder', e.target.value)}
              />
            </Field>
            <Field label="Largest order" error={errors.maxOrder} hint="Leave blank for not configured." k="maxOrder">
              <input
                className="mp-input"
                inputMode="decimal"
                {...fieldProps('maxOrder')}
                value={values.maxOrder}
                onChange={(e) => set('maxOrder', e.target.value)}
              />
            </Field>
            <Field
              label="Supported pairs"
              error={errors.supportedPairs}
              hint="BASE/QUOTE, separated by commas, for example USDT/USD, USDC/USD."
              k="supportedPairs"
              wide
            >
              <textarea
                className="mp-input"
                rows={2}
                {...fieldProps('supportedPairs')}
                value={values.supportedPairs}
                onChange={(e) => set('supportedPairs', e.target.value)}
              />
            </Field>
          </Section>
        </>
      ) : null}

      {kind === 'network' ? (
        <>
          <Section title="Identity">
            <Field
              label="Network id"
              required
              error={errors.networkId}
              hint="Lowercase words joined by hyphens. Cannot change after creating."
              k="networkId"
            >
              <input
                className="mp-input"
                {...fieldProps('networkId')}
                value={values.networkId}
                onChange={(e) => set('networkId', e.target.value)}
                disabled={locked('networkId') || mode === 'edit'}
              />
            </Field>
            <Field label="Name" required error={errors.displayName} hint="What people see in lists." k="displayName">
              <input
                className="mp-input"
                {...fieldProps('displayName')}
                value={values.displayName}
                onChange={(e) => set('displayName', e.target.value)}
              />
            </Field>
          </Section>
          <Section title="Settlement">
            <Field
              label="Assets"
              error={errors.assetCodes}
              hint="Upper-case codes separated by commas, for example USDT, USDC."
              k="assetCodes"
            >
              <input
                className="mp-input"
                {...fieldProps('assetCodes')}
                value={values.assetCodes}
                onChange={(e) => set('assetCodes', e.target.value)}
              />
            </Field>
            <Field
              label="Confirmations required"
              error={errors.confirmationsRequired}
              hint="Blocks before a deposit counts. Blank means not configured, and the network is never used."
              k="confirmationsRequired"
            >
              <input
                className="mp-input"
                inputMode="numeric"
                {...fieldProps('confirmationsRequired')}
                value={values.confirmationsRequired}
                onChange={(e) => set('confirmationsRequired', e.target.value)}
              />
            </Field>
            <Field label="Fee estimate from" error={errors.feeEstimateSource} hint="Blank means not configured." k="feeEstimateSource">
              <select
                className="mp-input"
                {...fieldProps('feeEstimateSource')}
                value={values.feeEstimateSource}
                onChange={(e) => set('feeEstimateSource', e.target.value)}
              >
                <option value="">Not configured</option>
                <option value="fixed">A fixed amount</option>
                <option value="venue_quote">The venue's quote</option>
                <option value="chain_estimate">The chain's own estimate</option>
              </select>
            </Field>
            <Field label="Fixed fee" error={errors.feeEstimateAmount} hint="Only with a fixed fee source." k="feeEstimateAmount">
              <input
                className="mp-input"
                inputMode="decimal"
                {...fieldProps('feeEstimateAmount')}
                value={values.feeEstimateAmount}
                onChange={(e) => set('feeEstimateAmount', e.target.value)}
                disabled={values.feeEstimateSource !== 'fixed'}
              />
            </Field>
            <SwitchField
              label="Switched on"
              hint={
                mode === 'create'
                  ? 'New entries start switched off. Switching one on is a separate change that needs a second founder.'
                  : 'Switching a network on needs a second founder.'
              }
              checked={values.enabled}
              disabled={mode === 'create'}
              onChange={(v) => set('enabled', v)}
              id="rf-enabled"
            />
          </Section>
        </>
      ) : null}

      {kind === 'wallet_route' ? (
        <>
          <Section title="Route">
            <Field
              label="Asset"
              required
              error={errors.assetCode}
              hint="Upper-case code, for example USDT. Cannot change after creating."
              k="assetCode"
            >
              <input
                className="mp-input"
                {...fieldProps('assetCode')}
                value={values.assetCode}
                onChange={(e) => set('assetCode', e.target.value)}
                disabled={locked('assetCode') || mode === 'edit'}
              />
            </Field>
            <Field
              label="Network id"
              required
              error={errors.networkId}
              hint="An existing network. Cannot change after creating."
              k="networkId"
            >
              <input
                className="mp-input"
                {...fieldProps('networkId')}
                value={values.networkId}
                onChange={(e) => set('networkId', e.target.value)}
                disabled={locked('networkId') || mode === 'edit'}
              />
            </Field>
            <SwitchField
              label="Payouts allowed"
              hint="Whether merchants can be paid out on this route."
              checked={values.payoutAllowed}
              onChange={(v) => set('payoutAllowed', v)}
              id="rf-payoutAllowed"
            />
          </Section>
          <Section title="Who and how much">
            <Field
              label="Largest single payout"
              error={errors.maxSinglePayout}
              hint="Blank means not configured, and payouts on this route are refused."
              k="maxSinglePayout"
            >
              <input
                className="mp-input"
                inputMode="decimal"
                {...fieldProps('maxSinglePayout')}
                value={values.maxSinglePayout}
                onChange={(e) => set('maxSinglePayout', e.target.value)}
              />
            </Field>
            <Field
              label="Only these merchants"
              error={errors.merchantAllow}
              hint="Merchant ids separated by commas. Blank means no restriction."
              k="merchantAllow"
              wide
            >
              <textarea
                className="mp-input"
                rows={2}
                {...fieldProps('merchantAllow')}
                value={values.merchantAllow}
                onChange={(e) => set('merchantAllow', e.target.value)}
              />
            </Field>
            <Field
              label="Never these merchants"
              error={errors.merchantDeny}
              hint="Merchant ids separated by commas. A merchant listed here is always refused."
              k="merchantDeny"
              wide
            >
              <textarea
                className="mp-input"
                rows={2}
                {...fieldProps('merchantDeny')}
                value={values.merchantDeny}
                onChange={(e) => set('merchantDeny', e.target.value)}
              />
            </Field>
          </Section>
        </>
      ) : null}

      <Section title="Why">
        <Field
          label="Reason"
          required
          error={errors.reason}
          hint="Saved with the change in the history. At least 3 characters."
          k="reason"
          wide
        >
          <textarea
            className="mp-input"
            rows={2}
            {...fieldProps('reason')}
            value={values.reason}
            onChange={(e) => set('reason', e.target.value)}
          />
        </Field>
      </Section>

      <RefusalBlock refusal={refusal} />
      <div className="mp-inline">
        <button type="submit" className="mp-btn mp-btn--primary" disabled={busy !== null}>
          {busy === 'preview' ? 'Checking…' : 'Review change'}
        </button>
        <a className="mp-btn" href={listHref}>
          Cancel
        </a>
      </div>
    </form>
  );
}

function changeFromValues(kind: RegistryKind, values: RegistryFormValues, expectedVersion: number | null): Record<string, unknown> | null {
  // The "before" side of a diff is the loaded values pushed through the same builder, with a placeholder reason.
  const built = buildChange(kind, { ...values, reason: values.reason || 'baseline' }, expectedVersion);
  return built.ok ? built.change : null;
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="mp-section">
      <legend>{title}</legend>
      <div className="mp-section__grid">{children}</div>
    </fieldset>
  );
}

export function Field({
  label,
  required,
  error,
  hint,
  k,
  wide,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string | undefined;
  hint: string;
  k: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="mp-field" data-wide={wide ? 'true' : undefined}>
      <label htmlFor={`rf-${k}`}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      {children}
      {error ? (
        <span id={`rf-${k}-err`} className="mp-error" role="alert">
          {error}
        </span>
      ) : (
        <span id={`rf-${k}-hint`} className="mp-hint">
          {hint}
        </span>
      )}
    </div>
  );
}

function SwitchField({
  label,
  hint,
  checked,
  disabled,
  onChange,
  id,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  id: string;
}) {
  return (
    <div className="mp-field mp-field--check">
      <label className="mp-check" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          aria-describedby={`${id}-hint`}
        />
        <span>{label}</span>
      </label>
      <span id={`${id}-hint`} className="mp-hint">
        {hint}
      </span>
    </div>
  );
}

export function RefusalBlock({ refusal }: { refusal: RefusalView | null }) {
  if (!refusal) return null;
  return (
    <StateBlock kind="error" title={refusal.title} requestId={refusal.requestId}>
      {refusal.body} {refusal.next}
    </StateBlock>
  );
}

function ApprovalHandoff({ kind, change, approval }: { kind: RegistryKind; change: Record<string, unknown>; approval: ApprovalView }) {
  const blob = JSON.stringify({ registry: kind, approvalId: approval.approvalId, change }, null, 2);
  return (
    <div className="mp-handoff" role="status">
      <p>
        <strong>Approval requested.</strong> Send this to the second founder. They open <em>Registries</em> in their own sign-in, paste it
        into "Approve a change from another founder", check what it says and approve.
      </p>
      <p className="mp-hash">
        Approval reference <code>{approval.approvalId}</code>
        {approval.expiresAt ? <> · expires {approval.expiresAt}</> : null}
      </p>
      <CopyButton value={blob} label="Copy request for the second founder" />
      <p className="mp-hint">When they have approved, press Save change below.</p>
    </div>
  );
}
