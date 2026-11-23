/**
 * Academy's staged action drawn with the kit (intafaced issue 9568): the same review, wait, failure, success, journal
 * and cleanup states `useAcademyAction` (../academy-action.tsx) draws with the old parts, from the one logic in
 * ../academy-action-state.ts. The review opens in the kit's Sheet; the words are the old ones.
 */
import type { ReactNode } from 'react';
import { Button } from '@intafaced/ui/lit';
import { Sheet } from '@intafaced/ui/lit/templates';
import { renderAuthoredCopy } from '../../../shared/i18n';
import { uiDirection } from '../../../shared/locale';
import { useFailureWords } from '../../../shared/failure-words';
import type { ApiResult } from '../../../shared/api';
import { present, type Presented } from '../action-state';
import { useAcademyActionState } from '../academy-action-state';
import { t as moreText } from '../copy';
import { Waiting } from '../volt-parts';

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

/** A failed send, in the shared `Failure`'s words. */
function ActionFailure({ result, lang }: { result: Failed; lang: string }) {
  const words = useFailureWords()(result);
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

/** `useAcademyAction`, drawn with the kit. */
export function useKitAcademyAction() {
  const { controls, view } = useAcademyActionState();
  const {
    language,
    running,
    failure,
    presentation,
    ownedFailure,
    shown,
    snapshot,
    copy,
    redraw,
    cleanup,
    reviewing,
    dismiss,
    send,
    userId,
  } = view;
  const words = copy.forLocale(language);
  const owned = failure?.code === 'academy.original_changed' ? 'changed' : 'unavailable';
  const feedback = (
    <>
      {running && <Waiting label={moreText('common.waiting.for.the.service')} />}
      {failure && (
        <ActionFailure
          lang={presentation?.language ?? (ownedFailure ? words.languageFor(owned) : 'und')}
          result={
            presentation
              ? { ...failure, message: presentation.message, messageCopy: undefined }
              : ownedFailure
                ? { ...failure, message: copy.t(owned) }
                : failure
          }
        />
      )}
      {!running && shown.result?.ok && shown.success && (
        <p role="status" data-testid="more-success">
          <KitPresented value={shown.success} />
        </p>
      )}
      {snapshot.status === 'other' && !running && (
        <div data-testid="failure" className="lt-refusal" role="alert">
          <h3 className="lt-refusal-title">{moreText('common.outcome.not.confirmed')}</h3>
          <p className="lt-refusal-body">
            {moreText('common.earlier.request')}
            <span lang="und">{snapshot.marker.title}</span>{' '}
            {snapshot.marker.reference && (
              <code className="lt-code lt-wrap" lang="zxx">
                {snapshot.marker.reference}
              </code>
            )}
            {moreText('common.read.its.original.records.before.continuing')}
          </p>
          <p className="lt-refusal-body">{moreText('common.this.action.has.no.universal.recovery.lookup')}</p>
        </div>
      )}
      {snapshot.known && !snapshot.known.grant && (
        <div data-testid="failure" className="lt-refusal">
          <p className="lt-refusal-body" lang={words.languageFor('actionCleanup')}>
            {copy.t('actionCleanup')}
          </p>
          <Button tone="primary" lang={words.languageFor('cleanupAction')} onClick={() => void cleanup(snapshot.known!)}>
            {copy.t('cleanupAction')}
          </Button>
        </div>
      )}
      {snapshot.status === 'unreadable' && !snapshot.known && (
        <div data-testid="failure" className="lt-refusal" role="alert">
          <h3 className="lt-refusal-title" lang={words.languageFor('storageTitle')}>
            {copy.t('storageTitle')}
          </h3>
          <p className="lt-refusal-body" lang={words.languageFor('storageBody')}>
            {copy.t('storageBody')}
          </p>
          <Button tone="secondary" lang={words.languageFor('retryStorage')} onClick={redraw}>
            {copy.t('retryStorage')}
          </Button>
        </div>
      )}
    </>
  );
  const request = reviewing;
  const dialog = request ? (
    <Sheet open title={present(request.title)} onClose={() => dismiss(request)}>
      <div className="lt-stack">
        <KitPresented value={request.content} />
        <p className="lt-hint">
          {moreText('common.acting.as.account')}
          <code className="lt-code" lang="zxx">
            {userId}
          </code>
          {moreText('common.the.service.enforces.your.scope.and.jurisdiction')}
        </p>
        <div className="lt-actions">
          <Button tone="secondary" onClick={() => dismiss(request)}>
            {moreText('common.back')}
          </Button>
          <Button tone="primary" data-testid="action-confirm" onClick={() => void send(request)}>
            <KitPresented value={request.confirm} />
          </Button>
        </div>
      </div>
    </Sheet>
  ) : null;
  return { ...controls, feedback, dialog };
}
export type KitAcademyAction = ReturnType<typeof useKitAcademyAction>;
