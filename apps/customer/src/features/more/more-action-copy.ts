import { defineCopy } from '../../shared/i18n';

const messages = {
  en: {
    storageTitle: 'Recovery storage cannot be read',
    storageBody: 'Keep the original request. This browser cannot safely admit a new action while its recovery storage is unreadable.',
    retryStorage: 'Retry recovery storage',
    cleanup:
      'A service response was received, but local recovery cleanup did not finish. Keep this reference and retry local cleanup before continuing.',
    retryCleanup: 'Retry local cleanup',
  },
  es: {
    storageTitle: 'No se puede leer el almacenamiento de recuperación',
    storageBody:
      'Conserva la solicitud original. Este navegador no puede admitir una acción nueva de forma segura mientras no pueda leer su almacenamiento de recuperación.',
    retryStorage: 'Reintentar el almacenamiento',
    cleanup:
      'Se recibió una respuesta del servicio, pero la limpieza local de recuperación no terminó. Conserva esta referencia y reintenta la limpieza local antes de continuar.',
    retryCleanup: 'Reintentar la limpieza local',
  },
  fr: {
    storageTitle: 'Le stockage de récupération ne peut pas être lu',
    storageBody:
      'Conserve la demande originale. Ce navigateur ne peut pas accepter une nouvelle action en sécurité tant que son stockage de récupération reste illisible.',
    retryStorage: 'Réessayer le stockage',
    cleanup:
      'Une réponse du service a été reçue, mais le nettoyage local de récupération n’a pas abouti. Conserve cette référence et réessaie le nettoyage local avant de continuer.',
    retryCleanup: 'Réessayer le nettoyage local',
  },
} as const;
export const moreActionCopy = defineCopy('more-action', messages.en, { es: messages.es, fr: messages.fr });
