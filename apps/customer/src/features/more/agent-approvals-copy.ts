import { defineCopy } from '../../shared/i18n';

/** Words of the Approvals inbox (/agents/approvals, AG-approvals-01). */
const en = {
  title: 'Approvals',
  description: 'What your agents want to do, held until you decide',
  intro: 'Each row is a call one of your agents made that a rule holds for you. The tool has not run.',
  inboxTitle: 'Approvals',
  colWhen: 'When',
  colAgent: 'Agent',
  colAction: 'Action',
  colInput: 'Input',
  colState: 'State',
  colDecide: 'Decide',
  approve: 'Approve',
  edit: 'Edit',
  reject: 'Reject',
  decideParked:
    'Deciding here is not built yet: Approve, Edit and Reject are off. Every request below keeps waiting, and none of its tools has run.',
  empty: 'No request is waiting for you.',
} as const;

const es = {
  title: 'Aprobaciones',
  description: 'Lo que tus agentes quieren hacer, retenido hasta que decidas',
  intro: 'Cada fila es una llamada de uno de tus agentes que una regla retiene para ti. La herramienta no se ha ejecutado.',
  inboxTitle: 'Aprobaciones',
  colWhen: 'Cuándo',
  colAgent: 'Agente',
  colAction: 'Acción',
  colInput: 'Entrada',
  colState: 'Estado',
  colDecide: 'Decidir',
  approve: 'Aprobar',
  edit: 'Editar',
  reject: 'Rechazar',
  decideParked:
    'Decidir aquí aún no está construido: Aprobar, Editar y Rechazar están desactivados. Cada solicitud sigue esperando y ninguna de sus herramientas se ha ejecutado.',
  empty: 'No hay ninguna solicitud esperándote.',
} satisfies Record<keyof typeof en, string>;

const fr = {
  title: 'Approbations',
  description: 'Ce que vos agents veulent faire, retenu jusqu’à votre décision',
  intro: 'Chaque ligne est un appel de l’un de vos agents qu’une règle retient pour vous. L’outil n’a pas tourné.',
  inboxTitle: 'Approbations',
  colWhen: 'Quand',
  colAgent: 'Agent',
  colAction: 'Action',
  colInput: 'Entrée',
  colState: 'État',
  colDecide: 'Décider',
  approve: 'Approuver',
  edit: 'Modifier',
  reject: 'Rejeter',
  decideParked:
    'Décider ici n’est pas encore construit : Approuver, Modifier et Rejeter sont désactivés. Chaque demande reste en attente et aucun de ses outils n’a tourné.',
  empty: 'Aucune demande ne vous attend.',
} satisfies Record<keyof typeof en, string>;

export const agentApprovalsCopy = defineCopy('more.agents.approvals', en, { es, fr });
