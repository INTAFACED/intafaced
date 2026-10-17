import { defineCopy } from '../shared/i18n';

const messages = {
  'This room could not open': 'This room could not open',
  'The interface encountered an error': 'The interface encountered an error',
  'Reload the app': 'Reload the app',
  'Reload to try again. You will need to sign in again. An unconfirmed financial request must still be checked before retrying.':
    'Reload to try again. You will need to sign in again. An unconfirmed financial request must still be checked before retrying.',
  'Page not found': 'Page not found',
  '{name} price': '{name} price',
  'This address is not available': 'This address is not available',
  'Return to one of the four customer doors.': 'Return to one of the four customer doors.',
  'Return to one of the customer tabs.': 'Return to one of the customer tabs.',
  'Separate team desk': 'Separate team desk',
  'Open the operator console': 'Open the operator console',
  'Open Team': 'Open Team',
  'Back to home': 'Back to home',
  'Founders and operators work in a separate console with its own sign-in. This app has no operator tools, and nothing on this page shows or changes company data.':
    'Founders and operators work in a separate console with its own sign-in. This app has no operator tools, and nothing on this page shows or changes company data.',
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
  'We could not check your sign-in': 'We could not check your sign-in',
  'The account service did not answer. Your sign-in is not lost; try again.':
    'The account service did not answer. Your sign-in is not lost; try again.',
  Retry: 'Retry',
  'Pick an offer to edit': 'Pick an offer to edit',
  'Open your offers and choose one to review. Changing an offer after it is published is not available.':
    'Open your offers and choose one to review. Changing an offer after it is published is not available.',
  'Go to my offers': 'Go to my offers',
} as const;

export const appCopy: ReturnType<typeof defineCopy<typeof messages>> = defineCopy('customer.app', messages, {
  es: {
    'This room could not open': 'No se pudo abrir esta sección',
    'The interface encountered an error': 'La interfaz encontró un error',
    'Reload the app': 'Recargar la aplicación',
    'Reload to try again. You will need to sign in again. An unconfirmed financial request must still be checked before retrying.':
      'Recarga para volver a intentarlo. Tendrás que iniciar sesión de nuevo. Comprueba cualquier solicitud financiera no confirmada antes de repetirla.',
    'Page not found': 'Página no encontrada',
    '{name} price': 'Precio de {name}',
    'This address is not available': 'Esta dirección no está disponible',
    'Return to one of the four customer doors.': 'Vuelve a una de las cuatro secciones del cliente.',
    'Return to one of the customer tabs.': 'Vuelve a una de las pestañas del cliente.',
    'Pick an offer to edit': 'Elige una oferta para editar',
    'Open your offers and choose one to review. Changing an offer after it is published is not available.':
      'Abre tus ofertas y elige una para revisarla. Cambiar una oferta ya publicada no está disponible.',
    'Go to my offers': 'Ir a mis ofertas',
    'Separate team desk': 'Mesa independiente del equipo',
    'Open the operator console': 'Abrir la consola del operador',
    'Open Team': 'Abrir Team',
    'Back to home': 'Volver al inicio',
    'Founders and operators work in a separate console with its own sign-in. This app has no operator tools, and nothing on this page shows or changes company data.':
      'Los fundadores y operadores trabajan en una consola aparte, con su propio inicio de sesión. Esta app no tiene herramientas de operador, y nada de esta página muestra ni cambia datos de la empresa.',
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
    'We could not check your sign-in': 'No pudimos comprobar tu inicio de sesión',
    'The account service did not answer. Your sign-in is not lost; try again.':
      'El servicio de cuentas no respondió. No se perdió tu sesión; inténtalo de nuevo.',
    Retry: 'Reintentar',
  },
  fr: {
    'This room could not open': 'Cet espace n’a pas pu s’ouvrir',
    'The interface encountered an error': 'L’interface a rencontré une erreur',
    'Reload the app': 'Recharger l’application',
    'Reload to try again. You will need to sign in again. An unconfirmed financial request must still be checked before retrying.':
      'Rechargez pour réessayer. Vous devrez vous reconnecter. Toute demande financière non confirmée doit être vérifiée avant une nouvelle tentative.',
    'Page not found': 'Page introuvable',
    '{name} price': 'Prix {name}',
    'This address is not available': 'Cette adresse n’est pas disponible',
    'Return to one of the four customer doors.': 'Retournez dans l’un des quatre espaces clients.',
    'Return to one of the customer tabs.': 'Retournez dans l’un des onglets clients.',
    'Pick an offer to edit': 'Choisissez une offre à modifier',
    'Open your offers and choose one to review. Changing an offer after it is published is not available.':
      'Ouvrez vos offres et choisissez-en une à consulter. Modifier une offre déjà publiée n’est pas disponible.',
    'Go to my offers': 'Aller à mes offres',
    'Separate team desk': 'Console séparée de l’équipe',
    'Open the operator console': 'Ouvrir la console opérateur',
    'Open Team': 'Ouvrir Team',
    'Back to home': 'Retour à l’accueil',
    'Founders and operators work in a separate console with its own sign-in. This app has no operator tools, and nothing on this page shows or changes company data.':
      'Les fondateurs et les opérateurs travaillent dans une console séparée, avec sa propre connexion. Cette application n’a aucun outil d’opérateur, et rien sur cette page n’affiche ni ne modifie les données de l’entreprise.',
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
    'We could not check your sign-in': 'Nous n’avons pas pu vérifier votre connexion',
    'The account service did not answer. Your sign-in is not lost; try again.':
      'Le service des comptes n’a pas répondu. Votre connexion n’est pas perdue ; réessayez.',
    Retry: 'Réessayer',
  },
});
