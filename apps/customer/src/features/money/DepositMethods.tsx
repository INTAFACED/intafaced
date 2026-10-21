import { depositCopy } from './deposit-copy';
import './deposit-methods.css';

type Method = {
  id: string;
  label: 'methodCrypto' | 'methodCard' | 'methodBank' | 'methodP2p' | 'methodUser';
  note: string;
  href: string | null;
};

const METHODS: readonly Method[] = [
  { id: 'crypto', label: 'methodCrypto', note: 'methodCryptoNote', href: null },
  { id: 'card', label: 'methodCard', note: 'methodPartnerNote', href: '/bank/ramps' },
  { id: 'bank', label: 'methodBank', note: 'methodPartnerNote', href: '/bank/ramps' },
  { id: 'p2p', label: 'methodP2p', note: 'methodP2pNote', href: '/p2p' },
  { id: 'user', label: 'methodUser', note: 'methodUserNote', href: '/pay/receive' },
];

/**
 * The one chooser for how money gets in. Crypto is this page; each other way opens the room that owns it, with that room's own
 * blocker named where one exists. Nothing is hidden: a way whose partner is not connected still lists, and says so.
 */
export function DepositMethods() {
  const { t } = depositCopy.useCopy();
  return (
    <nav className="bd-methods" aria-label={t('methodsLabel')}>
      <h2 className="bd-methods__title">{t('methodsTitle')}</h2>
      <ul className="bd-methods__list">
        {METHODS.map((method) => (
          <li key={method.id} data-method={method.id}>
            {method.href ? (
              <a className="bd-method" href={method.href}>
                <strong>{t(method.label)}</strong>
                <span className="money-caption">{t(method.note as 'methodPartnerNote' | 'methodP2pNote' | 'methodUserNote')}</span>
              </a>
            ) : (
              <div className="bd-method bd-method--here" aria-current="page">
                <strong>{t(method.label)}</strong>
                <span className="money-caption">{t(method.note as 'methodCryptoNote')}</span>
                <span className="bd-method__here">{t('methodHere')}</span>
              </div>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}
