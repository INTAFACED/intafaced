'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  categoryPolicyPreviewInputSchema,
  type BusinessCategory,
  type BusinessCategoryClass,
  type CategoryPolicyPreview,
  type CategoryPolicyPreviewInput,
} from '@intafaced/contracts/business-category';
import type { ApprovalView, RefusalView } from '@/lib/merchants/registry-client';
import { CLASS_RULE, CLASS_WORDS, categoryHandoff, postCategory } from '@/lib/merchants/category-client';
import { CopyButton } from './copy-button';
import { RefusalBlock } from './registry-form';
import { StateBlock } from './ui';

interface FormValues {
  key: string;
  label: string;
  class: BusinessCategoryClass;
  reservePercent: string;
  holdDays: string;
  extraDocuments: string;
  reason: string;
}

const EMPTY: FormValues = { key: '', label: '', class: 'standard', reservePercent: '', holdDays: '', extraDocuments: '', reason: '' };

function valuesOf(category: BusinessCategory): FormValues {
  return {
    key: category.key,
    label: category.label,
    class: category.class,
    reservePercent: category.reserve?.percent ?? '',
    holdDays: category.reserve ? String(category.reserve.holdDays) : '',
    extraDocuments: category.extraDocuments.join('\n'),
    reason: '',
  };
}

/** The form as the contract svc-pay applies. Blank reserve terms stay blank (null): nothing is filled in. */
function changeOf(values: FormValues, expectedVersion: number | null): { change: CategoryPolicyPreviewInput } | { problem: string } {
  const restricted = values.class === 'restricted';
  const percent = values.reservePercent.trim();
  const days = values.holdDays.trim();
  if (restricted && (percent === '') !== (days === '')) return { problem: 'Set both reserve terms, or leave both blank.' };
  const candidate = {
    key: values.key.trim(),
    label: values.label.trim(),
    class: values.class,
    reserve: restricted && percent !== '' ? { percent, holdDays: Number(days) } : null,
    extraDocuments: restricted
      ? values.extraDocuments
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
      : [],
    expectedVersion,
    reason: values.reason.trim(),
  };
  const parsed = categoryPolicyPreviewInputSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join('.') ?? '';
    return { problem: `Check ${where ? `"${where}"` : 'the form'}: ${issue?.message ?? 'it does not read as a category'}.` };
  }
  return { change: parsed.data };
}

/** One change summarised the same way on both founders' screens. */
export function CategorySummary({ change }: { change: CategoryPolicyPreviewInput }) {
  return (
    <dl className="mp-kv mp-kv--summary" data-testid="category-summary">
      <div>
        <dt>Category</dt>
        <dd>
          {change.label} (<code>{change.key}</code>)
          {change.expectedVersion === null ? ', new' : `, edit of version ${change.expectedVersion}`}
        </dd>
      </div>
      <div>
        <dt>Class</dt>
        <dd>
          {CLASS_WORDS[change.class]}: {CLASS_RULE[change.class]}
        </dd>
      </div>
      {change.class === 'restricted' ? (
        <>
          <div>
            <dt>Reserve</dt>
            <dd>
              {change.reserve
                ? `${change.reserve.percent}% held for ${change.reserve.holdDays} days`
                : 'Not set: businesses in it cannot take payments'}
            </dd>
          </div>
          <div>
            <dt>Extra documents</dt>
            <dd>{change.extraDocuments.length ? change.extraDocuments.join('; ') : 'None'}</dd>
          </div>
        </>
      ) : null}
      <div>
        <dt>Why</dt>
        <dd>{change.reason}</dd>
      </div>
    </dl>
  );
}

type Stage =
  | { kind: 'edit' }
  | { kind: 'review'; change: CategoryPolicyPreviewInput; preview: CategoryPolicyPreview; approval: ApprovalView | null }
  | { kind: 'saved'; label: string };

