import { defineCopy } from '../../shared/i18n';

const en = {
  unavailable:
    'Blueprint questions are not published, so a Blueprint cannot be created from here. The form below is switched off for that reason.',
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
  mentorLimit: 'Accepting or declining a mentor match is not available on this page.',
} as const;
const es = {
  unavailable:
    'Las preguntas de Blueprint no están publicadas, así que no se puede crear un Blueprint desde aquí. Por eso el formulario de abajo está desactivado.',
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
  mentorLimit: 'Aceptar o rechazar una coincidencia de mentor no está disponible en esta página.',
} satisfies Record<keyof typeof en, string>;
const fr = {
  unavailable:
    'Les questions Blueprint ne sont pas publiées : impossible de créer un Blueprint d’ici. C’est pourquoi le formulaire ci-dessous est désactivé.',
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
  mentorLimit: 'Accepter ou refuser une mise en relation avec un mentor n’est pas disponible sur cette page.',
} satisfies Record<keyof typeof en, string>;
export const blueprintSessionCopy = defineCopy('more.blueprint.session', en, { es, fr });
