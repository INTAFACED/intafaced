import type { TradeErrorCause } from '@intafaced/contracts/trade-errors';
import { defineCopy } from '../../../shared/i18n';

// The order error catalogue's words. The codes, statuses and anchors are not copy: they come from
// `@intafaced/contracts/trade-errors`, which svc-trade's tests hold to what it sends.
export const tradeErrorsCopy = defineCopy(
  'developers-trade-errors',
  {
    lead: 'Every error the trading REST API (/api/v1) links here: a refused order body, and an order call during the platform posting freeze. Branch on the code; the detail code names the decision behind it.',
    tableTitle: 'Order errors',
    colCode: 'Code',
    colStatus: 'HTTP status',
    colDetail: 'Detail code',
    colCause: 'Cause',
    colFix: 'What to do',
    authLink: 'Authentication and permission errors',
    cause_fields:
      'The order body has invalid fields. The reply lists each one once under errors, with its field and what is wrong with it.',
    fix_fields: 'Correct every field the errors list names, then send the order again.',
    cause_tag: 'The tag is the only invalid field: it must be 1 to 16 characters.',
    fix_tag: 'Send a tag of 1 to 16 characters, or none.',
    cause_posting_frozen:
      'Posting is paused platform-wide, and the order was refused before it reached the matching engine: nothing was placed or held. Reads still answer.',
    fix_posting_frozen: 'Wait, then send the same order with the same client order id.',
    cause_settlement_pending:
      'Posting paused, or its answer was lost, after the matching engine took the order: the order exists and its settlement is not confirmed.',
    fix_settlement_pending: 'Read the order by its client order id before sending it again.',
  },
  {
    es: {
      lead: 'Cada error que la API REST de trading (/api/v1) enlaza aquí: un cuerpo de orden rechazado y una llamada de órdenes durante la pausa de asientos de toda la plataforma. Decide por el código; el código de detalle nombra la decisión.',
      tableTitle: 'Errores de órdenes',
      colCode: 'Código',
      colStatus: 'Estado HTTP',
      colDetail: 'Código de detalle',
      colCause: 'Causa',
      colFix: 'Qué hacer',
      authLink: 'Errores de autenticación y de permisos',
      cause_fields:
        'El cuerpo de la orden tiene campos no válidos. La respuesta enumera cada uno una vez en errors, con su campo y lo que está mal.',
      fix_fields: 'Corrige cada campo que nombra la lista errors y vuelve a enviar la orden.',
      cause_tag: 'La etiqueta es el único campo no válido: debe tener de 1 a 16 caracteres.',
      fix_tag: 'Envía una etiqueta de 1 a 16 caracteres, o ninguna.',
      cause_posting_frozen:
        'Los asientos están en pausa en toda la plataforma y la orden se rechazó antes de llegar al motor de casación: no se colocó ni se retuvo nada. Las lecturas siguen respondiendo.',
      fix_posting_frozen: 'Espera y envía la misma orden con el mismo id de orden del cliente.',
      cause_settlement_pending:
        'Los asientos se pausaron, o su respuesta se perdió, después de que el motor de casación tomara la orden: la orden existe y su liquidación no está confirmada.',
      fix_settlement_pending: 'Lee la orden por su id de orden del cliente antes de volver a enviarla.',
    },
    fr: {
      lead: 'Chaque erreur que l’API REST de trading (/api/v1) renvoie ici : un corps d’ordre refusé, et un appel d’ordre pendant la pause des écritures sur toute la plateforme. Décidez selon le code ; le code de détail nomme la décision.',
      tableTitle: 'Erreurs d’ordres',
      colCode: 'Code',
      colStatus: 'Statut HTTP',
      colDetail: 'Code de détail',
      colCause: 'Cause',
      colFix: 'Que faire',
      authLink: 'Erreurs d’authentification et d’autorisation',
      cause_fields:
        'Le corps de l’ordre contient des champs invalides. La réponse liste chacun une fois sous errors, avec son champ et ce qui ne va pas.',
      fix_fields: 'Corrigez chaque champ que nomme la liste errors, puis renvoyez l’ordre.',
      cause_tag: 'L’étiquette est le seul champ invalide : elle doit compter de 1 à 16 caractères.',
      fix_tag: 'Envoyez une étiquette de 1 à 16 caractères, ou aucune.',
      cause_posting_frozen:
        'Les écritures sont en pause sur toute la plateforme, et l’ordre a été refusé avant d’atteindre le moteur d’appariement : rien n’a été placé ni bloqué. Les lectures répondent toujours.',
      fix_posting_frozen: 'Attendez, puis renvoyez le même ordre avec le même identifiant d’ordre client.',
      cause_settlement_pending:
        'Les écritures ont été mises en pause, ou leur réponse s’est perdue, après que le moteur d’appariement a pris l’ordre : l’ordre existe et son règlement n’est pas confirmé.',
      fix_settlement_pending: 'Lisez l’ordre par son identifiant d’ordre client avant de le renvoyer.',
    },
  },
);

export const causeKey = (cause: TradeErrorCause) => `cause_${cause}` as const;
export const fixKey = (cause: TradeErrorCause) => `fix_${cause}` as const;
