import { defineCopy } from '../../shared/i18n';

/** The API version panel on /uc/safe/api-keys (J-developer-16 #5). */
const messages = {
  title: 'API version',
  intro:
    'Choose the API version your keys use when a program does not request a specific version. If neither is set, API calls are refused instead of switching automatically to a newer version.',
  defaultLabel: 'Account default',
  notSet: 'not set',
  setAt: 'set {when}',
  versionsTitle: 'Available versions',
  newest: 'newest',
  choose: 'Version to use by default',
  save: 'Set as default',
  saving: 'Setting the default',
  saved: 'The account default is now {version}.',
  unchanged: 'The account default was already {version}. Nothing changed.',
  loading: 'Reading the account default',
  deprecationsTitle: 'Deprecated fields',
  deprecationsNone: 'No field is deprecated.',
  colReplacement: 'Use instead',
  colSince: 'Deprecated in',
  colRemoval: 'Removal date',
  removalNotSet: 'removal date not set',
  deprecationsNote: 'API responses flag deprecated fields automatically so you know when to update your integration.',
  'refused.version.unknown': 'That is not a published API version. Nothing changed.',
  'refused.identity.api_version_session_only': 'An API key cannot change the API version. Sign in on a device. Nothing changed.',
} as const;

export const apiVersionCopy = defineCopy('account.api-version', messages, {
  es: {
    title: 'Versión de la API',
    intro:
      'Elige la versión de la API que usan tus claves cuando un programa no solicita una versión concreta. Si no hay ninguna definida, las llamadas se rechazan en lugar de cambiar automáticamente a una versión más reciente.',
    defaultLabel: 'Predeterminada de la cuenta',
    notSet: 'sin definir',
    setAt: 'definida el {when}',
    versionsTitle: 'Versiones disponibles',
    newest: 'más reciente',
    choose: 'Versión predeterminada',
    save: 'Guardar como predeterminada',
    saving: 'Guardando predeterminada',
    saved: 'La versión predeterminada de la cuenta ahora es {version}.',
    unchanged: 'La versión predeterminada de la cuenta ya era {version}. No cambió nada.',
    loading: 'Leyendo la versión predeterminada',
    deprecationsTitle: 'Campos obsoletos',
    deprecationsNone: 'No hay ningún campo obsoleto.',
    colReplacement: 'Usar en su lugar',
    colSince: 'Obsoleto desde',
    colRemoval: 'Fecha de retirada',
    removalNotSet: 'fecha de retirada sin definir',
    deprecationsNote:
      'Las respuestas de la API marcan automáticamente los campos obsoletos para que sepas cuándo actualizar tu integración.',
    'refused.version.unknown': 'Esa no es una versión de la API publicada. No cambió nada.',
    'refused.identity.api_version_session_only':
      'Una clave de API no puede cambiar la versión de la API. Inicia sesión en un dispositivo. No cambió nada.',
  },
  fr: {
    title: 'Version de l’API',
    intro:
      'Choisissez la version d’API utilisée par vos clés lorsqu’un programme ne demande pas de version précise. Si aucune n’est définie, les appels sont refusés plutôt que de passer automatiquement à une version plus récente.',
    defaultLabel: 'Version par défaut du compte',
    notSet: 'non définie',
    setAt: 'définie le {when}',
    versionsTitle: 'Versions disponibles',
    newest: 'la plus récente',
    choose: 'Version à utiliser par défaut',
    save: 'Définir par défaut',
    saving: 'Enregistrement par défaut',
    saved: 'La version par défaut du compte est maintenant {version}.',
    unchanged: 'La version par défaut du compte était déjà {version}. Rien n’a changé.',
    loading: 'Lecture de la version par défaut',
    deprecationsTitle: 'Champs obsolètes',
    deprecationsNone: 'Aucun champ n’est obsolète.',
    colReplacement: 'Utiliser à la place',
    colSince: 'Obsolète depuis',
    colRemoval: 'Date de retrait',
    removalNotSet: 'date de retrait non définie',
    deprecationsNote:
      'Les réponses de l’API signalent automatiquement les champs obsolètes afin que vous sachiez quand mettre à jour votre intégration.',
    'refused.version.unknown': 'Ce n’est pas une version d’API publiée. Rien n’a changé.',
    'refused.identity.api_version_session_only':
      'Une clé d’API ne peut pas changer la version de l’API. Connectez-vous sur un appareil. Rien n’a changé.',
  },
});
