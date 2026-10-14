import type { ReactNode } from 'react';
import { accountScreenCopy } from '../../account/copy';
import { sections, type Section } from '../../account/sections';
import '../../account/account.css';
import '../tools.css';

/**
 * The Account area's frame for the M9 tools: the same 220 px sub-nav as Account, Security and Verification
 * (`screens/account`), with a wider column because these pages hold tables.
 */
export function AccountFrame({ here, children }: { here: Section; children: ReactNode }) {
  const { t } = accountScreenCopy.useCopy();
  return (
    <div className="acct acct--tools" data-section={here}>
      <nav className="acct-nav" aria-label={t('Settings sections')}>
        <p className="acct-nav__title">{t('Settings')}</p>
        <ul>
          {sections.map((section) => (
            <li key={section.id}>
              <a href={section.href} aria-current={section.id === here ? 'page' : undefined}>
                {t(section.title)}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="acct-body tools">{children}</div>
    </div>
  );
}

/** A heading with its one-line purpose and, on the right, the screen's main action. */
export function ToolsHeading({ title, line, action }: { title: string; line: string; action?: ReactNode }) {
  return (
    <header className="tools-head">
      <div className="tools-head__text">
        <h1 className="tools-h1">{title}</h1>
        <p className="tools-line">{line}</p>
      </div>
      {action ? <div className="tools-head__action">{action}</div> : null}
    </header>
  );
}
