import { defineCopy } from '../../../shared/i18n';

// The review panel of one P2P order: one good or bad review per party once the order is completed.
const en = {
  title: 'Review this order',
  body: 'Each side of a completed order rates the other once, good or bad.',
  onlyCompleted: 'You can review this order once it is completed.',
  yours: 'Your review',
  theirs: 'Their review of you',
  theirsNone: 'The other side has not reviewed you on this order.',
  good: 'Good',
  bad: 'Bad',
  formLabel: 'Leave a review',
  ratingLabel: 'Rating',
  commentLabel: 'Comment (optional)',
  explanationLabel: 'What went wrong',
  onePerParty: 'You can leave one review for this order.',
  leave: 'Leave review',
  leaving: 'Leaving review…',
  hidden: 'Hidden by moderation: {reason}',
} as const;
const es = {
  title: 'Valora este pedido',
  body: 'Cada parte de un pedido completado valora a la otra una vez, bien o mal.',
  onlyCompleted: 'Podrás valorar este pedido cuando esté completado.',
  yours: 'Tu valoración',
  theirs: 'Su valoración sobre ti',
  theirsNone: 'La otra parte no te ha valorado en este pedido.',
  good: 'Bien',
  bad: 'Mal',
  formLabel: 'Deja una valoración',
  ratingLabel: 'Valoración',
  commentLabel: 'Comentario (opcional)',
  explanationLabel: 'Qué salió mal',
  onePerParty: 'Puedes dejar una valoración para este pedido.',
  leave: 'Dejar valoración',
  leaving: 'Dejando la valoración…',
  hidden: 'Oculta por moderación: {reason}',
} satisfies Record<keyof typeof en, string>;
const fr = {
  title: 'Évaluer cette commande',
  body: 'Chaque partie d’une commande terminée évalue l’autre une fois, bien ou mal.',
  onlyCompleted: 'Vous pourrez évaluer cette commande une fois terminée.',
  yours: 'Votre évaluation',
  theirs: 'Son évaluation de vous',
  theirsNone: 'L’autre partie ne vous a pas évalué sur cette commande.',
  good: 'Bien',
  bad: 'Mal',
  formLabel: 'Laisser une évaluation',
  ratingLabel: 'Évaluation',
  commentLabel: 'Commentaire (facultatif)',
  explanationLabel: 'Ce qui s’est mal passé',
  onePerParty: 'Vous pouvez laisser une évaluation pour cette commande.',
  leave: 'Laisser l’évaluation',
  leaving: 'Envoi de l’évaluation…',
  hidden: 'Masquée par la modération : {reason}',
} satisfies Record<keyof typeof en, string>;

export const orderReviewCopy = defineCopy('pay.p2p.orderReview', en, { es, fr });
