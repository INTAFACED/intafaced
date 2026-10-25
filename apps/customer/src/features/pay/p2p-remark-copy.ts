import { defineCopy } from '../../shared/i18n';
const en = {
  noteTitle: 'What to write in the payment note',
  noteForbidden: 'Never write',
  title: 'Report a sensitive remark in a payment note',
  why: 'If the payment note on this order says something that should not be there, such as crypto or the name of this service, quote it here. A case opens for staff, and the other person is told that a remark on this order was reported.',
  remark: 'The remark, as written',
  remarkMissing: 'Quote the remark from the payment note.',
  tooLong: 'Quote at most {max} characters.',
  report: 'Report the remark',
  reported: 'You reported this remark. A case is open for staff to decide.',
  exists: 'You already reported a remark on this order. Add anything more in a dispute.',
  invalid: 'Quote the remark in 1 to {max} characters.',
} as const;
const es = {
  noteTitle: 'Qué escribir en el concepto del pago',
  noteForbidden: 'Nunca escribas',
  title: 'Informar de un comentario delicado en el concepto del pago',
  why: 'Si el concepto del pago de este pedido dice algo que no debería, como cripto o el nombre de este servicio, cítalo aquí. Se abre un caso para el personal y se avisa a la otra persona de que se informó de un comentario en este pedido.',
  remark: 'El comentario, tal como está escrito',
  remarkMissing: 'Cita el comentario del concepto del pago.',
  tooLong: 'Cita como máximo {max} caracteres.',
  report: 'Informar del comentario',
  reported: 'Informaste de este comentario. Hay un caso abierto para que decida el personal.',
  exists: 'Ya informaste de un comentario en este pedido. Añade lo que falte en una disputa.',
  invalid: 'Cita el comentario en 1 a {max} caracteres.',
} as const;
const fr = {
  noteTitle: 'Quoi écrire dans le libellé du paiement',
  noteForbidden: 'N’écrivez jamais',
  title: 'Signaler une remarque sensible dans le libellé du paiement',
  why: 'Si le libellé du paiement de cette commande contient quelque chose qui ne devrait pas y être, comme crypto ou le nom de ce service, citez-le ici. Un dossier s’ouvre pour l’équipe, et l’autre personne est informée qu’une remarque sur cette commande a été signalée.',
  remark: 'La remarque, telle qu’écrite',
  remarkMissing: 'Citez la remarque du libellé du paiement.',
  tooLong: 'Citez au plus {max} caractères.',
  report: 'Signaler la remarque',
  reported: 'Vous avez signalé cette remarque. Un dossier est ouvert pour que l’équipe décide.',
  exists: 'Vous avez déjà signalé une remarque sur cette commande. Ajoutez le reste dans un litige.',
  invalid: 'Citez la remarque en 1 à {max} caractères.',
} as const;
export const remarkCopy = defineCopy('pay.p2p.remark', en, { es, fr });
