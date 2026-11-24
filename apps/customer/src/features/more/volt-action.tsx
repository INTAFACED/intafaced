/**
 * The More rooms' staged action drawn with the kit (intafaced issue 9568): the same review, wait, failure, success and
 * recovery states `useAction` (common.tsx) draws with the old parts, from the one logic in `action-state.ts`. The review
 * opens in the kit's Sheet; the words are the old ones.
 */
import type { ReactNode } from 'react';
import { Button } from '@intafaced/ui/lit';
import { KeyValue, Sheet } from '@intafaced/ui/lit/templates';
import { renderAuthoredCopy } from '../../shared/i18n';
import { uiDirection } from '../../shared/locale';
import { useFailureWords } from '../../shared/failure-words';
import { isVerifyFirst, type ApiResult } from '../../shared/api';
import { VerifyFirstNote } from '../../shared/verify-first';
import { copy as legacyCopy, t as copyText } from './copy';
import { present, useActionState, type Presented } from './action-state';
import { Waiting } from './volt-parts';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/** Authored copy in the language it was found in; anything else is the person's own words. */
function KitPresented({ value }: { value: Presented<ReactNode> }) {
  const shown = typeof value === 'function' ? renderAuthoredCopy(value) : { value, language: 'und' };
  return (
    <span lang={shown.language} dir={shown.language === 'und' ? undefined : uiDirection(shown.language)}>
      {shown.value}
    </span>
  );
}

/** Label and value rows of a review or a record, drawn as the kit's key-value list. */
export function KitDetails({ items }: { items: readonly [string, ReactNode][] }) {
  return <KeyValue rows={items.map(([label, value]) => ({ label, value }))} />;
}

/** A failed send, in the shared `Failure`'s words, the title in its own language. */
function ActionFailure({ result, lang }: { result: Failed; lang?: string }) {
  const words = useFailureWords()(result);
  if (isVerifyFirst(result)) return <VerifyFirstNote code={result.code} />;
  return (
    <div data-testid="failure" className="lt-refusal" role={words.role} lang={lang}>
      <h3 className="lt-refusal-title">
        <span lang={words.titleLang}>{words.title}</span>
      </h3>
      <p className="lt-refusal-body" lang={words.bodyLang}>
        {words.body}
      </p>
      {words.action ? (
        <a className="lt-link" href={words.action.href}>
          {words.action.label}
        </a>
      ) : null}
      {words.reference ? <p className="lt-ref">{words.reference}</p> : null}
    </div>
  );
}

/** `useAction`, drawn with the kit. */
export function useKitAction(room: string, recovery?: { recover: (reference: string) => Promise<ApiResult<unknown>>; done?: () => void }) {
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
  const legacy = legacyCopy.forLocale(language);
  const feedback = (
    <>
      {running ? (
        <Waiting label={copyText('common.waiting.for.the.service')} />
      ) : failure ? (
        <ActionFailure
          lang={problem ? legacy.languageFor(problemKey) : (presentation?.language ?? 'und')}
          result={
            problem
              ? { ...failure, message: legacy.t(problemKey) }
              : presentation
                ? { ...failure, message: presentation.message, messageCopy: undefined }
                : failure
          }
        />
      ) : success ? (
        <p role="status" data-testid="more-success">
          <KitPresented value={success} />
        </p>
      ) : null}
      {known && !running ? (
        <div data-testid="failure" className="lt-refusal" role="alert">
          <p className="lt-refusal-body" lang={copy.languageFor('cleanup')}>
            {copy.t('cleanup')}
          </p>
          <code className="lt-code lt-wrap" lang="zxx">
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
          {!action.result && <h3 className="lt-refusal-title">{copyText('common.outcome.not.confirmed')}</h3>}
          <p className="lt-refusal-body">
            {copyText('common.earlier.request')}
            <span lang="und">{saved.value.title}</span>.{' '}
            {saved.value.reference && (
              <code className="lt-code lt-wrap" lang="zxx">
                {saved.value.reference}
              </code>
            )}
            {copyText('common.read.its.original.records.before.continuing')}
          </p>
          {saved.value.reference && canRecover ? (
            <Button tone="secondary" onClick={() => void recoverOriginal()}>
              {copyText('common.check.original.outcome')}
            </Button>
          ) : (
            <p>{copyText('common.this.action.has.no.universal.recovery.lookup')}</p>
          )}
        </div>
      ) : null}
    </>
  );
  const request = reviewing;
  const dialog = request ? (
    <Sheet open title={present(request.title)} onClose={() => dismiss(request)}>
      <div className="lt-stack">
        <KitPresented value={request.content} />
        <p className="lt-hint">
          {copyText('common.acting.as.account')}
          <code className="lt-code" lang="zxx">
            {userId}
          </code>
          {copyText('common.the.service.enforces.your.scope.and.jurisdiction')}
        </p>
        <div className="lt-actions">
          <Button tone="secondary" onClick={() => dismiss(request)}>
            {copyText('common.back')}
          </Button>
          <Button tone="primary" onClick={() => void send(request)}>
            <KitPresented value={request.confirm} />
          </Button>
        </div>
      </div>
    </Sheet>
  ) : null;
  const { view: _view, ...controls } = action;
  void _view;
  return { ...controls, feedback, dialog };
}
export type KitAction = ReturnType<typeof useKitAction>;
