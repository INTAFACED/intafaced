import { defineCopy } from '../../shared/i18n';

const en = {
  title: 'Risk disclosure',
  loading: 'Reading the risk disclosure',
  readFailed: 'The risk disclosure could not be read.',
  notPublished: 'No risk disclosure is published, so none can be accepted.',
  version: 'Version {version}',
  standing: 'Every result in Quant is simulated. It is not live performance and not a forecast.',
  accept: 'Accept for a strategy version',
  acceptReason:
    'An acceptance is recorded for one saved strategy version and one disclosure version. It is taken at the step that puts a saved version to use, not from this panel.',
} as const;
const es = {
  title: 'Aviso de riesgo',
  loading: 'Leyendo el aviso de riesgo',
  readFailed: 'No se pudo leer el aviso de riesgo.',
  notPublished: 'No hay un aviso de riesgo publicado, así que no se puede aceptar ninguno.',
  version: 'Versión {version}',
  standing: 'Todos los resultados de Quant son simulados. No son rendimiento real ni una previsión.',
  accept: 'Aceptar para una versión de estrategia',
  acceptReason:
    'La aceptación se registra para una versión de estrategia guardada y una versión del aviso. Se da en el paso que pone en uso una versión guardada, no desde este panel.',
} satisfies Record<keyof typeof en, string>;
const fr = {
  title: 'Avertissement sur les risques',
  loading: 'Lecture de l’avertissement sur les risques',
  readFailed: 'L’avertissement sur les risques n’a pas pu être lu.',
  notPublished: 'Aucun avertissement sur les risques n’est publié ; aucun ne peut donc être accepté.',
  version: 'Version {version}',
  standing: 'Tous les résultats de Quant sont simulés. Ce n’est ni une performance réelle ni une prévision.',
  accept: 'Accepter pour une version de stratégie',
  acceptReason:
    'L’acceptation est enregistrée pour une version de stratégie enregistrée et une version de l’avertissement. Elle se donne à l’étape qui met en service une version enregistrée, pas depuis ce panneau.',
} satisfies Record<keyof typeof en, string>;
export const quantDisclosureCopy = defineCopy('more.quant.disclosure', en, { es, fr });
