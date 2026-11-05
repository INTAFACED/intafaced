import { defineCopy } from '../../shared/i18n';

/** Words of the Approvals inbox (/agents/approvals, AG-approvals-01). */
const en = {
  title: 'Approvals',
  description: 'What your agents want to do, held until you decide',
  intro: 'Each row is a call one of your agents made that a rule holds for you. The tool has not run.',
  inboxTitle: 'Approvals',
  colAgent: 'Agent',
  colDecide: 'Decide',
  approve: 'Approve',
  edit: 'Edit',
  reject: 'Reject',
  decideParked:
    'Deciding a request is not built (AG-approvals-01), so Approve, Edit and Reject are off. Every request below keeps waiting, and none of its tools has run.',
  empty: 'No request is waiting for you.',
  more: 'Showing the newest {shown} waiting requests. Older ones are still waiting.',
} as const;

const es = {
  title: 'Aprobaciones',
  description: 'Lo que tus agentes quieren hacer, retenido hasta que decidas',
  intro: 'Cada fila es una llamada de uno de tus agentes que una regla retiene para ti. La herramienta no se ha ejecutado.',
  inboxTitle: 'Aprobaciones',
  colAgent: 'Agente',
  colDecide: 'Decidir',
  approve: 'Aprobar',
  edit: 'Editar',
  reject: 'Rechazar',
  decideParked:
    'Decidir una solicitud no está construido (AG-approvals-01), así que Aprobar, Editar y Rechazar están desactivados. Cada solicitud sigue esperando y ninguna de sus herramientas se ha ejecutado.',
  empty: 'No hay ninguna solicitud esperándote.',
  more: 'Se muestran las {shown} solicitudes en espera más recientes. Las anteriores siguen esperando.',
} satisfies Record<keyof typeof en, string>;

const fr = {
  title: 'Approbations',
  description: 'Ce que vos agents veulent faire, retenu jusqu’à votre décision',
  intro: 'Chaque ligne est un appel de l’un de vos agents qu’une règle retient pour vous. L’outil n’a pas tourné.',
  inboxTitle: 'Approbations',
  colAgent: 'Agent',
  colDecide: 'Décider',
  approve: 'Approuver',
  edit: 'Modifier',
  reject: 'Rejeter',
  decideParked:
    'Décider d’une demande n’est pas construit (AG-approvals-01) : Approuver, Modifier et Rejeter sont donc désactivés. Chaque demande reste en attente et aucun de ses outils n’a tourné.',
  empty: 'Aucune demande ne vous attend.',
  more: 'Les {shown} demandes en attente les plus récentes sont affichées. Les plus anciennes attendent toujours.',
} satisfies Record<keyof typeof en, string>;

export const agentApprovalsCopy = defineCopy('more.agents.approvals', en, { es, fr });
