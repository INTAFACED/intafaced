import { defineCopy } from '../shared/i18n';

const messages = {
  'This room could not open': 'This room could not open',
  'The interface encountered an error': 'The interface encountered an error',
  'Reload the app': 'Reload the app',
  'Reload to try again. You will need to sign in again. An unconfirmed financial request must still be checked before retrying.':
    'Reload to try again. You will need to sign in again. An unconfirmed financial request must still be checked before retrying.',
  'Page not found': 'Page not found',
  'This address is not available': 'This address is not available',
  'Return to one of the four customer doors.': 'Return to one of the four customer doors.',
  'Return to one of the customer tabs.': 'Return to one of the customer tabs.',
  'Separate team desk': 'Separate team desk',
  'Open the operator console': 'Open the operator console',
  'Open Team': 'Open Team',
  'The team desk uses separate operator authentication.': 'The team desk uses separate operator authentication.',
  'The Team deployment address is not configured. Ask your operator for the verified console address.':
    'The Team deployment address is not configured. Ask your operator for the verified console address.',
  'This room is parked': 'This room is parked',
  'Chain services are not active': 'Chain services are not active',
  'This room remains reserved until owner activation. It is not available from customer navigation or search.':
    'This room remains reserved until owner activation. It is not available from customer navigation or search.',
  'Sign in': 'Sign in',
  'Sign in to continue': 'Sign in to continue',
  'Your account context is needed before this room can show private information.':
    'Your account context is needed before this room can show private information.',
  'Opening room': 'Opening room',
} as const;

export const appCopy: ReturnType<typeof defineCopy<typeof messages>> = defineCopy('customer.app', messages, {
  es: {
    'This room could not open': 'No se pudo abrir esta sección',
    'The interface encountered an error': 'La interfaz encontró un error',
    'Reload the app': 'Recargar la aplicación',
    'Reload to try again. You will need to sign in again. An unconfirmed financial request must still be checked before retrying.':
      'Recarga para volver a intentarlo. Tendrás que iniciar sesión de nuevo. Comprueba cualquier solicitud financiera no confirmada antes de repetirla.',
    'Page not found': 'Página no encontrada',
    'This address is not available': 'Esta dirección no está disponible',
    'Return to one of the four customer doors.': 'Vuelve a una de las cuatro secciones del cliente.',
    'Return to one of the customer tabs.': 'Vuelve a una de las pestañas del cliente.',
    'Separate team desk': 'Mesa independiente del equipo',
    'Open the operator console': 'Abrir la consola del operador',
    'Open Team': 'Abrir Team',
    'The team desk uses separate operator authentication.': 'La mesa del equipo usa una autenticación independiente para operadores.',
    'The Team deployment address is not configured. Ask your operator for the verified console address.':
      'La dirección de Team no está configurada. Pide al operador la dirección verificada de la consola.',
    'This room is parked': 'Esta sección está en espera',
    'Chain services are not active': 'Los servicios de cadena no están activos',
    'This room remains reserved until owner activation. It is not available from customer navigation or search.':
      'Esta sección está reservada hasta que el propietario la active. No está disponible en la navegación ni en la búsqueda del cliente.',
    'Sign in': 'Iniciar sesión',
    'Sign in to continue': 'Inicia sesión para continuar',
    'Your account context is needed before this room can show private information.':
      'Esta sección necesita el contexto de tu cuenta para mostrar información privada.',
    'Opening room': 'Abriendo sección',
  },
  fr: {
    'This room could not open': 'Cet espace n’a pas pu s’ouvrir',
    'The interface encountered an error': 'L’interface a rencontré une erreur',
    'Reload the app': 'Recharger l’application',
    'Reload to try again. You will need to sign in again. An unconfirmed financial request must still be checked before retrying.':
      'Rechargez pour réessayer. Vous devrez vous reconnecter. Toute demande financière non confirmée doit être vérifiée avant une nouvelle tentative.',
    'Page not found': 'Page introuvable',
    'This address is not available': 'Cette adresse n’est pas disponible',
    'Return to one of the four customer doors.': 'Retournez dans l’un des quatre espaces clients.',
    'Return to one of the customer tabs.': 'Retournez dans l’un des onglets clients.',
    'Separate team desk': 'Console séparée de l’équipe',
    'Open the operator console': 'Ouvrir la console opérateur',
    'Open Team': 'Ouvrir Team',
    'The team desk uses separate operator authentication.': 'La console de l’équipe utilise une authentification opérateur séparée.',
    'The Team deployment address is not configured. Ask your operator for the verified console address.':
      'L’adresse de déploiement de Team n’est pas configurée. Demandez à votre opérateur l’adresse vérifiée de la console.',
    'This room is parked': 'Cet espace est en attente',
    'Chain services are not active': 'Les services de chaîne ne sont pas actifs',
    'This room remains reserved until owner activation. It is not available from customer navigation or search.':
      'Cet espace reste réservé jusqu’à son activation par le propriétaire. Il est absent de la navigation et de la recherche clients.',
    'Sign in': 'Se connecter',
    'Sign in to continue': 'Connectez-vous pour continuer',
    'Your account context is needed before this room can show private information.':
      'Le contexte de votre compte est nécessaire pour afficher des informations privées dans cet espace.',
    'Opening room': 'Ouverture de l’espace',
  },
});
