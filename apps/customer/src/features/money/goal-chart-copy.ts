import { defineCopy } from '../../shared/i18n';

const en = {
  goalLabel: 'Progress toward the savings target',
  goalProgress: '{current} of {target} {asset}',
  goalReached: 'Target reached',
  chartTitle: 'Inflow and outflow in this window',
  chartCaption: 'Inflow and outflow over the window above, shown as the two totals the bank returned.',
  chartTable: 'Inflow, outflow and net over the window',
  chartRow: 'Measure',
  chartAmount: 'Amount',
  inflow: 'Inflow',
  outflow: 'Outflow',
  net: 'Net',
} as const;
const es = {
  goalLabel: 'Avance hacia el objetivo de ahorro',
  goalProgress: '{current} de {target} {asset}',
  goalReached: 'Objetivo alcanzado',
  chartTitle: 'Entradas y salidas en esta ventana',
  chartCaption: 'Entradas y salidas de la ventana de arriba, mostradas como los dos totales que devolvió el banco.',
  chartTable: 'Entradas, salidas y neto de la ventana',
  chartRow: 'Medida',
  chartAmount: 'Cantidad',
  inflow: 'Entradas',
  outflow: 'Salidas',
  net: 'Neto',
} satisfies Record<keyof typeof en, string>;
const fr = {
  goalLabel: 'Progression vers l’objectif d’épargne',
  goalProgress: '{current} sur {target} {asset}',
  goalReached: 'Objectif atteint',
  chartTitle: 'Entrées et sorties sur cette fenêtre',
  chartCaption: 'Entrées et sorties de la fenêtre ci-dessus, affichées comme les deux totaux renvoyés par la banque.',
  chartTable: 'Entrées, sorties et net sur la fenêtre',
  chartRow: 'Mesure',
  chartAmount: 'Montant',
  inflow: 'Entrées',
  outflow: 'Sorties',
  net: 'Net',
} satisfies Record<keyof typeof en, string>;
export const goalChartCopy = defineCopy('bank.goalChart', en, { es, fr });
