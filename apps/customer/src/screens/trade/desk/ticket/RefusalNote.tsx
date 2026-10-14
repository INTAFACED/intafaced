import { deskCopy } from '../copy';
import type { Failure } from '../preview';

/** The reason a refusal gives, with its action link ("Verify now") when it has one. */
export function RefusalNote({ failure, onRetry }: { failure: Failure; onRetry?: () => void }) {
  const { t } = deskCopy.useCopy();
  if (failure.kind === 'network')
    return (
      <div className="dk-note dk-note--bad" role="alert">
        <p>{t('Couldn’t check the order')}</p>
        {onRetry ? (
          <button type="button" className="dk-link" onClick={onRetry}>
            {t('Check again')}
          </button>
        ) : null}
      </div>
    );
  const { title, body, action, reference } = failure.copy;
  return (
    <div className="dk-note dk-note--bad" role="alert">
      <p className="dk-note-title">{title}</p>
      <p>{body}</p>
      {action ? (
        <a className="dk-link" href={action.href}>
          {action.label}
        </a>
      ) : null}
      {reference ? <p className="dk-note-ref">{reference}</p> : null}
    </div>
  );
}
