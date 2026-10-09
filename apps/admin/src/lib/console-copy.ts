/** Admin-local authority copy; shared catalogue remains the fallback for existing keys. */
import { createTranslator } from '@intafaced/i18n';
export type ConsoleLocale = 'en' | 'es' | 'fr';
const localCopy = {
  en: {
    'admin.console.transport.reach.module': 'read module state from svc-edge',
    'admin.console.transport.reach.treasury': 'reach ledger freeze and unfreeze procedures',
    'admin.console.transport.title': 'Module writes unavailable',
    'admin.console.transport.compact.guards':
      'Personal operator session and identity-issued approval with original operation context are unavailable here.',
    'admin.console.transport.details': 'Deployment configuration',
    'admin.console.module.room.intro':
      'Inspect the selected module’s current edge state and historical audit. Module writes remain unavailable.',
    'admin.console.transport.treasury.inspect': 'Ledger posting status and freeze prerequisites',
    'admin.console.transport.treasury.inspect.notice':
      'Inspect ledger posting status and freeze prerequisites in Ledger ops. Treasury, live-session and identity-issued approval guards remain authoritative.',
    'admin.console.transport.facts': 'Deployment configuration does not establish action availability.',
    'admin.console.transport.module': 'Module transport',
    'admin.console.transport.treasury': 'Treasury transport',
    'admin.console.transport.configured': 'configured',
    'admin.console.transport.credential.fact': 'transport only; approval required',
    'admin.console.transport.missing': 'unconfigured — missing',
    'admin.console.transport.proxy.configured': 'Proxy gate configured; it is not a personal operator session.',
    'admin.console.transport.proxy.missing': 'Proxy gate unavailable — missing',
    'admin.console.transport.module.guards':
      'Module writes require a real operator session and an identity-issued approval with original operation context. These are unavailable in this desk.',
    'admin.console.transport.treasury.guards':
      'Ledger freeze and unfreeze retain treasury, live-session, identity-issued approval and original operation guards; configuration alone does not establish those prerequisites.',
    'admin.console.transport.disclaimer':
      'Configured means fields are present; reachability and command readiness are unverified. Only missing variable names are shown, never credentials.',
  },
  es: {
    'admin.console.transport.reach.module': 'leer el estado del módulo desde svc-edge',
    'admin.console.transport.reach.treasury': 'acceder a los procedimientos de bloqueo y desbloqueo del libro mayor',
    'admin.console.transport.title': 'Cambios de módulos no disponibles',
    'admin.console.transport.compact.guards':
      'La sesión personal de operador y la aprobación emitida por identidad con el contexto de la operación original no están disponibles aquí.',
    'admin.console.transport.details': 'Configuración del despliegue',
    'admin.console.module.room.intro':
      'Consulta el estado actual del módulo seleccionado y su historial de auditoría. Los cambios de módulos siguen sin estar disponibles.',
    'admin.console.transport.treasury.inspect': 'Estado de contabilización y requisitos de bloqueo del libro mayor',
    'admin.console.transport.treasury.inspect.notice':
      'Consulta el estado de contabilización y los requisitos de bloqueo en Ledger ops. Los requisitos de tesorería, sesión activa y aprobación emitida por identidad siguen siendo obligatorios.',
    'admin.console.transport.facts': 'La configuración del despliegue no demuestra que una acción esté disponible.',
    'admin.console.transport.module': 'Transporte de módulos',
    'admin.console.transport.treasury': 'Transporte de tesorería',
    'admin.console.transport.configured': 'configurado',
    'admin.console.transport.credential.fact': 'solo transporte; se requiere aprobación',
    'admin.console.transport.missing': 'sin configurar — falta',
    'admin.console.transport.proxy.configured': 'La puerta del proxy está configurada; no es una sesión personal de operador.',
    'admin.console.transport.proxy.missing': 'La puerta del proxy no está disponible — falta',
    'admin.console.transport.module.guards':
      'Los cambios de módulos requieren una sesión real de operador y una aprobación emitida por identidad con el contexto de la operación original. No están disponibles en esta consola.',
    'admin.console.transport.treasury.guards':
      'El bloqueo y desbloqueo del libro mayor mantienen los requisitos de tesorería, sesión activa, aprobación emitida por identidad y operación original; la configuración no demuestra que se cumplan.',
    'admin.console.transport.disclaimer':
      'Configurado significa que los campos están presentes; la conexión y la disponibilidad de comandos no están verificadas. Solo se muestran los nombres de variables ausentes, nunca las credenciales.',
  },
  fr: {
    'admin.console.transport.reach.module': 'lire l’état du module depuis svc-edge',
    'admin.console.transport.reach.treasury': 'accéder aux procédures de blocage et de déblocage du grand livre',
    'admin.console.transport.title': 'Modification des modules indisponible',
    'admin.console.transport.compact.guards':
      'La session personnelle d’opérateur et l’approbation émise par identité avec le contexte de l’opération initiale sont indisponibles ici.',
    'admin.console.transport.details': 'Configuration du déploiement',
    'admin.console.module.room.intro':
      'Consultez l’état actuel du module sélectionné et son historique d’audit. La modification des modules reste indisponible.',
    'admin.console.transport.treasury.inspect': 'État des écritures et prérequis du blocage du grand livre',
    'admin.console.transport.treasury.inspect.notice':
      'Consultez l’état des écritures et les prérequis du blocage dans Ledger ops. Les exigences de trésorerie, session active et approbation émise par identité restent obligatoires.',
    'admin.console.transport.facts': 'La configuration du déploiement ne prouve pas qu’une action est disponible.',
    'admin.console.transport.module': 'Transport des modules',
    'admin.console.transport.treasury': 'Transport de trésorerie',
    'admin.console.transport.configured': 'configuré',
    'admin.console.transport.credential.fact': 'transport seul ; approbation requise',
    'admin.console.transport.missing': 'non configuré — absent',
    'admin.console.transport.proxy.configured': 'La porte du proxy est configurée ; ce n’est pas une session personnelle d’opérateur.',
    'admin.console.transport.proxy.missing': 'La porte du proxy est indisponible — absent',
    'admin.console.transport.module.guards':
      'La modification des modules exige une session réelle d’opérateur et une approbation émise par identité avec le contexte de l’opération initiale. Ces prérequis sont indisponibles ici.',
    'admin.console.transport.treasury.guards':
      'Le blocage et le déblocage du grand livre conservent les exigences de trésorerie, session active, approbation émise par identité et opération initiale ; la configuration ne prouve pas qu’elles sont satisfaites.',
    'admin.console.transport.disclaimer':
      'Configuré signifie que les champs sont présents ; la connexion et la disponibilité des commandes ne sont pas vérifiées. Seuls les noms des variables absentes sont affichés, jamais les identifiants secrets.',
  },
} as const;
const translators = {
  en: createTranslator('en', undefined, { mode: 'prod', onMissing: () => undefined }),
  es: createTranslator('es', undefined, { mode: 'prod', onMissing: () => undefined }),
  fr: createTranslator('fr', undefined, { mode: 'prod', onMissing: () => undefined }),
};
export function consoleCopy(
  key: string,
  params: Readonly<Record<string, string | number | bigint>> = {},
  locale: ConsoleLocale = 'en',
): string {
  const copy = localCopy[locale];
  if (Object.hasOwn(copy, key)) return copy[key as keyof typeof copy];
  return translators[locale].tUnsafe(key, params);
}
