import type { Refusal } from '@intafaced/ui/lit/templates';
import { currentPreferences } from './preferences';
import { uiCopy } from './ui-copy';

/**
 * A refusal for want of identity verification (`isVerifyFirst` in `./api`): one plain sentence and the way to Verification,
 * never the gate's tier, module, region code or reason code. A room can hold several cards each refused this way; the app's
 * stylesheet (`shared/styles.css`, `[data-refusal='verify']`) draws the first in full and every later one as its sentence
 * alone, so the ask is made once per room.
 */
export function VerifyFirstNote({ code }: { code?: string }) {
  const { Copy } = uiCopy.useCopy();
  return (
    <div data-testid="failure" className="lt-refusal" data-refusal="verify" data-code={code} role="status">
      <h3 className="lt-refusal-title">
        <Copy k="verifyFirstTitle" />
      </h3>
      <p className="lt-refusal-body">
        <Copy k="verifyFirst" />
      </p>
      <a className="lt-link" href="/verification">
        <Copy k="verifyNow" />
      </a>
    </div>
  );
}

/** The same ask as a room template's refusal (its title, sentence and the way to Verification), for a room drawn on a template. */
export function verifyFirstRefusal(title?: string): Refusal {
  const { t } = uiCopy.forLocale(currentPreferences().language);
  return {
    variant: 'refused',
    title: title ?? t('verifyFirstTitle'),
    body: t('verifyFirst'),
    action: { label: t('verifyNow'), href: '/verification' },
  };
}
