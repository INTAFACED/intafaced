import { defineCopy } from '../../shared/i18n';
const en = {
  title: 'Distribution',
  unset: 'Schedule not set: the issuer has not published when this launch’s tokens vest, so no date or amount is shown.',
  start: 'Vesting starts',
  cliff: 'Cliff',
  noCliff: 'No cliff',
  end: 'Fully vested',
  rule: 'Rule',
  linear: 'Linear from the start to the end; nothing vests before the cliff',
  vestedNow: 'Vested now',
  vestedShare: '{percent}% of any allocation',
  readAt: 'Read at',
  phase: 'Stage',
  before_start: 'Not started',
  before_cliff: 'Before the cliff',
  vesting: 'Vesting',
  vested: 'Fully vested',
  notSet: 'not set',
  awardedNone:
    'Your allocation: none awarded. Allocation is not connected to the ledger, so no amount is awarded, vested or claimable for any account.',
  signIn: 'Sign in to claim.',
  claimOnChain: 'Claim on chain',
  claimToAccount: 'Claim to my account',
  chainClaimUnavailable:
    'An on-chain claim is not available: the project token is not issued on a chain and no vesting contract holds it for this launch. Nothing was sent.',
  claimUnavailable:
    'Claiming is not available: no allocation has been awarded for this launch and no claim is connected to the ledger. Nothing was moved.',
  uncertain: 'We could not confirm the answer. Read this launch again before trying once more.',
} as const;
const es = {
  title: 'Distribución',
  unset:
    'Calendario sin fijar: el emisor no ha publicado cuándo se consolidan los tokens de este lanzamiento, así que no se muestra ninguna fecha ni cantidad.',
  start: 'Empieza la consolidación',
  cliff: 'Periodo de bloqueo',
  noCliff: 'Sin periodo de bloqueo',
  end: 'Totalmente consolidado',
  rule: 'Regla',
  linear: 'Lineal desde el inicio hasta el final; nada se consolida antes del periodo de bloqueo',
  vestedNow: 'Consolidado ahora',
  vestedShare: '{percent}% de cualquier asignación',
  readAt: 'Leído a las',
  phase: 'Etapa',
  before_start: 'Sin empezar',
  before_cliff: 'Antes del periodo de bloqueo',
  vesting: 'Consolidándose',
  vested: 'Totalmente consolidado',
  notSet: 'sin fijar',
  awardedNone:
    'Tu asignación: ninguna concedida. La asignación no está conectada al libro contable, así que no hay cantidad concedida, consolidada ni reclamable para ninguna cuenta.',
  signIn: 'Inicia sesión para reclamar.',
  claimOnChain: 'Reclamar en la cadena',
  claimToAccount: 'Reclamar a mi cuenta',
  chainClaimUnavailable:
    'No se puede reclamar en la cadena: el token del proyecto no está emitido en ninguna cadena y ningún contrato de consolidación lo guarda para este lanzamiento. No se envió nada.',
  claimUnavailable:
    'No se puede reclamar: no se ha concedido ninguna asignación en este lanzamiento y no hay reclamación conectada al libro contable. No se movió nada.',
  uncertain: 'No pudimos confirmar la respuesta. Vuelve a leer este lanzamiento antes de intentarlo otra vez.',
} satisfies Record<keyof typeof en, string>;
const fr = {
  title: 'Distribution',
  unset:
    'Calendrier non fixé : l’émetteur n’a pas publié quand les jetons de ce lancement sont acquis, donc aucune date ni aucun montant n’est affiché.',
  start: 'Début de l’acquisition',
  cliff: 'Période de blocage',
  noCliff: 'Pas de période de blocage',
  end: 'Entièrement acquis',
  rule: 'Règle',
  linear: 'Linéaire du début à la fin ; rien n’est acquis avant la période de blocage',
  vestedNow: 'Acquis maintenant',
  vestedShare: '{percent} % de toute allocation',
  readAt: 'Lu à',
  phase: 'Étape',
  before_start: 'Pas commencé',
  before_cliff: 'Avant la période de blocage',
  vesting: 'En cours d’acquisition',
  vested: 'Entièrement acquis',
  notSet: 'non fixé',
  awardedNone:
    'Votre allocation : aucune attribuée. L’allocation n’est pas reliée au registre, donc aucun montant n’est attribué, acquis ni réclamable pour aucun compte.',
  signIn: 'Connectez-vous pour réclamer.',
  claimOnChain: 'Réclamer sur la chaîne',
  claimToAccount: 'Réclamer sur mon compte',
  chainClaimUnavailable:
    'Une réclamation sur la chaîne n’est pas disponible : le jeton du projet n’est émis sur aucune chaîne et aucun contrat d’acquisition ne le détient pour ce lancement. Rien n’a été envoyé.',
  claimUnavailable:
    'La réclamation n’est pas disponible : aucune allocation n’a été attribuée pour ce lancement et aucune réclamation n’est reliée au registre. Rien n’a été déplacé.',
  uncertain: 'Nous n’avons pas pu confirmer la réponse. Relisez ce lancement avant de réessayer.',
} satisfies Record<keyof typeof en, string>;
export const launchDistributionCopy = defineCopy('more.launch.distribution', en, { es, fr });
