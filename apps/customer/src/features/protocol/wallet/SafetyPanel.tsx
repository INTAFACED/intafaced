import { Panel } from '../../../shared/ui';
import { usePreferences } from '../../../shared/preferences';
import { WALLET_SECTIONS } from '../routes';
import { safetyCopy } from './safety-copy';

/** One "Stay safe" habit and the control it opens. Every target is a real route of the app. */
export const SAFETY_LESSONS = [
  { id: 'address', href: '/chain' },
  { id: 'testSend', href: WALLET_SECTIONS.send },
  { id: 'book', href: WALLET_SECTIONS.addressBook },
  { id: 'approvals', href: WALLET_SECTIONS.approvals },
  { id: 'sessions', href: WALLET_SECTIONS.sessionKeys },
  { id: 'tokens', href: '/dex/tokens' },
  { id: 'audit', href: '/chain/audit' },
] as const;

/** The compromise steps, in the order they are done, each linked to its control. */
export const COMPROMISE_STEPS = [
  { id: 'sessions', href: WALLET_SECTIONS.sessionKeys },
  { id: 'approvals', href: WALLET_SECTIONS.approvals },
  { id: 'move', href: WALLET_SECTIONS.send },
] as const;

/**
 * /wallet/safety (D-portfolio-wallet-02 (c) and (d), D-developer-compliance-02): the safety habits, each linking to its
 * control; what to do if the wallet is compromised, in order, with no recovery promise; and the disclosures, which say
 * plainly what is not published (`compliance.disclosure_unset`) rather than inventing a policy or a bounty.
 */
export function SafetyPanel() {
  const { language } = usePreferences();
  const { t } = safetyCopy.forLocale(language);
  return (
    <>
      <Panel title={t('safetyTitle')}>
        <p className="muted">{t('safetyNote')}</p>
        <ul aria-label={t('safetyTitle')}>
          {SAFETY_LESSONS.map((lesson) => (
            <li key={lesson.id}>
              {t(`lesson_${lesson.id}`)} <a href={lesson.href}>{t(`lesson_${lesson.id}Link`)}</a>
            </li>
          ))}
        </ul>
        <p role="note">{t('neverAsk')}</p>
      </Panel>
      <Panel title={t('compromiseTitle')}>
        <p>{t('compromiseNote')}</p>
        <ol aria-label={t('compromiseTitle')}>
          {COMPROMISE_STEPS.map((step) => (
            <li key={step.id}>
              <a href={step.href}>{t(`compromise_${step.id}`)}</a> {t(`compromise_${step.id}Why`)}
            </li>
          ))}
        </ol>
        <p role="note">{t('compromiseNoRecovery')}</p>
      </Panel>
      <Panel title={t('disclosureTitle')}>
        <p data-code="compliance.disclosure_unset">{t('disclosureUnset')}</p>
        <p>{t('bountyUnset')}</p>
        <p>
          {t('disclosureAudit')} <a href="/chain/audit">{t('lesson_auditLink')}</a>
        </p>
      </Panel>
    </>
  );
}
