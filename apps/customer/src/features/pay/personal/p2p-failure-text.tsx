import { p2pChatCopy } from './p2p-chat-copy';
import type { ServiceFailure } from './p2p-chat-model';

type ChatT = ReturnType<typeof p2pChatCopy.useCopy>['t'];

/** The plain sentence for a kind of refusal. No service text and no code ever reaches the customer. */
function failureText(t: ChatT, kind: ServiceFailure): string {
  switch (kind) {
    case 'signIn':
      return t('failSignIn');
    case 'notParty':
      return t('failNotParty');
    case 'readOnly':
      return t('failReadOnly');
    case 'verify':
      return t('failVerify');
    case 'region':
      return t('failRegion');
    case 'textRequired':
      return t('failTextRequired');
    case 'attachment':
      return t('failAttachment');
    case 'self':
      return t('failSelf');
    case 'conflict':
      return t('failConflict');
    case 'inProgress':
      return t('failInProgress');
    case 'unconfirmed':
      return t('failUnconfirmed');
    case 'noService':
      return t('failNoService');
    case 'viewChanged':
      return t('failViewChanged');
    case 'generic':
      return t('failGeneric');
  }
}

/** A refusal in words, with the way forward when there is one (verification is a page of its own). */
export function FailureText({ kind }: { kind: ServiceFailure }) {
  const { t } = p2pChatCopy.useCopy();
  return (
    <>
      {failureText(t, kind)}
      {kind === 'verify' ? (
        <>
          {' '}
          <a className="lt-link" href="/verification">
            {t('failVerifyLink')}
          </a>
        </>
      ) : null}
    </>
  );
}
