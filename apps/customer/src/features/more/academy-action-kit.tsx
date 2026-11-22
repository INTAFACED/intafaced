/**
 * The Academy's staged action drawn with the kit: the same wait, failure, success, recovery and review states
 * `useAcademyAction` (`academy-action.tsx`) draws with the old parts, from the one logic in `academy-action-state.ts`,
 * with the same words. The review opens in the kit's Sheet, as `useKitAction` (`volt-action.tsx`) does for the More rooms.
 */
import type { ReactNode } from 'react';
import { Button } from '@intafaced/ui/lit';
import { Sheet } from '@intafaced/ui/lit/templates';
import { renderAuthoredCopy } from '../../shared/i18n';
import { uiDirection } from '../../shared/locale';
import { present, type Presented } from './action-state';
import { useAcademyActionState } from './academy-action-state';
import { t as moreText } from './copy';
import { FailureNote, Waiting } from './volt-parts';

/** Authored copy in the language it was found in; anything else is the person's own words. */
function KitPresented({ value }: { value: Presented<ReactNode> }) {
  const shown = typeof value === 'function' ? renderAuthoredCopy(value) : { value, language: 'und' };
  return (
    <span lang={shown.language} dir={shown.language === 'und' ? undefined : uiDirection(shown.language)}>
      {shown.value}
    </span>
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
  const feedback = (
    <>
      {running && <Waiting label={moreText('common.waiting.for.the.service')} />}
      {failure && (
        <div
          lang={
            presentation?.language ??
            (ownedFailure ? words.languageFor(failure.code === 'academy.original_changed' ? 'changed' : 'unavailable') : 'und')
          }
        >
          <FailureNote
            result={
              presentation
                ? { ...failure, message: presentation.message, messageCopy: undefined }
                : ownedFailure
                  ? { ...failure, message: copy.t(failure.code === 'academy.original_changed' ? 'changed' : 'unavailable') }
                  : failure
            }
          />
        </div>
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
          <Button tone="primary" onClick={() => void send(request)}>
            <KitPresented value={request.confirm} />
          </Button>
        </div>
      </div>
    </Sheet>
  ) : null;
  return { ...controls, feedback, dialog };
}