/** Add or edit one business category. Every edit is two founders: you ask, the other approves, then you save. */
export function CategoryEditor({ categories }: { categories: BusinessCategory[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<{ version: number | null } | null>(null);
  const [values, setValues] = useState<FormValues>(EMPTY);
  const [stage, setStage] = useState<Stage>({ kind: 'edit' });
  const [problem, setProblem] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<RefusalView | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) => setValues((v) => ({ ...v, [key]: value }));

  function open(category: BusinessCategory | null) {
    setEditing({ version: category?.version ?? null });
    setValues(category ? valuesOf(category) : EMPTY);
    setStage({ kind: 'edit' });
    setProblem(null);
    setRefusal(null);
  }

  async function review() {
    if (!editing) return;
    setRefusal(null);
    const built = changeOf(values, editing.version);
    if ('problem' in built) return setProblem(built.problem);
    setProblem(null);
    setBusy(true);
    const reply = await postCategory({ action: 'preview', change: built.change });
    setBusy(false);
    if (!reply.ok) return setRefusal(reply.refusal);
    if (reply.preview) setStage({ kind: 'review', change: built.change, preview: reply.preview, approval: null });
  }

  async function ask() {
    if (stage.kind !== 'review') return;
    setRefusal(null);
    setBusy(true);
    const reply = await postCategory({ action: 'propose', change: stage.change });
    setBusy(false);
    if (!reply.ok) return setRefusal(reply.refusal);
    if (reply.approval) setStage({ ...stage, approval: reply.approval });
  }

  async function save() {
    if (stage.kind !== 'review' || !stage.approval?.operationId) return;
    setRefusal(null);
    setBusy(true);
    const reply = await postCategory({
      action: 'save',
      change: stage.change,
      approvalId: stage.approval.approvalId,
      operationId: stage.approval.operationId,
    });
    setBusy(false);
    if (!reply.ok) return setRefusal(reply.refusal);
    setStage({ kind: 'saved', label: stage.change.label });
    setEditing(null);
    router.refresh();
  }

  return (
    <div className="mp-form" role="group" aria-label="Change the category table">
      <div className="mp-inline">
        <button type="button" className="mp-btn mp-btn--primary" onClick={() => open(null)} disabled={busy}>
          Add a category
        </button>
        {categories.map((category) => (
          <button key={category.key} type="button" className="mp-btn" onClick={() => open(category)} disabled={busy}>
            Edit {category.label}
          </button>
        ))}
      </div>

      {stage.kind === 'saved' ? (
        <StateBlock kind="success" title="Saved">
          {stage.label} is in the table, with who changed it and who approved it.
        </StateBlock>
      ) : null}

      {editing && stage.kind === 'edit' ? (
        <div className="mp-form" role="group" aria-label={editing.version === null ? 'New category' : `Edit ${values.label}`}>
          <div className="mp-field">
            <label htmlFor="cat-key">Key (lowercase words joined by hyphens; it never changes)</label>
            <input
              id="cat-key"
              className="mp-input"
              value={values.key}
              disabled={editing.version !== null}
              onChange={(e) => set('key', e.target.value)}
            />
          </div>
          <div className="mp-field">
            <label htmlFor="cat-label">Name the business reads</label>
            <input id="cat-label" className="mp-input" value={values.label} onChange={(e) => set('label', e.target.value)} />
          </div>
          <div className="mp-field">
            <label htmlFor="cat-class">Class</label>
            <select
              id="cat-class"
              className="mp-input"
              value={values.class}
              onChange={(e) => set('class', e.target.value as BusinessCategoryClass)}
              aria-describedby="cat-class-rule"
            >
              <option value="standard">Standard</option>
              <option value="permissionless">Permissionless</option>
              <option value="restricted">Restricted</option>
              <option value="prohibited">Prohibited</option>
            </select>
            <span id="cat-class-rule" className="mp-hint">
              {CLASS_RULE[values.class]}
            </span>
          </div>
          {values.class === 'restricted' ? (
            <>
              <div className="mp-field">
                <label htmlFor="cat-reserve">Reserve percent (blank: not set)</label>
                <input
                  id="cat-reserve"
                  className="mp-input"
                  inputMode="decimal"
                  value={values.reservePercent}
                  onChange={(e) => set('reservePercent', e.target.value)}
                />
              </div>
              <div className="mp-field">
                <label htmlFor="cat-hold">Reserve held for, in days (blank: not set)</label>
                <input
                  id="cat-hold"
                  className="mp-input"
                  inputMode="numeric"
                  value={values.holdDays}
                  onChange={(e) => set('holdDays', e.target.value)}
                />
              </div>
              <div className="mp-field">
                <label htmlFor="cat-docs">Extra documents the business sends (one per line)</label>
                <textarea
                  id="cat-docs"
                  className="mp-input"
                  rows={3}
                  value={values.extraDocuments}
                  onChange={(e) => set('extraDocuments', e.target.value)}
                />
              </div>
            </>
          ) : null}
          <div className="mp-field">
            <label htmlFor="cat-reason">Why (kept in the history)</label>
            <textarea id="cat-reason" className="mp-input" rows={2} value={values.reason} onChange={(e) => set('reason', e.target.value)} />
          </div>
          <div className="mp-inline">
            <button type="button" className="mp-btn mp-btn--primary" onClick={() => void review()} disabled={busy}>
              {busy ? 'Checking…' : 'Review the change'}
            </button>
            <button type="button" className="mp-btn" onClick={() => setEditing(null)} disabled={busy}>
              Cancel
            </button>
          </div>
          {problem ? (
            <p className="mp-hint" role="alert">
              {problem}
            </p>
          ) : null}
        </div>
      ) : null}

      {stage.kind === 'review' ? (
        <div className="mp-review" data-testid="category-review">
          <h3 className="mp-h2">Review before saving</h3>
          <CategorySummary change={stage.change} />
          <p className="mp-muted">
            A different founder must approve this exact change in their own sign-in. Approval is tied to hash{' '}
            <code>{stage.preview.payloadHash}</code>, so changing anything afterwards voids it.
          </p>
          {stage.approval ? (
            <div className="mp-handoff" role="status">
              <p>
                <strong>Approval requested.</strong> Send this to the other founder. They paste it into “Approve a category change” on this
                page in their own sign-in.
              </p>
              <label htmlFor="cat-handoff">Request for the other founder</label>
              <textarea
                id="cat-handoff"
                className="mp-input"
                rows={4}
                readOnly
                value={categoryHandoff(stage.change, stage.approval.approvalId)}
              />
              <CopyButton value={categoryHandoff(stage.change, stage.approval.approvalId)} label="Copy request for the other founder" />
            </div>
          ) : null}
          <div className="mp-inline">
            {!stage.approval ? (
              <button type="button" className="mp-btn mp-btn--primary" onClick={() => void ask()} disabled={busy}>
                {busy ? 'Asking…' : 'Ask the other founder to approve'}
              </button>
            ) : (
              <button type="button" className="mp-btn mp-btn--primary" onClick={() => void save()} disabled={busy}>
                {busy ? 'Saving…' : 'Save the change'}
              </button>
            )}
            <button type="button" className="mp-btn" onClick={() => setStage({ kind: 'edit' })} disabled={busy}>
              Back to edit
            </button>
          </div>
        </div>
      ) : null}
      <RefusalBlock refusal={refusal} />
    </div>
  );
}

/** Step 2 on the OTHER founder's screen: paste, read the change in words, approve or decline. */
export function CategoryApprovePanel() {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<RefusalView | null>(null);
  const [done, setDone] = useState<'approved' | 'declined' | 'mismatch' | null>(null);
  const parsed = parse(text);

  async function decide(action: 'approve' | 'reject') {
    if (!parsed) return;
    setBusy(true);
    setRefusal(null);
    const reply =
      action === 'approve'
        ? await postCategory({ action: 'approve', change: parsed.change, approvalId: parsed.approvalId })
        : await postCategory({ action: 'reject', approvalId: parsed.approvalId });
    setBusy(false);
    if (!reply.ok) return setRefusal(reply.refusal);
    setDone(action === 'reject' ? 'declined' : reply.matchesReviewedChange === false ? 'mismatch' : 'approved');
  }

  return (
    <div className="mp-form" role="group" aria-label="Approve a category change">
      <div className="mp-field">
        <label htmlFor="cat-approve">Request from the other founder</label>
        <textarea
          id="cat-approve"
          className="mp-input"
          rows={4}
          value={text}
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value);
            setDone(null);
            setRefusal(null);
          }}
        />
        <span className="mp-hint">You cannot approve a change you asked for yourself.</span>
      </div>
      {text.trim() !== '' && !parsed ? (
        <StateBlock kind="error" title="That is not a category request">
          Copy the whole request again from the other founder’s screen.
        </StateBlock>
      ) : null}
      {parsed ? (
        <>
          <CategorySummary change={parsed.change} />
          <div className="mp-inline">
            <button
              type="button"
              className="mp-btn mp-btn--primary"
              onClick={() => void decide('approve')}
              disabled={busy || done !== null}
            >
              {busy ? 'Working…' : 'Approve this category change'}
            </button>
            <button type="button" className="mp-btn" onClick={() => void decide('reject')} disabled={busy || done !== null}>
              Decline
            </button>
          </div>
        </>
      ) : null}
      <RefusalBlock refusal={refusal} />
      {done === 'approved' ? (
        <StateBlock kind="info" title="Approved">
          Tell the other founder they can save now. The approval works for exactly this change, once.
        </StateBlock>
      ) : null}
      {done === 'mismatch' ? (
        <StateBlock kind="error" title="Approved, but for a different change">
          The approval on that reference covers a different change than the one shown. It cannot save this change. Stop and tell the other
          founder and engineering now.
        </StateBlock>
      ) : null}
      {done === 'declined' ? (
        <StateBlock kind="info" title="Declined">
          The request is closed. The category was not changed.
        </StateBlock>
      ) : null}
    </div>
  );
}

function parse(text: string): { approvalId: string; change: CategoryPolicyPreviewInput } | null {
  if (text.trim() === '') return null;
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (raw.kind !== 'business_category' || typeof raw.approvalId !== 'string' || raw.approvalId.trim() === '') return null;
    const change = categoryPolicyPreviewInputSchema.safeParse(raw.change);
    return change.success ? { approvalId: raw.approvalId.trim(), change: change.data } : null;
  } catch {
    return null;
  }
}
