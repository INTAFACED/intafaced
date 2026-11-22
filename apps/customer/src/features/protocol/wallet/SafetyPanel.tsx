// volt-room: /wallet/safety
import { ReadingTemplate, Tabs } from '@intafaced/ui/lit/templates';
import { usePreferences } from '../../../shared/preferences';
import { protocolCopy } from '../copy';
import { WALLET_SECTIONS, type WalletSection } from '../routes';
import { walletCopy } from './copy';
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

/** The wallet's sections, in the order its other sections list them, each a link to its own path. */
const SECTIONS = Object.keys(WALLET_SECTIONS) as WalletSection[];

/**
 * /wallet/safety (D-portfolio-wallet-02 (c) and (d), D-developer-compliance-02), on the reading template: the safety
 * habits, each linking to its control; what to do if the wallet is compromised, in order, with no recovery promise; and
 * the disclosures, which say plainly what is not published (`compliance.disclosure_unset`) rather than inventing a policy
 * or a bounty. The wallet's sections stay one link each.
 */
export function SafetyPanel() {
  const { language } = usePreferences();
  const { t } = safetyCopy.forLocale(language);
  const { t: tw, renderedLocale } = walletCopy.forLocale(language);
  const { t: tp } = protocolCopy.forLocale(language);
  return (
    <div lang={renderedLocale} data-route="wallet">
      <ReadingTemplate
        title={tw('title')}
        description={tw('description')}
        state={{ kind: 'ready' }}
        meta={
          <p className="lt-hint">
            {tw('bannerLine')} <span className="lt-chip">{tp('bannerPill')}</span>
          </p>
        }
        toc={
          <Tabs
            label={tw('sections')}
            current={WALLET_SECTIONS.safety}
            items={SECTIONS.map((id) => ({ label: tw(`section_${id}`), href: WALLET_SECTIONS[id] }))}
          />
        }
        body={
          <>
            <section aria-labelledby="wallet-safety-habits">
              <h2 id="wallet-safety-habits">{t('safetyTitle')}</h2>
              <p className="lt-hint">{t('safetyNote')}</p>
              <ul aria-label={t('safetyTitle')}>
                {SAFETY_LESSONS.map((lesson) => (
                  <li key={lesson.id}>
                    {t(`lesson_${lesson.id}`)}{' '}
                    <a className="lt-link" href={lesson.href}>
                      {t(`lesson_${lesson.id}Link`)}
                    </a>
                  </li>
                ))}
              </ul>
              <p role="note">{t('neverAsk')}</p>
            </section>
            <section aria-labelledby="wallet-safety-compromise">
              <h2 id="wallet-safety-compromise">{t('compromiseTitle')}</h2>
              <p>{t('compromiseNote')}</p>
              <ol aria-label={t('compromiseTitle')}>
                {COMPROMISE_STEPS.map((step) => (
                  <li key={step.id}>
                    <a className="lt-link" href={step.href}>
                      {t(`compromise_${step.id}`)}
                    </a>{' '}
                    {t(`compromise_${step.id}Why`)}
                  </li>
                ))}
              </ol>
              <p role="note">{t('compromiseNoRecovery')}</p>
            </section>
          </>
        }
        related={
          <section aria-labelledby="wallet-safety-disclosure">
            <h2 id="wallet-safety-disclosure">{t('disclosureTitle')}</h2>
            <p data-code="compliance.disclosure_unset">{t('disclosureUnset')}</p>
            <p>{t('bountyUnset')}</p>
            <p>
              {t('disclosureAudit')}{' '}
              <a className="lt-link" href="/chain/audit">
                {t('lesson_auditLink')}
              </a>
            </p>
          </section>
        }
      />
    </div>
  );
}
