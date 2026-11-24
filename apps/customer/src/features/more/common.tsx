import { copy as legacyCopy, t as copyText, Text } from './copy';
import type { ReactNode } from 'react';
import { present, useActionState, type Presented } from './action-state';
import type { ApiResult } from '../../shared/api';
import type { Resource } from '../../shared/resource';
import { Button, Select as KitSelect, TextArea as KitTextArea } from '@intafaced/ui/lit';
import { Sheet } from '@intafaced/ui/lit/templates';
import { EmptyNote, FailureNote, Waiting } from './volt-parts';
import { uiCopy } from '../../shared/ui-copy';
import { renderAuthoredCopy } from '../../shared/i18n';
import { FirstState, type FirstStateProps } from '@intafaced/ui/lit/templates';
import { uiDirection } from '../../shared/locale';

export { actionFailurePresentation, presentActionFailure } from './action-state';

export function Read<T>({
  resource,
  retry,
  empty,
  first,
  children,
}: {
  resource: Resource<T>;
  retry: () => void;
  empty?: string;
  /** With `empty`: the room's first state (what it is for and one action) in place of the bare line. */
  first?: Omit<FirstStateProps, 'title'>;
  children: (data: T) => ReactNode;
}) {
  if (resource.status === 'loading') return <Waiting />;
  if (resource.status === 'failed')
    return (
      <div lang="und">
        <FailureNote result={resource.failure} retry={retry} />
      </div>
    );
  if (empty && (resource.data === null || (Array.isArray(resource.data) && resource.data.length === 0)))
    return first ? <FirstState title={empty} {...first} /> : <EmptyNote title={empty} />;
  return <>{children(resource.data)}</>;
}
export function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly (string | { value: string; label: string })[];
}) {
  return <KitSelect label={label} value={value} onChange={onChange} options={options} />;
}
export function TextArea({
  label,
  value,
  onChange,
  maxLength = 10000,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
}) {
  return <KitTextArea label={label} value={value} onChange={onChange} maxLength={maxLength} rows={5} />;
}
export function Limit({ count, limit, cap, onChange }: { count: number; limit: number; cap: number; onChange: (limit: number) => void }) {
  return (
    <div className="lt-stack-tight">
      <small>
        <Text k="common.showing" />
        {count}
        <Text k="common.requested.limit" />
        {limit}
        <Text k="common.this.service.publishes.no.continuation.cursor" />
      </small>
      {count >= limit && limit < cap ? (
        <Button tone="secondary" onClick={() => onChange(Math.min(cap, limit + 50))}>
          <Text k="common.load.a.larger.window" />
        </Button>
      ) : count >= cap ? (
        <small>
          <Text k="common.the.published.limit.is" />
          {cap}
          <Text k="common.older.rows.cannot.be.requested.here" />
        </small>
      ) : null}
    </div>
  );
}
export function Details({ items }: { items: readonly [string, ReactNode][] }) {
  return (
    <dl className="lt-kv">
      {items.map(([label, value], index) => (
        <div key={index}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
export function PresentedCopy({ value }: { value: Presented<ReactNode> }) {
  const shown = typeof value === 'function' ? renderAuthoredCopy(value) : { value, language: 'und' };
  return (
    <span lang={shown.language} dir={shown.language === 'und' ? undefined : uiDirection(shown.language)}>
      {shown.value}
    </span>
  );
}
export type ActionControls = Pick<ReturnType<typeof useAction>, 'stage' | 'disabled' | 'isCurrent' | 'result'>;
export function useAction(room: string, recovery?: { recover: (reference: string) => Promise<ApiResult<unknown>>; done?: () => void }) {
  const action = useActionState(room, recovery);
  const {
    userId,
    language,
    running,
    failure,
    presentation,
    copy,
    problem,
    problemKey,
    success,
    known,
    saved,
    canRecover,
    cleanup,
    recoverOriginal,
    redraw,
    reviewing,
    dismiss,
    send,
  } = action.view;
  const feedback = (
    <>
      {running ? (
        <Waiting label={copyText('common.waiting.for.the.service')} />
      ) : failure ? (
        <div lang={problem ? legacyCopy.forLocale(language).languageFor(problemKey) : (presentation?.language ?? 'und')}>
          <FailureNote
            result={
              problem
                ? { ...failure, message: legacyCopy.forLocale(language).t(problemKey) }
                : presentation
                  ? { ...failure, message: presentation.message, messageCopy: undefined }
                  : failure
            }
          />
        </div>
      ) : success ? (
        <p className="lt-note lt-note-good" role="status">
          <PresentedCopy value={success} />
        </p>
      ) : null}
      {known && !running ? (
        <div data-testid="failure" className="lt-refusal" role="alert">
          <p className="lt-refusal-body" lang={copy.languageFor('cleanup')}>
            {copy.t('cleanup')}
          </p>
          <code className="lt-ref" lang="zxx">
            {JSON.parse(known.raw).reference ?? JSON.parse(known.raw).id}
          </code>
          <Button tone="secondary" lang={copy.languageFor('retryCleanup')} onClick={() => void cleanup(known)}>
            {copy.t('retryCleanup')}
          </Button>
        </div>
      ) : saved.status === 'unreadable' && !running ? (
        <div data-testid="failure" className="lt-refusal" role="alert">
          <h3 className="lt-refusal-title" lang={copy.languageFor('storageTitle')}>
            {copy.t('storageTitle')}
          </h3>
          <p className="lt-refusal-body" lang={copy.languageFor('storageBody')}>
            {copy.t('storageBody')}
          </p>
          <Button tone="secondary" lang={copy.languageFor('retryStorage')} onClick={redraw}>
            {copy.t('retryStorage')}
          </Button>
        </div>
      ) : saved.status === 'present' && !running ? (
        <div data-testid="failure" className="lt-refusal" role="alert">
          {!action.result && (
            <h3 className="lt-refusal-title">
              <Text k="common.outcome.not.confirmed" />
            </h3>
          )}
          <p className="lt-refusal-body">
            <Text k="common.earlier.request" />
            <span lang="und">{saved.value.title}</span>.{' '}
            {saved.value.reference && (
              <code className="lt-ref" lang="zxx">
                {saved.value.reference}
              </code>
            )}
            <Text k="common.read.its.original.records.before.continuing" />
          </p>
          {saved.value.reference && canRecover ? (
            <Button tone="secondary" onClick={() => void recoverOriginal()}>
              <Text k="common.check.original.outcome" />
            </Button>
          ) : (
            <p className="lt-refusal-body">
              <Text k="common.this.action.has.no.universal.recovery.lookup" />
            </p>
          )}
        </div>
      ) : null}
    </>
  );
  const request = reviewing;
  const closeCopy = uiCopy.forLocale(language);
  const dialog = request ? (
    <Sheet
      open
      title={renderAuthoredCopy(() => present(request.title)).value}
      closeLabel={closeCopy.t('closeDialog')}
      closeLang={closeCopy.languageFor('closeDialog')}
      onClose={() => dismiss(request)}
      footer={
        <div className="lt-actions">
          <Button tone="secondary" onClick={() => dismiss(request)}>
            <Text k="common.back" />
          </Button>
          <Button tone="primary" onClick={() => void send(request)}>
            <PresentedCopy value={request.confirm} />
          </Button>
        </div>
      }
    >
      <PresentedCopy value={request.content} />
      <p className="lt-hint">
        <Text k="common.acting.as.account" />
        <code lang="zxx">{userId}</code>
        <Text k="common.the.service.enforces.your.scope.and.jurisdiction" />
      </p>
    </Sheet>
  ) : null;
  const { view: _view, ...controls } = action;
  void _view;
  return { ...controls, feedback, dialog };
}
