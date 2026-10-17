import { defineCopy } from '../../shared/i18n';

const en = {
  unavailable:
    'The Blueprint service does not publish its question list, so a Blueprint cannot be created from here. The form below is switched off for that reason.',
  start: 'Create your Blueprint',
  optIn: 'Opt in to mentor availability',
  private: 'Only me',
  crew: 'My crew',
  public: 'Any signed-in account',
  portrait: 'Portrait',
  landscape: 'Landscape',
  shortlisted: 'Shortlisted',
  accepted: 'Accepted',
  declined: 'Declined',
  ended: 'Ended',
  mentorLimit: 'The Blueprint service has no way to accept or decline a mentor match, so this page cannot do it.',
} as const;
const es = {
  unavailable:
    'El servicio de Blueprint no publica su lista de preguntas, así que no se puede crear un Blueprint desde aquí. Por eso el formulario de abajo está desactivado.',
  start: 'Crear tu Blueprint',
  optIn: 'Aceptar la disponibilidad como mentor',
  private: 'Solo yo',
  crew: 'Mi equipo',
  public: 'Cualquier cuenta con sesión iniciada',
  portrait: 'Vertical',
  landscape: 'Horizontal',
  shortlisted: 'Preseleccionado',
  accepted: 'Aceptado',
  declined: 'Rechazado',
  ended: 'Finalizado',
  mentorLimit: 'El servicio de Blueprint no permite aceptar ni rechazar una coincidencia de mentor, así que esta página no puede hacerlo.',
} satisfies Record<keyof typeof en, string>;
const fr = {
  unavailable:
    'Le service Blueprint ne publie pas sa liste de questions : impossible de créer un Blueprint d’ici. C’est pourquoi le formulaire ci-dessous est désactivé.',
  start: 'Créer ton Blueprint',
  optIn: 'Accepter d’être disponible comme mentor',
  private: 'Moi uniquement',
  crew: 'Mon équipe',
  public: 'Tout compte connecté',
  portrait: 'Portrait',
  landscape: 'Paysage',
  shortlisted: 'Présélectionné',
  accepted: 'Accepté',
  declined: 'Refusé',
  ended: 'Terminé',
  mentorLimit:
    'Le service Blueprint ne permet pas d’accepter ou de refuser une mise en relation avec un mentor, donc cette page ne peut pas le faire.',
} satisfies Record<keyof typeof en, string>;
export const blueprintSessionCopy = defineCopy('more.blueprint.session', en, { es, fr });
