import { defineCopy } from '../../shared/i18n';
const en = {
  tab: 'Burn',
  runsTitle: 'Buyback runs',
  runsBody:
    'Each settled buyback run as the token service stored it: what was bought, what was burned and what was sent to rewards. Each row adds up, or the page refuses to show it.',
  executed: 'Settled',
  window: 'Revenue window',
  bought: 'Bought',
  burned: 'Burned',
  toRewards: 'Sent to rewards',
  windowRange: '{from} to {to}',
  noRuns: 'No buyback run has settled.',
  jobUnset: 'Job not set: the buyback job is missing a setting it needs, so it does not run.',
  jobSet: 'Job set: the buyback job has every setting it needs. A run shows here once it settles.',
  estimateUnset: 'No estimate: the buyback rate is not set.',
  estimateInvalid: 'No estimate: the stored buyback rate cannot be read.',
  estimateRate:
    'Buyback rate: {buyback} basis points of house fees per window. {burn} basis points of each buy is burned and the rest is sent to rewards. No amount is estimated before a run.',
} as const;
const es = {
  tab: 'Quema',
  runsTitle: 'Recompras ejecutadas',
  runsBody:
    'Cada recompra liquidada tal como la guardó el servicio del token: lo comprado, lo quemado y lo enviado a recompensas. Cada fila cuadra, o la página se niega a mostrarla.',
  executed: 'Liquidada',
  window: 'Ventana de ingresos',
  bought: 'Comprado',
  burned: 'Quemado',
  toRewards: 'Enviado a recompensas',
  windowRange: '{from} a {to}',
  noRuns: 'Ninguna recompra se ha liquidado.',
  jobUnset: 'Tarea sin configurar: a la tarea de recompra le falta un ajuste que necesita, así que no se ejecuta.',
  jobSet: 'Tarea configurada: la tarea de recompra tiene todos los ajustes que necesita. Una recompra aparece aquí cuando se liquida.',
  estimateUnset: 'Sin estimación: la tasa de recompra no está fijada.',
  estimateInvalid: 'Sin estimación: la tasa de recompra guardada no se puede leer.',
  estimateRate:
    'Tasa de recompra: {buyback} puntos básicos de las comisiones de la casa por ventana. {burn} puntos básicos de cada compra se queman y el resto va a recompensas. No se estima ningún importe antes de una recompra.',
} satisfies Record<keyof typeof en, string>;
const fr = {
  tab: 'Destruction',
  runsTitle: 'Rachats exécutés',
  runsBody:
    'Chaque rachat réglé tel que le service du jeton l’a enregistré : ce qui a été acheté, détruit et versé aux récompenses. Chaque ligne s’additionne, sinon la page refuse de l’afficher.',
  executed: 'Réglé',
  window: 'Fenêtre de revenus',
  bought: 'Acheté',
  burned: 'Détruit',
  toRewards: 'Versé aux récompenses',
  windowRange: '{from} au {to}',
  noRuns: 'Aucun rachat n’a été réglé.',
  jobUnset: 'Tâche non configurée : il manque à la tâche de rachat un réglage nécessaire, elle ne s’exécute donc pas.',
  jobSet: 'Tâche configurée : la tâche de rachat a tous les réglages nécessaires. Un rachat apparaît ici une fois réglé.',
  estimateUnset: 'Pas d’estimation : le taux de rachat n’est pas fixé.',
  estimateInvalid: 'Pas d’estimation : le taux de rachat enregistré est illisible.',
  estimateRate:
    'Taux de rachat : {buyback} points de base des frais de la maison par fenêtre. {burn} points de base de chaque achat sont détruits et le reste est versé aux récompenses. Aucun montant n’est estimé avant un rachat.',
} satisfies Record<keyof typeof en, string>;
export const buybackRunsCopy = defineCopy('more.token.buyback.runs', en, { es, fr });
