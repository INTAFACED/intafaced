import { defineCopy } from '../../shared/i18n';

const en = {
  incidentTitle: 'Incident on {asset} on {network}',
  maintenanceTitle: 'Maintenance on {asset} on {network}',
  lead: 'The founders posted this about {asset} on {network}. Read it before you send.',
  stage: 'Stage: {stage}',
  stageInvestigating: 'Investigating',
  stageIdentified: 'Cause identified',
  stageUpdate: 'Update',
  stageMonitoring: 'Fix in place, monitoring',
  stageResolved: 'Resolved',
  stageUnset: 'not given',
  started: 'Started {date}',
  updated: 'Last update {date}',
  window: 'From {start} to {end}',
  windowOpenEnd: 'From {start}, end not given',
  timeUnset: 'Time not given',
  loadFailed: 'Notices for {asset} on {network} could not be loaded.',
  statusLink: 'Check the status page before you send',
} as const;

const es = {
  incidentTitle: 'Incidencia en {asset} en {network}',
  maintenanceTitle: 'Mantenimiento en {asset} en {network}',
  lead: 'Los fundadores publicaron esto sobre {asset} en {network}. Léelo antes de enviar.',
  stage: 'Fase: {stage}',
  stageInvestigating: 'Investigando',
  stageIdentified: 'Causa identificada',
  stageUpdate: 'Actualización',
  stageMonitoring: 'Solución aplicada, en vigilancia',
  stageResolved: 'Resuelta',
  stageUnset: 'no indicada',
  started: 'Empezó el {date}',
  updated: 'Última actualización: {date}',
  window: 'Del {start} al {end}',
  windowOpenEnd: 'Desde el {start}, sin fin indicado',
  timeUnset: 'Hora no indicada',
  loadFailed: 'No se pudieron cargar los avisos de {asset} en {network}.',
  statusLink: 'Consulta la página de estado antes de enviar',
} satisfies Record<keyof typeof en, string>;

const fr = {
  incidentTitle: 'Incident sur {asset} sur {network}',
  maintenanceTitle: 'Maintenance sur {asset} sur {network}',
  lead: 'Les fondateurs ont publié ceci sur {asset} sur {network}. Lisez-le avant d’envoyer.',
  stage: 'Étape : {stage}',
  stageInvestigating: 'Enquête en cours',
  stageIdentified: 'Cause identifiée',
  stageUpdate: 'Mise à jour',
  stageMonitoring: 'Correctif en place, sous surveillance',
  stageResolved: 'Résolu',
  stageUnset: 'non indiquée',
  started: 'Commencé le {date}',
  updated: 'Dernière mise à jour : {date}',
  window: 'Du {start} au {end}',
  windowOpenEnd: 'À partir du {start}, fin non indiquée',
  timeUnset: 'Heure non indiquée',
  loadFailed: 'Les avis pour {asset} sur {network} n’ont pas pu être chargés.',
  statusLink: 'Consultez la page d’état avant d’envoyer',
} satisfies Record<keyof typeof en, string>;

export const fundingNoticesCopy = defineCopy('customer.bank.funding.notices', en, { es, fr });
