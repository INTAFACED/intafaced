import { defineCopy } from '../../shared/i18n';

/** Words of where a Navigator research answer's facts came from (RC-agents-09, J-agents-10 #4). */
const en = {
  title: 'Where this came from',
  intro: 'The platform read these sources itself before the agent answered. A claim with no source is marked unsupported.',
  source: 'Source',
  sourceLine: '[{id}] {market} last traded price: {value}',
  observedAt: 'Observed at',
  environment: 'Environment',
  env_live: 'Live market data',
  env_testnet: 'Test network data, not a live market',
  env_TEST: 'TEST data from the test stack, not a live market',
  assumptions: 'Assumptions',
  noAssumptions: 'None',
  assumption_last_trade_at_observation: 'Each price is the venue’s last trade at its observation time; it may have moved since.',
  assumption_named_markets_only: 'Only the markets your question names were read.',
  uncertainty: 'Uncertainty',
  uncertaintyLine: '{level}, on a scale of {scale}: {unsupported} of {claims} sentences cite no source.',
  unsupported: 'Unsupported claims',
  noUnsupported: 'None: every sentence cites a source.',
  unsupportedTag: 'Unsupported',
  notAdvice: 'This is the agent’s reading of the sources above, not an exchange record and not advice.',
} as const;

const es: Record<keyof typeof en, string> = {
  title: 'De dónde viene esto',
  intro:
    'La plataforma leyó estas fuentes por sí misma antes de que el agente respondiera. Una afirmación sin fuente se marca como no respaldada.',
  source: 'Fuente',
  sourceLine: '[{id}] {market} último precio negociado: {value}',
  observedAt: 'Hora de observación',
  environment: 'Entorno',
  env_live: 'Datos de mercado en vivo',
  env_testnet: 'Datos de una red de prueba, no de un mercado en vivo',
  env_TEST: 'Datos TEST del entorno de prueba, no de un mercado en vivo',
  assumptions: 'Supuestos',
  noAssumptions: 'Ninguno',
  assumption_last_trade_at_observation:
    'Cada precio es la última operación del mercado en el momento de su observación; puede haber cambiado desde entonces.',
  assumption_named_markets_only: 'Solo se leyeron los mercados que nombra tu pregunta.',
  uncertainty: 'Incertidumbre',
  uncertaintyLine: '{level}, en una escala de {scale}: {unsupported} de {claims} frases no citan ninguna fuente.',
  unsupported: 'Afirmaciones no respaldadas',
  noUnsupported: 'Ninguna: cada frase cita una fuente.',
  unsupportedTag: 'No respaldada',
  notAdvice: 'Esta es la lectura que hace el agente de las fuentes anteriores, no un registro del exchange ni un consejo.',
};

const fr: Record<keyof typeof en, string> = {
  title: 'D’où cela vient',
  intro: 'La plateforme a lu ces sources elle-même avant que l’agent ne réponde. Une affirmation sans source est marquée non étayée.',
  source: 'Source',
  sourceLine: '[{id}] {market} dernier prix échangé : {value}',
  observedAt: 'Heure d’observation',
  environment: 'Environnement',
  env_live: 'Données de marché en direct',
  env_testnet: 'Données d’un réseau de test, pas d’un marché en direct',
  env_TEST: 'Données TEST de l’environnement de test, pas d’un marché en direct',
  assumptions: 'Hypothèses',
  noAssumptions: 'Aucune',
  assumption_last_trade_at_observation:
    'Chaque prix est la dernière transaction du marché à son heure d’observation ; il a pu changer depuis.',
  assumption_named_markets_only: 'Seuls les marchés nommés dans votre question ont été lus.',
  uncertainty: 'Incertitude',
  uncertaintyLine: '{level}, sur une échelle de {scale} : {unsupported} phrases sur {claims} ne citent aucune source.',
  unsupported: 'Affirmations non étayées',
  noUnsupported: 'Aucune : chaque phrase cite une source.',
  unsupportedTag: 'Non étayée',
  notAdvice: 'Ceci est la lecture des sources ci-dessus par l’agent, ni un relevé de la plateforme d’échange ni un conseil.',
};

export const researchProvenanceCopy = defineCopy('more.agents.research-provenance', en, { es, fr });
