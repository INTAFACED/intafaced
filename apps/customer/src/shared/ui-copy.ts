import { defineCopy, type UiLocale } from './i18n';
import { currentPreferences } from './preferences';

const messages = {
  unauthorized: 'Sign in to continue',
  forbidden: 'Access is restricted',
  not_mounted: 'This service is not connected',
  not_supported: 'This action is unavailable',
  unreachable: 'Connection unavailable',
  invalid_response: 'Information could not be verified',
  aborted: 'Request stopped',
  error: 'The request was refused',
  uncertain: 'Outcome not confirmed',
  signIn: 'Sign in',
  retry: 'Try again',
  loading: 'Loading information',
  closeDialog: 'Close dialog',
  beforeDispatch: 'Request stopped before dispatch.',
  accountChanged: 'The account context changed. Review the action again in the current account.',
  gatewayUnreachable: 'The gateway could not reach the service. Try again when the connection returns.',
  gatewayUncertain: 'The gateway did not confirm an outcome. Check the original request before trying again.',
  unreadableRefusal: 'The request was refused ({status}); no readable explanation was returned.',
  unreadableRead: 'The service returned an unreadable response.',
  unreadableWrite: 'The response could not be read. Check the original request before trying again.',
  serviceRefusal: 'The service refused this request ({status}).',
  unverifiedRead: 'The service response could not be verified.',
  unverifiedWrite: 'The service response could not be verified. Check the original request before trying again.',
  stopped: 'Request stopped.',
  serviceUnreachable: 'The service could not be reached. Try again when the connection returns.',
  connectionUncertain: 'The connection ended before an outcome was confirmed. Check the original request before trying again.',
  loadFailed: 'This information could not be loaded.',
} as const;
export const uiCopy: ReturnType<typeof defineCopy<typeof messages>> = defineCopy('shared.ui', messages, {
  es: {
    unauthorized: 'Inicia sesión para continuar',
    forbidden: 'Acceso restringido',
    not_mounted: 'Este servicio no está conectado',
    not_supported: 'Esta acción no está disponible',
    unreachable: 'Conexión no disponible',
    invalid_response: 'No se pudo verificar la información',
    aborted: 'Solicitud detenida',
    error: 'La solicitud fue rechazada',
    uncertain: 'Resultado sin confirmar',
    signIn: 'Iniciar sesión',
    retry: 'Volver a intentar',
    loading: 'Cargando información',
    closeDialog: 'Cerrar diálogo',
    beforeDispatch: 'La solicitud se detuvo antes de enviarse.',
    accountChanged: 'La cuenta ha cambiado. Revisa la acción de nuevo en la cuenta actual.',
    gatewayUnreachable: 'La pasarela no pudo contactar con el servicio. Inténtalo cuando se restablezca la conexión.',
    gatewayUncertain: 'La pasarela no confirmó el resultado. Comprueba la solicitud original antes de volver a intentarlo.',
    unreadableRefusal: 'La solicitud fue rechazada ({status}); no se recibió una explicación legible.',
    unreadableRead: 'El servicio devolvió una respuesta ilegible.',
    unreadableWrite: 'No se pudo leer la respuesta. Comprueba la solicitud original antes de volver a intentarlo.',
    serviceRefusal: 'El servicio rechazó esta solicitud ({status}).',
    unverifiedRead: 'No se pudo verificar la respuesta del servicio.',
    unverifiedWrite: 'No se pudo verificar la respuesta del servicio. Comprueba la solicitud original antes de volver a intentarlo.',
    stopped: 'Solicitud detenida.',
    serviceUnreachable: 'No se pudo contactar con el servicio. Inténtalo cuando se restablezca la conexión.',
    connectionUncertain:
      'La conexión terminó antes de confirmar el resultado. Comprueba la solicitud original antes de volver a intentarlo.',
    loadFailed: 'No se pudo cargar esta información.',
  },
  fr: {
    unauthorized: 'Connectez-vous pour continuer',
    forbidden: 'Accès restreint',
    not_mounted: 'Ce service n’est pas connecté',
    not_supported: 'Cette action n’est pas disponible',
    unreachable: 'Connexion indisponible',
    invalid_response: 'Les informations n’ont pas pu être vérifiées',
    aborted: 'Requête interrompue',
    error: 'La requête a été refusée',
    uncertain: 'Résultat non confirmé',
    signIn: 'Se connecter',
    retry: 'Réessayer',
    loading: 'Chargement des informations',
    closeDialog: 'Fermer la fenêtre',
    beforeDispatch: 'La requête a été interrompue avant son envoi.',
    accountChanged: 'Le compte a changé. Vérifiez à nouveau l’action dans le compte actuel.',
    gatewayUnreachable: 'La passerelle n’a pas pu joindre le service. Réessayez lorsque la connexion sera rétablie.',
    gatewayUncertain: 'La passerelle n’a pas confirmé le résultat. Vérifiez la requête initiale avant de réessayer.',
    unreadableRefusal: 'La requête a été refusée ({status}) ; aucune explication lisible n’a été reçue.',
    unreadableRead: 'Le service a renvoyé une réponse illisible.',
    unreadableWrite: 'La réponse n’a pas pu être lue. Vérifiez la requête initiale avant de réessayer.',
    serviceRefusal: 'Le service a refusé cette requête ({status}).',
    unverifiedRead: 'La réponse du service n’a pas pu être vérifiée.',
    unverifiedWrite: 'La réponse du service n’a pas pu être vérifiée. Vérifiez la requête initiale avant de réessayer.',
    stopped: 'Requête interrompue.',
    serviceUnreachable: 'Le service n’a pas pu être joint. Réessayez lorsque la connexion sera rétablie.',
    connectionUncertain:
      'La connexion a été interrompue avant la confirmation du résultat. Vérifiez la requête initiale avant de réessayer.',
    loadFailed: 'Ces informations n’ont pas pu être chargées.',
  },
});

type SharedKey =
  | 'beforeDispatch'
  | 'accountChanged'
  | 'gatewayUnreachable'
  | 'gatewayUncertain'
  | 'unreadableRead'
  | 'unreadableWrite'
  | 'unverifiedRead'
  | 'unverifiedWrite'
  | 'stopped'
  | 'serviceUnreachable'
  | 'connectionUncertain'
  | 'loadFailed';
export type UiMessage = { key: SharedKey } | { key: 'unreadableRefusal' | 'serviceRefusal'; status: number };

export function uiMessage(message: UiMessage, locale: UiLocale = currentPreferences().language) {
  const copy = uiCopy.forLocale(locale);
  return 'status' in message ? copy.t(message.key, { status: message.status }) : copy.t(message.key);
}
