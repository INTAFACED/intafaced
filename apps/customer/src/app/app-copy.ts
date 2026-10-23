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
  'Sign in so this page can check whether your account is a founder account.':
    'Sign in so this page can check whether your account is a founder account.',
  'Checking founder access…': 'Checking founder access…',
  'Founder access could not be checked': 'Founder access could not be checked',
  'The account service did not answer, so this page offers no console link. Your sign-in is not lost; try again.':
    'The account service did not answer, so this page offers no console link. Your sign-in is not lost; try again.',
  'Founder access for this account has been revoked, so this page offers no console link.':
    'Founder access for this account has been revoked, so this page offers no console link.',
  'Founder accounts are not configured on this platform, so this page offers no console link.':
    'Founder accounts are not configured on this platform, so this page offers no console link.',
  'This page is for founders. Your account is not a founder account, and your own tools are in the app.':
    'This page is for founders. Your account is not a founder account, and your own tools are in the app.',
  'Nothing to open here': 'Nothing to open here',
  'Open merchant admin': 'Open merchant admin',
  'Your business team, roles and settings are managed in merchant admin.':
    'Your business team, roles and settings are managed in merchant admin.',
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
    'Sign in so this page can check whether your account is a founder account.':
      'Inicia sesión para que esta página compruebe si tu cuenta es de fundador.',
    'Checking founder access…': 'Comprobando el acceso de fundador…',
    'Founder access could not be checked': 'No se pudo comprobar el acceso de fundador',
    'The account service did not answer, so this page offers no console link. Your sign-in is not lost; try again.':
      'El servicio de cuentas no respondió, así que esta página no ofrece enlace a la consola. No has perdido tu sesión; vuelve a intentarlo.',
    'Founder access for this account has been revoked, so this page offers no console link.':
      'El acceso de fundador de esta cuenta fue revocado, así que esta página no ofrece enlace a la consola.',
    'Founder accounts are not configured on this platform, so this page offers no console link.':
      'Las cuentas de fundador no están configuradas en esta plataforma, así que esta página no ofrece enlace a la consola.',
    'This page is for founders. Your account is not a founder account, and your own tools are in the app.':
      'Esta página es para fundadores. Tu cuenta no es de fundador y tus herramientas están en la aplicación.',
    'Nothing to open here': 'Nada que abrir aquí',
    'Open merchant admin': 'Abrir la administración del comercio',
    'Your business team, roles and settings are managed in merchant admin.':
      'El equipo, los roles y los ajustes de tu empresa se gestionan en la administración del comercio.',
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
    'Sign in so this page can check whether your account is a founder account.':
      'Connectez-vous pour que cette page vérifie si votre compte est un compte fondateur.',
    'Checking founder access…': 'Vérification de l’accès fondateur…',
    'Founder access could not be checked': 'L’accès fondateur n’a pas pu être vérifié',
    'The account service did not answer, so this page offers no console link. Your sign-in is not lost; try again.':
      'Le service des comptes n’a pas répondu ; cette page ne propose donc aucun lien vers la console. Votre connexion n’est pas perdue ; réessayez.',
    'Founder access for this account has been revoked, so this page offers no console link.':
      'L’accès fondateur de ce compte a été révoqué ; cette page ne propose donc aucun lien vers la console.',
    'Founder accounts are not configured on this platform, so this page offers no console link.':
      'Les comptes fondateurs ne sont pas configurés sur cette plateforme ; cette page ne propose donc aucun lien vers la console.',
    'This page is for founders. Your account is not a founder account, and your own tools are in the app.':
      'Cette page est réservée aux fondateurs. Votre compte n’est pas un compte fondateur, et vos outils sont dans l’application.',
    'Nothing to open here': 'Rien à ouvrir ici',
    'Open merchant admin': 'Ouvrir l’administration marchande',
    'Your business team, roles and settings are managed in merchant admin.':
      'L’équipe, les rôles et les réglages de votre entreprise se gèrent dans l’administration marchande.',
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
