import { useState, type ReactNode } from 'react';
import { z, type ZodType } from 'zod';
import { currentPreferences } from '../../shared/preferences';
import { useApi, useSession } from '../session/session';
import { useResource, type Resource } from '../../shared/resource';
import type { ApiResult } from '../../shared/api';
import { Button, Dialog, EmptyState, Failure, Field, Loading } from '../../shared/ui';
import { decimalSchema, displayAmount, parseAmount } from '../../shared/money';
import { bankReads, bankWrites, type BankRead, type BankWrite } from './contracts';
import { createMoneyClient, type Space, type TransferDraft } from './client';

export const PAGE_SIZE = 50;
export const amount = (value: string | null | undefined, asset: string) =>
  value == null ? 'Unavailable' : `${displayAmount(value)} ${asset}`;
export const funds = (value: string | null | undefined, asset: string) =>
  currentPreferences().hideBalances && value != null ? `•••• ${asset}` : amount(value, asset);
export const date = (value: string | null) =>
  value ? (Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Date unavailable') : 'None';
export const bps = (value: number) => `${value / 100}%`;
export function useBankRead<K extends BankRead>(procedure: K, input: unknown, enabled = true) {
  const { api, userId } = useSession();
  return useResource<z.infer<(typeof bankReads)[K]>>(
    async (signal) => {
      if (!enabled) return { ok: false, reason: 'not_supported', message: 'Select a record to load its details.' };
      if (!userId) return { ok: false, reason: 'unauthorized', message: 'Sign in to read your Bank information.' };
      return api.query('bank', procedure, input, bankReads[procedure] as ZodType<z.infer<(typeof bankReads)[K]>>, { signal });
    },
    `${userId}:${procedure}:${JSON.stringify(input)}:${enabled}`,
  );
}
export function ResourceView<T>({
  resource,
  reload,
  children,
}: {
  resource: Resource<T>;
  reload: () => void;
  children: (data: T) => ReactNode;
}) {
  if (resource.status === 'loading') return <Loading />;
  if (resource.status === 'failed') return <Failure result={resource.failure} retry={reload} />;
  return <>{children(resource.data)}</>;
}
export function Section({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="money-section">
      <header>
        <div>
          <h2>{title}</h2>
          {description && <p className="muted">{description}</p>}
        </div>
        {actions && <div className="actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}
export function Continuation({ count, limit, onMore }: { count: number; limit: number; onMore: () => void }) {
  return (
    <div className="money-continuation">
      <span>
        {count} records returned · requested limit {limit}.{' '}
        {count >= limit
          ? limit < 200
            ? 'More records may exist.'
            : 'This service has no continuation beyond 200 records.'
          : 'This list has no total-count or continuation cursor.'}
      </span>
      {count >= limit && limit < 200 && (
        <Button variant="secondary" onClick={onMore}>
          Load up to {Math.min(200, limit + 50)}
        </Button>
      )}
    </div>
  );
}
export function usePageLimit() {
  return useState(PAGE_SIZE);
}
export type ActionField = {
  name: string;
  label: string;
  hint?: string;
  type?: 'text' | 'datetime-local';
  options?: { value: string; label: string }[];
  optional?: boolean;
  validate?: (value: string) => string | null;
};
export type ActionSpec = {
  title: string;
  procedure: BankWrite;
  fields?: ActionField[];
  initial?: Record<string, string>;
  facts?: [string, string][];
  notes: string[];
  input: (values: Record<string, string>, requestId: string) => Record<string, unknown>;
  validate?: (input: Record<string, unknown>) => string | null;
  transferSpaces?: Space[];
  submit?: string;
  unit?: string;
};
export const positiveMoney = (asset: string, name = 'amount', label = 'Amount'): ActionField => ({
  name,
  label: `${label} (${asset})`,
  hint: 'Exact decimal amount. Available funds only.',
  validate: (value) =>
    decimalSchema.safeParse(value).success && parseAmount(value) > 0n ? null : 'Enter an exact decimal amount greater than zero.',
});
export const uuidField = (name: string, label: string): ActionField => ({
  name,
  label,
  validate: (value) => (z.string().uuid().safeParse(value).success ? null : 'Enter a valid ID.'),
});
export const startsField: ActionField = {
  name: 'startsAt',
  label: 'First run',
  type: 'datetime-local',
  validate: (value) => (Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.now() ? null : 'Choose a future date and time.'),
};
export const cadenceField: ActionField = {
  name: 'cadence',
  label: 'Cadence',
  options: ['daily', 'weekly', 'monthly'].map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1) })),
};
export const iso = (value: string) => new Date(value).toISOString();
const outputNames: Record<string, string> = {
  ledgerTxId: 'Ledger transaction',
  drawLedgerTxId: 'Draw transaction',
  holdLedgerTxId: 'Reservation transaction',
  positionId: 'Position',
  maturesAt: 'Matures at',
  amount: 'Confirmed amount',
  status: 'Status',
  remainingPrincipal: 'Remaining principal',
  remainingInterest: 'Remaining interest',
  principalPaid: 'Principal paid',
  interestPaid: 'Interest paid',
  skipped: 'Missed occurrences skipped',
  kind: 'Outcome',
  approval: 'Approval',
  released: 'Released quantity',
  nextRunAt: 'Next run',
  id: 'Record',
  name: 'Name',
};
const monetaryOutcomeKeys = new Set([
  'amount',
  'principal',
  'threshold',
  'interestPaid',
  'principalPaid',
  'remainingPrincipal',
  'remainingInterest',
  'released',
]);
function Outcome({ data, unit }: { data: unknown; unit?: string }) {
  if (Array.isArray(data)) return <span>{data.map((item) => String(item)).join(', ') || 'None'}</span>;
  if (data && typeof data === 'object')
    return (
      <dl className="detail-list">
        {Object.entries(data).map(([key, value]) => (
          <div key={key}>
            <dt>{outputNames[key] ?? key.replace(/([A-Z])/g, ' $1')}</dt>
            <dd>
              {monetaryOutcomeKeys.has(key) && typeof value === 'string' ? (
                unit || typeof (data as Record<string, unknown>).assetId === 'string' ? (
                  amount(value, String((data as Record<string, unknown>).assetId ?? unit))
                ) : (
                  `${displayAmount(value)} · unit unavailable`
                )
              ) : key === 'ltvBps' && typeof value === 'number' ? (
                bps(value)
              ) : (
                <Outcome data={value} unit={unit} />
              )}
            </dd>
          </div>
        ))}
      </dl>
    );
  return <span>{data === null ? 'None' : String(data)}</span>;
}
export function MutationDialog({
  spec,
  onClose,
  onDone,
  onUncertain,
}: {
  spec: ActionSpec;
  onClose: () => void;
  onDone: () => void;
  onUncertain: (reference: string, input: Record<string, unknown>) => void;
}) {
  const api = useApi();
  const [values, setValues] = useState(spec.initial ?? {});
  const [requestId] = useState(() => crypto.randomUUID());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [stage, setStage] = useState<'form' | 'review' | 'sending' | 'outcome'>((spec.fields?.length ?? 0) ? 'form' : 'review');
  const [result, setResult] = useState<ApiResult<unknown> | null>(null);
  const [reviewInput, setReviewInput] = useState<Record<string, unknown> | null>(null);
  function review() {
    const next: Record<string, string> = {};
    for (const field of spec.fields ?? []) {
      const value = values[field.name]?.trim() ?? '';
      if (!value && !field.optional) next[field.name] = 'Complete this field.';
      else if (value && field.validate?.(value)) next[field.name] = field.validate(value)!;
      if (value && field.options && !field.options.some((option) => option.value === value))
        next[field.name] = 'Choose a supported option.';
    }
    if (Object.keys(next).length) {
      setErrors(next);
      return;
    }
    const input = spec.input(values, requestId);
    const error = spec.validate?.(input);
    if (error) {
      setErrors({ form: error });
      return;
    }
    setReviewInput(input);
    setStage('review');
  }
  async function submit() {
    if (stage !== 'review') return;
    const input = reviewInput ?? spec.input(values, requestId);
    setStage('sending');
    const outcome = spec.transferSpaces
      ? await createMoneyClient(api).transfer(spec.transferSpaces, input as TransferDraft)
      : await api.mutate('bank', spec.procedure, input, bankWrites[spec.procedure] as ZodType<unknown>);
    setResult(outcome);
    setStage('outcome');
    if (outcome.ok) onDone();
    else if (outcome.reason === 'uncertain') onUncertain(requestId, input);
  }
  const terminalUnknown = result && !result.ok && result.reason === 'uncertain';
  return (
    <Dialog
      title={stage === 'review' ? `Review ${spec.title.toLowerCase()}` : spec.title}
      onClose={() => {
        if (stage !== 'sending') onClose();
      }}
    >
      <div className="money-dialog-body">
        {spec.notes.map((note) => (
          <p className="muted" key={note}>
            {note}
          </p>
        ))}
        {stage === 'form' && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              review();
            }}
          >
            {spec.fields?.map((field) =>
              field.options ? (
                <label className="field" key={field.name}>
                  <span>{field.label}</span>
                  <select
                    value={values[field.name] ?? ''}
                    onChange={(event) => setValues({ ...values, [field.name]: event.target.value })}
                    required={!field.optional}
                    aria-label={field.label}
                    aria-invalid={Boolean(errors[field.name])}
                    aria-describedby={field.hint || errors[field.name] ? `${field.name}-help` : undefined}
                  >
                    <option value="">Choose…</option>
                    {field.options.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  {(field.hint || errors[field.name]) && (
                    <small id={`${field.name}-help`} className={errors[field.name] ? 'error-text' : ''}>
                      {errors[field.name] ?? field.hint}
                    </small>
                  )}
                </label>
              ) : (
                <Field
                  key={field.name}
                  name={field.name}
                  label={field.label}
                  aria-label={field.label}
                  hint={field.hint}
                  type={field.type ?? 'text'}
                  inputMode={field.name.toLowerCase().includes('amount') || field.name === 'principal' ? 'decimal' : undefined}
                  required={!field.optional}
                  value={values[field.name] ?? ''}
                  error={errors[field.name]}
                  onChange={(event) => setValues({ ...values, [field.name]: event.target.value })}
                />
              ),
            )}
            {errors.form && (
              <p className="error-text" role="alert">
                {errors.form}
              </p>
            )}
            <Button type="submit">Review</Button>
          </form>
        )}
        {(stage === 'review' || stage === 'sending') && (
          <>
            <dl className="detail-list">
              {spec.facts?.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
              {spec.fields?.map((field) => (
                <div key={field.name}>
                  <dt>{field.label}</dt>
                  <dd>{field.options?.find((option) => option.value === values[field.name])?.label ?? values[field.name] ?? 'None'}</dd>
                </div>
              ))}
            </dl>
            <p className="money-reference">Request reference: {requestId}</p>
            {stage === 'sending' ? (
              <Loading label="Waiting for the authoritative outcome" />
            ) : (
              <div className="actions">
                <Button onClick={() => void submit()}>{spec.submit ?? 'Confirm'}</Button>
                {Boolean(spec.fields?.length) && (
                  <Button variant="secondary" onClick={() => setStage('form')}>
                    Edit
                  </Button>
                )}
              </div>
            )}
          </>
        )}
        {stage === 'outcome' && result && (
          <div aria-live="polite">
            {result.ok ? (
              <>
                <h3>Confirmed by the service</h3>
                <Outcome
                  data={result.data}
                  unit={
                    spec.unit ??
                    spec.fields?.find((field) => field.name === 'amount' || field.name === 'principal')?.label.match(/\(([^)]+)\)$/)?.[1]
                  }
                />
              </>
            ) : (
              <Failure result={result} />
            )}
            {terminalUnknown && (
              <>
                <p className="notice">
                  This request may have completed. Keep this reference and inspect the original record before making another request.
                </p>
                <p className="money-reference">Request reference: {requestId}</p>
                <Button variant="secondary" onClick={onDone}>
                  Refresh original records
                </Button>
              </>
            )}
            <div className="actions">
              <Button variant="secondary" onClick={onClose}>
                Close
              </Button>
              {!result.ok && !terminalUnknown && (
                <Button
                  onClick={() => {
                    setResult(null);
                    setStage('form');
                  }}
                >
                  Edit request
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
export function NoRows({ title, children }: { title: string; children?: ReactNode }) {
  return <EmptyState title={title}>{children}</EmptyState>;
}
