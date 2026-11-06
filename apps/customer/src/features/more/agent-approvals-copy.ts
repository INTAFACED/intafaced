import { defineCopy } from '../../shared/i18n';

/** Words of the Approvals inbox (/agents/approvals, AG-approvals-01). */
const en = {
  title: 'Approvals',
  description: 'What your agents want to do, held until you decide',
  intro:
    'Each row is a call one of your agents made that a rule held for you. A tool runs only once you approve it, and only once; an edit is a new request that needs its own approval.',
  inboxTitle: 'Approvals',
  colAgent: 'Agent',
  colDecide: 'Decide',
  approve: 'Approve',
  edit: 'Edit',
  reject: 'Reject',
  approveAgain: 'Approve again',
  approved: 'Approved: the tool ran once.',
  approvedAgain: 'Already approved: the first result is shown.',
  rejected: 'Rejected. The agent’s step ended there and the tool did not run.',
  edited: 'Saved as a new request. It waits for your approval; the old one can no longer be approved.',
  firstResult: 'First result',
  editTitle: 'Edit the request',
  editIntro: 'Saving makes a new request with what you write here. Nothing runs until you approve it.',
  field_ticketId: 'Support request',
  field_body: 'Comment',
  saveEdit: 'Save as a new request',
  cancel: 'Cancel',
  empty: 'No request yet.',
  pushAction: 'Sending a held call to your phone',
  more: 'Showing {shown} requests: waiting ones first, then the newest. Older decided ones are left out.',
} as const;

const es = {
  title: 'Aprobaciones',
  description: 'Lo que tus agentes quieren hacer, retenido hasta que decidas',
  intro:
    'Cada fila es una llamada de uno de tus agentes que una regla retuvo para ti. Una herramienta solo se ejecuta cuando la apruebas, y una sola vez; una edición es una solicitud nueva que necesita su propia aprobación.',
  inboxTitle: 'Aprobaciones',
  colAgent: 'Agente',
  colDecide: 'Decidir',
  approve: 'Aprobar',
  edit: 'Editar',
  reject: 'Rechazar',
  approveAgain: 'Aprobar de nuevo',
  approved: 'Aprobada: la herramienta se ejecutó una vez.',
  approvedAgain: 'Ya aprobada: se muestra el primer resultado.',
  rejected: 'Rechazada. El paso del agente terminó ahí y la herramienta no se ejecutó.',
  edited: 'Guardada como solicitud nueva. Espera tu aprobación; la anterior ya no se puede aprobar.',
  firstResult: 'Primer resultado',
  editTitle: 'Editar la solicitud',
  editIntro: 'Al guardar se crea una solicitud nueva con lo que escribas aquí. Nada se ejecuta hasta que la apruebes.',
  field_ticketId: 'Solicitud de soporte',
  field_body: 'Comentario',
  saveEdit: 'Guardar como solicitud nueva',
  cancel: 'Cancelar',
  empty: 'Aún no hay solicitudes.',
  pushAction: 'Enviar una llamada retenida a tu teléfono',
  more: 'Se muestran {shown} solicitudes: primero las que esperan, luego las más recientes. Se omiten las decididas más antiguas.',
} satisfies Record<keyof typeof en, string>;

const fr = {
  title: 'Approbations',
  description: 'Ce que vos agents veulent faire, retenu jusqu’à votre décision',
  intro:
    'Chaque ligne est un appel de l’un de vos agents qu’une règle a retenu pour vous. Un outil ne tourne qu’une fois approuvé, et une seule fois ; une modification est une nouvelle demande qui doit être approuvée à son tour.',
  inboxTitle: 'Approbations',
  colAgent: 'Agent',
  colDecide: 'Décider',
  approve: 'Approuver',
  edit: 'Modifier',
  reject: 'Rejeter',
  approveAgain: 'Approuver de nouveau',
  approved: 'Approuvée : l’outil a tourné une fois.',
  approvedAgain: 'Déjà approuvée : le premier résultat est affiché.',
  rejected: 'Rejetée. L’étape de l’agent s’est arrêtée là et l’outil n’a pas tourné.',
  edited: 'Enregistrée comme nouvelle demande. Elle attend votre approbation ; l’ancienne ne peut plus être approuvée.',
  firstResult: 'Premier résultat',
  editTitle: 'Modifier la demande',
  editIntro: 'Enregistrer crée une nouvelle demande avec ce que vous écrivez ici. Rien ne tourne avant votre approbation.',
  field_ticketId: 'Demande d’assistance',
  field_body: 'Commentaire',
  saveEdit: 'Enregistrer comme nouvelle demande',
  cancel: 'Annuler',
  empty: 'Aucune demande pour l’instant.',
  pushAction: 'Envoyer un appel retenu sur votre téléphone',
  more: '{shown} demandes affichées : d’abord celles en attente, puis les plus récentes. Les plus anciennes déjà décidées sont omises.',
} satisfies Record<keyof typeof en, string>;

export const agentApprovalsCopy = defineCopy('more.agents.approvals', en, { es, fr });
/** Whether a key has words, so a field the copy does not name shows by its own name. */
type FieldKey = Extract<keyof typeof en, `field_${string}`>;
export const hasApprovalsWords = (key: string): key is FieldKey => key.startsWith('field_') && Object.hasOwn(en, key);
