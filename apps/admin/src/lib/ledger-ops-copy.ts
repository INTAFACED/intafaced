export type LedgerLocale = 'en' | 'es' | 'fr';
const en = {
  title: 'Ledger operations',
  intro:
    'Read the ledger posting record and its last change. A freeze takes two different operators and an unfreeze two different current founders (identity enforces both; this console admits only founders). Both are disabled until the ledger read returns its version. Reconciliation controls are below the transaction lookup.',
  record: 'Ledger posting record',
  completed: 'Latest completed read · last change recorded below',
  refresh: 'Refresh',
  retry: 'Retry read',
  loading: 'Reading posting record…',
  frozen: 'Posting frozen',
  open: 'Posting not frozen',
  recordOnly: 'The returned record reports posting state. It does not confirm any original request.',
  unconfigured: 'Read unavailable',
  absent: 'Read route unavailable',
  refused: 'Read refused',
  unreachable: 'Read unreachable',
  invalid: 'Invalid posting response',
  noSnapshot: 'No posting snapshot is displayed. Retry sends GET only; an old reason, actor or last-change time stays hidden.',
  reason: 'Recorded reason',
  actor: 'Last recorded actor',
  changed: 'Last change · not read time',
  nullReason: 'No reason recorded',
  nullActor: 'No actor recorded',
  actorSelf: 'You',
  actorUnnamed: 'Account, id ends',
  asOf: 'As of · when this console read the ledger',
  original: 'Original operations',
  historyMissing:
    'Original operation lookup is unavailable. This posting record is not command history or a receipt. Earlier transient outcomes cannot be recovered from the current state.',
  privateMissing:
    'No verified current human ownership is available here. Original private inputs are not displayed, restored or replayed from this record.',
  commands: 'Freeze and unfreeze',
  transport: 'Credential transport',
  configured: 'Configured transport only. Service reachability and action prerequisites are separate.',
  notConfigured: 'Not configured. Missing names:',
  stateUnknown: 'The posting record could not be read, so no freeze or unfreeze can be requested. Retry the read first.',
  versionMissing:
    'svc-ledger’s read does not return the posting version that freeze and unfreeze approvals are bound to, so neither can be requested yet. Nothing can be sent. This is filed as a back-end need.',
  consequenceFreeze:
    'A freeze stops ledger posting platform-wide: every module posts through the ledger. Two different operators must agree (this console admits only founders). Resuming is a separate request, after reconciliation.',
  consequenceThaw:
    'An unfreeze resumes value movement platform-wide. Two different current founders must agree (identity enforces it), and the cause of the freeze must be resolved first.',
  freezeReasonLabel: 'Why (recorded with the freeze, 12 to 500 characters)',
  thawReasonLabel: 'Not needed: an unfreeze clears the recorded reason',
} as const;
type LedgerCopy = { readonly [K in keyof typeof en]: string };
const es: LedgerCopy = {
  title: 'Operaciones del libro',
  intro:
    'Consulta el estado de contabilización y su último cambio. Congelar requiere a dos operadores distintos y reanudar a dos fundadores actuales distintos (identity lo exige; esta consola solo admite fundadores); ambos están desactivados hasta que la lectura del libro devuelva su versión. Los controles de conciliación están debajo de la consulta de transacciones.',
  record: 'Registro de contabilización',
  completed: 'Última lectura completada · último cambio abajo',
  refresh: 'Actualizar',
  retry: 'Reintentar lectura',
  loading: 'Leyendo el registro…',
  frozen: 'Contabilización congelada',
  open: 'Contabilización no congelada',
  recordOnly: 'El registro devuelto indica el estado de contabilización. No confirma ninguna solicitud original.',
  unconfigured: 'Lectura no disponible',
  absent: 'Ruta de lectura no disponible',
  refused: 'Lectura rechazada',
  unreachable: 'Lectura inaccesible',
  invalid: 'Respuesta de contabilización inválida',
  noSnapshot: 'No se muestra ningún registro. Reintentar solo envía GET; el motivo, actor y fecha anteriores permanecen ocultos.',
  reason: 'Motivo registrado',
  actor: 'Último actor registrado',
  changed: 'Último cambio · no es la hora de lectura',
  nullReason: 'Sin motivo registrado',
  nullActor: 'Sin actor registrado',
  actorSelf: 'Usted',
  actorUnnamed: 'Cuenta, id termina en',
  asOf: 'A fecha de · cuando esta consola leyó el libro',
  original: 'Operaciones originales',
  historyMissing:
    'La consulta de operaciones originales no está disponible. Este registro no es un historial ni un recibo. No permite recuperar resultados transitorios anteriores.',
  privateMissing:
    'No se puede verificar al propietario humano actual. No se muestran, restauran ni repiten entradas privadas a partir de este registro.',
  commands: 'Congelar y reanudar',
  transport: 'Transporte de credenciales',
  configured: 'Solo el transporte está configurado. La accesibilidad del servicio y los requisitos de acción son independientes.',
  notConfigured: 'Sin configurar. Nombres ausentes:',
  stateUnknown: 'No se pudo leer el registro de contabilización, así que no se puede solicitar congelar ni reanudar. Reintenta la lectura.',
  versionMissing:
    'La lectura de svc-ledger no devuelve la versión de contabilización a la que se vinculan las aprobaciones, así que todavía no se puede solicitar ni congelar ni reanudar. No se puede enviar nada. Está registrado como necesidad del servicio.',
  consequenceFreeze:
    'Congelar detiene la contabilización de toda la plataforma: todos los módulos contabilizan a través del libro. Deben estar de acuerdo dos operadores distintos (esta consola solo admite fundadores). Reanudar es otra solicitud, tras la conciliación.',
  consequenceThaw:
    'Reanudar restablece el movimiento de valor en toda la plataforma. Deben estar de acuerdo dos fundadores actuales distintos (identity lo exige), y la causa de la congelación debe estar resuelta.',
  freezeReasonLabel: 'Motivo (se registra con la congelación, de 12 a 500 caracteres)',
  thawReasonLabel: 'No hace falta: reanudar borra el motivo registrado',
};
const fr: LedgerCopy = {
  title: 'Opérations du registre',
  intro:
    'Consultez l’état des écritures et son dernier changement. Le gel demande deux opérateurs différents et la reprise deux fondateurs actuels différents (identity l’impose ; cette console n’admet que des fondateurs) ; les deux sont désactivés tant que la lecture du registre ne renvoie pas sa version. Les contrôles de rapprochement sont sous la recherche de transaction.',
  record: 'État des écritures',
  completed: 'Dernière lecture terminée · dernier changement ci-dessous',
  refresh: 'Actualiser',
  retry: 'Réessayer la lecture',
  loading: 'Lecture de l’état…',
  frozen: 'Écritures gelées',
  open: 'Écritures non gelées',
  recordOnly: 'L’état retourné décrit les écritures. Il ne confirme aucune demande originale.',
  unconfigured: 'Lecture indisponible',
  absent: 'Route de lecture indisponible',
  refused: 'Lecture refusée',
  unreachable: 'Lecture inaccessible',
  invalid: 'Réponse des écritures invalide',
  noSnapshot: 'Aucun état n’est affiché. Réessayer envoie uniquement GET ; les anciens motif, acteur et horodatage restent masqués.',
  reason: 'Motif enregistré',
  actor: 'Dernier acteur enregistré',
  changed: 'Dernier changement · pas l’heure de lecture',
  nullReason: 'Aucun motif enregistré',
  nullActor: 'Aucun acteur enregistré',
  actorSelf: 'Vous',
  actorUnnamed: 'Compte, id se termine par',
  asOf: 'À la date de · quand cette console a lu le registre',
  original: 'Opérations originales',
  historyMissing:
    'La recherche des opérations originales est indisponible. Cet état n’est ni un historique ni un reçu. Il ne permet pas de récupérer les résultats transitoires antérieurs.',
  privateMissing:
    'La propriété humaine actuelle ne peut pas être vérifiée. Les données privées originales ne sont ni affichées, ni restaurées, ni rejouées à partir de cet état.',
  commands: 'Gel et reprise',
  transport: 'Transport des identifiants',
  configured: 'Seul le transport est configuré. L’accessibilité du service et les prérequis d’action sont distincts.',
  notConfigured: 'Non configuré. Noms manquants :',
  stateUnknown: 'L’état des écritures n’a pas pu être lu : ni gel ni reprise ne peut être demandé. Réessayez la lecture.',
  versionMissing:
    'La lecture de svc-ledger ne renvoie pas la version des écritures à laquelle les approbations sont liées : ni gel ni reprise ne peut être demandé pour l’instant. Rien ne peut être envoyé. C’est enregistré comme besoin du service.',
  consequenceFreeze:
    'Le gel arrête les écritures sur toute la plateforme : chaque module écrit via le registre. Deux opérateurs différents doivent être d’accord (cette console n’admet que des fondateurs). La reprise est une demande distincte, après rapprochement.',
  consequenceThaw:
    'La reprise rétablit les mouvements de valeur sur toute la plateforme. Deux fondateurs actuels différents doivent être d’accord (identity l’impose), et la cause du gel doit être résolue.',
  freezeReasonLabel: 'Motif (enregistré avec le gel, de 12 à 500 caractères)',
  thawReasonLabel: 'Inutile : la reprise efface le motif enregistré',
};
export const LEDGER_COPY: Readonly<Record<LedgerLocale, LedgerCopy>> = { en, es, fr };
export function ledgerCopy(locale: LedgerLocale = 'en'): LedgerCopy {
  return LEDGER_COPY[locale];
}
