import { useState } from 'react';
import './support.css';
import type { ScreenProps } from '../../app/screen-types';
import { Articles } from './Articles';
import { ContactForm } from './ContactForm';
import { Requests } from './Requests';
import { StateBlock, useSession } from './deps';
import { supportScreenCopy } from './copy';

/** Help and Support: the help centre, your requests, and the form that opens a new one. */
export default function SupportScreen(_props: ScreenProps) {
  const { t } = supportScreenCopy.useCopy();
  const { userId } = useSession();
  const [sentCount, setSentCount] = useState(0);
  return (
    <div className="if-support">
      <header className="sup-head">
        <h1 className="sup-h1">{t('Help')}</h1>
        <p className="sk-lead">{t('Help lead')}</p>
      </header>
      <div className="sup-grid">
        <div className="sup-main">
          <Articles />
          {userId ? (
            <Requests refreshKey={sentCount} />
          ) : (
            <StateBlock kind="empty" title={t('Sign in to')} action={{ label: t('Sign in'), href: '/login?redirect=%2Fsupport' }} />
          )}
        </div>
        {userId ? (
          <aside className="sup-side">
            <ContactForm onSent={() => setSentCount((value) => value + 1)} />
          </aside>
        ) : null}
      </div>
    </div>
  );
}
