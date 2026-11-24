import type { ReactNode } from 'react';
import { Button } from '@intafaced/ui/lit';
import { roomCopy } from './copy';
import { roomRefusal } from './refusals';
import type { Failure } from './guard';
import { isVerifyFirst } from '../../../shared/api';
import { VerifyFirstNote } from '../../../shared/verify-first';

/**
 * The Copy and Bots rooms' two notes, drawn only from the Volt kit (intafaced issue 9564): every room here and the
 * recurring buy on a coin page share them, through `./parts` or directly. Same words and roles as before.
 */

/** A refusal in customer words. The raw code is only a small support reference; a service sentence is never shown. */
export function RefusalNote({ failure, retry }: { failure: Failure; retry?: () => void }) {
  const { t } = roomCopy.useCopy();
  const words = roomRefusal(failure);
  if (isVerifyFirst(failure)) return <VerifyFirstNote code={failure.code} />;
  return (
    <div className="lt-refusal" role="alert" data-refusal="refused" data-tone="warn">
      <p className="lt-refusal-title">{words.title}</p>
      <p className="lt-refusal-body">{words.body}</p>
      {words.code ? <p className="lt-ref">{t('Reference {code}', { code: words.code })}</p> : null}
      {retry ? (
        <Button tone="secondary" onClick={retry}>
          {t('Try again')}
        </Button>
      ) : null}
    </div>
  );
}

/** A plain note; `warn` frames it as a caution. */
export function InfoNote({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'warn' }) {
  const look = tone === 'warn' ? 'lt-stale' : 'lt-hint';
  return (
    <p className={look} role="note" data-tone={tone}>
      <span>{children}</span>
    </p>
  );
}
