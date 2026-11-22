import { Button, Dialog, Failure, Loading } from '../../shared/ui';
import { PresentedCopy } from './common';
import { t as moreText, Text } from './copy';
import { useAcademyActionState } from './academy-action-state';

/** One compatible action interface supplies every Academy writer, drawn with the old parts; the logic is in academy-action-state.ts. */
export function useAcademyAction() {
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
  const feedback = (
    <>
      {running && <Loading label={moreText('common.waiting.for.the.service')} />}
      {failure && (
        <div
          lang={
            presentation?.language ??
            (ownedFailure
              ? copy.forLocale(language).languageFor(failure.code === 'academy.original_changed' ? 'changed' : 'unavailable')
              : 'und')
          }
          style={{ display: 'contents' }}
        >
          <Failure
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
        <p role="status" className="more-success">
          <PresentedCopy value={shown.success} />
        </p>
      )}
      {snapshot.status === 'other' && !running && (
        <div data-testid="failure" className="failure" role="alert">
          <h3>
            <Text k="common.outcome.not.confirmed" />
          </h3>
          <p>
            <Text k="common.earlier.request" />
            <span lang="und">{snapshot.marker.title}</span>{' '}
            {snapshot.marker.reference && <code lang="zxx">{snapshot.marker.reference}</code>}
            <Text k="common.read.its.original.records.before.continuing" />
          </p>
          <p>
            <Text k="common.this.action.has.no.universal.recovery.lookup" />
          </p>
        </div>
      )}
      {snapshot.known && !snapshot.known.grant && (
        <div data-testid="failure" className="failure">
          <p lang={copy.forLocale(language).languageFor('actionCleanup')}>{copy.t('actionCleanup')}</p>
          <Button lang={copy.forLocale(language).languageFor('cleanupAction')} onClick={() => void cleanup(snapshot.known!)}>
            {copy.t('cleanupAction')}
          </Button>
        </div>
      )}
      {snapshot.status === 'unreadable' && !snapshot.known && (
        <div data-testid="failure" className="failure" role="alert">
          <h3 lang={copy.forLocale(language).languageFor('storageTitle')}>{copy.t('storageTitle')}</h3>
          <p lang={copy.forLocale(language).languageFor('storageBody')}>{copy.t('storageBody')}</p>
          <Button variant="secondary" lang={copy.forLocale(language).languageFor('retryStorage')} onClick={redraw}>
            {copy.t('retryStorage')}
          </Button>
        </div>
      )}
    </>
  );
  const request = reviewing;
  const dialog = request ? (
    <Dialog title={<PresentedCopy value={request.title} />} onClose={() => dismiss(request)}>
      <PresentedCopy value={request.content} />
      <p className="muted">
        <Text k="common.acting.as.account" />
        <code lang="zxx">{userId}</code>
        <Text k="common.the.service.enforces.your.scope.and.jurisdiction" />
      </p>
      <div className="actions">
        <Button variant="secondary" onClick={() => dismiss(request)}>
          <Text k="common.back" />
        </Button>
        <Button onClick={() => void send(request)}>
          <PresentedCopy value={request.confirm} />
        </Button>
      </div>
    </Dialog>
  ) : null;
  return { ...controls, feedback, dialog };
}
export type AcademyAction = ReturnType<typeof useAcademyAction>;
