import { defineCopy, type UiLocale } from './i18n';
import { currentPreferences } from './preferences';

const messages = {
  unauthorized: 'Sign in to continue',
  forbidden: 'Access is restricted',
  not_mounted: 'This service is not connected',
  not_supported: 'This action isn’t supported',
  unreachable: 'Can’t connect right now',
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
  passkeyIdentifier: 'Enter your email or handle before using a passkey.',
  passkeySecure: 'Passkeys require a secure browser connection.',
  passkeyAssertion: 'No passkey assertion was returned.',
  passkeySignInStopped: 'Passkey sign-in was cancelled or timed out.',
  passkeySignInFailed: 'The browser could not complete passkey sign-in.',
  passkeyMissing: 'The browser did not return a new passkey.',
  passkeyCreateStopped: 'Passkey creation was cancelled or timed out.',
  passkeyCreateFailed: 'The browser could not create this passkey.',
} as const;
export const uiCopy: ReturnType<typeof defineCopy<typeof messages>> = defineCopy('shared.ui', messages, {
  es: {
    unauthorized: 'Inicia sesión para continuar',
    forbidden: 'Acceso restringido',
    not_mounted: 'Este servicio no está conectado',
    not_supported: 'Esta acción no está disponible',
    unreachable: 'No se puede conectar ahora',
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
    passkeyIdentifier: 'Introduce tu correo o nombre de usuario antes de usar una clave de acceso.',
    passkeySecure: 'Las claves de acceso requieren una conexión segura en el navegador.',
    passkeyAssertion: 'No se recibió una respuesta de la clave de acceso.',
    passkeySignInStopped: 'El inicio de sesión con clave de acceso se canceló o agotó el tiempo.',
    passkeySignInFailed: 'El navegador no pudo completar el inicio de sesión con la clave de acceso.',
    passkeyMissing: 'El navegador no devolvió una nueva clave de acceso.',
    passkeyCreateStopped: 'La creación de la clave de acceso se canceló o agotó el tiempo.',
    passkeyCreateFailed: 'El navegador no pudo crear esta clave de acceso.',
  },
  fr: {
    unauthorized: 'Connectez-vous pour continuer',
    forbidden: 'Accès restreint',
    not_mounted: 'Ce service n’est pas connecté',
    not_supported: 'Cette action n’est pas disponible',
    unreachable: 'Connexion impossible pour le moment',
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
    passkeyIdentifier: 'Saisissez votre e-mail ou pseudonyme avant d’utiliser une clé d’accès.',
    passkeySecure: 'Les clés d’accès nécessitent une connexion sécurisée dans le navigateur.',
    passkeyAssertion: 'Aucune réponse de la clé d’accès n’a été reçue.',
    passkeySignInStopped: 'La connexion par clé d’accès a été annulée ou a expiré.',
    passkeySignInFailed: 'Le navigateur n’a pas pu terminer la connexion par clé d’accès.',
    passkeyMissing: 'Le navigateur n’a pas renvoyé de nouvelle clé d’accès.',
    passkeyCreateStopped: 'La création de la clé d’accès a été annulée ou a expiré.',
    passkeyCreateFailed: 'Le navigateur n’a pas pu créer cette clé d’accès.',
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
  | 'loadFailed'
  | 'passkeyIdentifier'
  | 'passkeySecure'
  | 'passkeyAssertion'
  | 'passkeySignInStopped'
  | 'passkeySignInFailed'
  | 'passkeyMissing'
  | 'passkeyCreateStopped'
  | 'passkeyCreateFailed';
export type UiMessage = { key: SharedKey } | { key: 'unreadableRefusal' | 'serviceRefusal'; status: number };

export function uiMessage(message: UiMessage, locale: UiLocale = currentPreferences().language) {
  const copy = uiCopy.forLocale(locale);
  return 'status' in message ? copy.t(message.key, { status: message.status }) : copy.t(message.key);
}
