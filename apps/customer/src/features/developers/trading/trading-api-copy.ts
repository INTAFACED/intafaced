import { defineCopy } from '../../../shared/i18n';

// The bot policy and order types pages' words (J-cex-spot-15 #3, #4, and the algo order states of #6). The policy text is the owner's, and the type
// list, its fields and its codes come from svc-trade's GET /api/v1/order-types.
export const tradingApiCopy = defineCopy(
  'developers-trading-api',
  {
    botLead: 'What automated trading through the API is permitted, and on what terms. The owner publishes it.',
    botStaticNote:
      'This file is static and states no policy. The bot policy is read live from GET /api/trade/developer-portal/bot-policy, the source /developers/bot-policy shows: its text, or the refusal trade.developer_bot_policy_unset while the owner has published none.',
    typesStaticNote: 'The same list is served live at GET /api/v1/order-types.',
    botUnpublished: 'Bot policy: not yet published',
    botUnpublishedBody: 'Nothing on this site grants permission to run a bot. A key does only what its permissions allow.',
    typesLead:
      'The spot order types the API accepts: the same list the trading ticket shows, in its order. Each row says how to send it to POST /api/v1/orders.',
    typesLeadVenue:
      'The spot order types the venue offers on {symbol}: the same list the trading ticket shows, in its order. Each row says how to send it to POST /api/v1/venue/prepare.',
    typesTitle: 'Accepted order types',
    colType: 'Order type',
    colBodyType: 'Body type',
    colFields: 'Fields that make it this type',
    colTif: 'Time in force',
    colExample: 'Example body (TEST figures)',
    colNote: 'Note',
    note_market: 'Never rests. GTC here is the engine’s immediate rule; FOK fills whole or not at all.',
    note_venue_market: 'Sent as IOC at the worst price accepted (the slippage limit).',
    note_bracket:
      'A market entry, or a limit entry with IOC or FOK, resolves inside the request. A GTC limit entry rests only while the login that placed it lasts, is cancelled before that login runs out, and has no stop loss while partly filled.',
    exampleTitle: 'Example bodies',
    noFields: 'none',
    refusedTitle: 'Listed but refused',
    refusedLead: 'The ticket lists these, disabled. The API refuses them with the code shown.',
    refusedLeadVenue:
      'The venue ticket lists these, disabled, as not offered by this venue. The venue door refuses them with the code shown.',
    colCode: 'Refusal code',
    loading: 'Loading…',
    loadFailed: 'This could not be read just now.',
    tryAgain: 'Try again',
    back: 'Developer home',
    algoTitle: 'Algo orders',
    algoLead:
      'An algo order is placed with POST /api/v1/algo/orders, read with GET /api/v1/algo/orders/:id, amended with PATCH and cancelled with DELETE on the same path. Every answer carries the order’s state, one of these for every kind:',
    algoAmend:
      'An amend lowers a TWAP’s totalQty, or moves its triggerPrice while it still waits; nothing else changes. A larger quantity is refused trade.amend_qty_up, and one no more than already scheduled trade.algo_amend_below_placed.',
    colState: 'State',
    colMeaning: 'Means',
    state_live: 'Running, paused or waiting for its trigger price.',
    state_effective: 'Finished, filled whole.',
    state_partially_effective: 'Finished, part filled.',
    state_canceled: 'Cancelled: no new slices are placed.',
    state_order_failed: 'Halted, or finished with nothing filled.',
  },
  {
    es: {
      botLead: 'Qué trading automatizado a través de la API está permitido y en qué condiciones. Lo publica el propietario.',
      botUnpublished: 'Política de bots: sin publicar',
      botUnpublishedBody: 'Nada en este sitio concede permiso para usar un bot. Una clave solo hace lo que permiten sus permisos.',
      typesLead:
        'Los tipos de orden spot que acepta la API: la misma lista que muestra el ticket de trading, en su orden. Cada fila dice cómo enviarlo a POST /api/v1/orders.',
      typesLeadVenue:
        'Los tipos de orden spot que ofrece la plaza en {symbol}: la misma lista que muestra el ticket de trading, en su orden. Cada fila dice cómo enviarlo a POST /api/v1/venue/prepare.',
      typesTitle: 'Tipos de orden aceptados',
      colType: 'Tipo de orden',
      colBodyType: 'Tipo en el cuerpo',
      colFields: 'Campos que lo hacen de este tipo',
      colTif: 'Vigencia',
      colExample: 'Cuerpo de ejemplo (cifras TEST)',
      colNote: 'Nota',
      note_market: 'Nunca queda en el libro. GTC aquí es la regla inmediata del motor; FOK se ejecuta entera o nada.',
      note_venue_market: 'Se envía como IOC al peor precio aceptado (el límite de deslizamiento).',
      note_bracket:
        'Una entrada a mercado, o una entrada límite con IOC o FOK, se resuelve dentro de la solicitud. Una entrada límite GTC queda en el libro solo mientras dure la sesión que la colocó, se cancela antes de que esa sesión caduque y no tiene stop loss mientras está ejecutada en parte.',
      exampleTitle: 'Cuerpos de ejemplo',
      noFields: 'ninguno',
      refusedTitle: 'Listados pero rechazados',
      refusedLead: 'El ticket los lista desactivados. La API los rechaza con el código indicado.',
      refusedLeadVenue:
        'El ticket de la plaza los lista desactivados por no ofrecerlos esta plaza. La puerta de la plaza los rechaza con el código indicado.',
      colCode: 'Código de rechazo',
      loading: 'Cargando…',
      loadFailed: 'No se pudo leer ahora mismo.',
      tryAgain: 'Reintentar',
      back: 'Inicio para desarrolladores',
      algoTitle: 'Órdenes algorítmicas',
      algoLead:
        'Una orden algorítmica se coloca con POST /api/v1/algo/orders, se lee con GET /api/v1/algo/orders/:id, se modifica con PATCH y se cancela con DELETE en la misma ruta. Cada respuesta lleva el estado de la orden, uno de estos para todos los tipos:',
      algoAmend:
        'Una modificación reduce la totalQty de un TWAP, o mueve su triggerPrice mientras aún espera; nada más cambia. Una cantidad mayor se rechaza con trade.amend_qty_up, y una no mayor que lo ya programado con trade.algo_amend_below_placed.',
      colState: 'Estado',
      colMeaning: 'Significa',
      state_live: 'En curso, en pausa o esperando su precio de activación.',
      state_effective: 'Terminada, ejecutada entera.',
      state_partially_effective: 'Terminada, ejecutada en parte.',
      state_canceled: 'Cancelada: no se colocan más tramos.',
      state_order_failed: 'Detenida, o terminada sin nada ejecutado.',
    },
    fr: {
      botLead: 'Quel trading automatisé via l’API est autorisé, et à quelles conditions. Le propriétaire le publie.',
      botUnpublished: 'Politique des bots : non publiée',
      botUnpublishedBody: 'Rien sur ce site n’autorise à faire tourner un bot. Une clé ne fait que ce que ses autorisations permettent.',
      typesLead:
        'Les types d’ordre spot que l’API accepte : la même liste que le ticket de trading, dans son ordre. Chaque ligne dit comment l’envoyer à POST /api/v1/orders.',
      typesLeadVenue:
        'Les types d’ordre spot que la place propose sur {symbol} : la même liste que le ticket de trading, dans son ordre. Chaque ligne dit comment l’envoyer à POST /api/v1/venue/prepare.',
      typesTitle: 'Types d’ordre acceptés',
      colType: 'Type d’ordre',
      colBodyType: 'Type dans le corps',
      colFields: 'Champs qui en font ce type',
      colTif: 'Durée de validité',
      colExample: 'Corps d’exemple (chiffres TEST)',
      colNote: 'Remarque',
      note_market: 'Ne reste jamais au carnet. GTC désigne ici la règle immédiate du moteur ; FOK s’exécute en entier ou pas du tout.',
      note_venue_market: 'Envoyé en IOC au pire prix accepté (la limite de glissement).',
      note_bracket:
        'Une entrée au marché, ou une entrée limite IOC ou FOK, se résout dans la requête. Une entrée limite GTC ne reste au carnet que tant que dure la session qui l’a placée, est annulée avant que cette session n’expire, et n’a pas de stop loss tant qu’elle est partiellement exécutée.',
      exampleTitle: 'Corps d’exemple',
      noFields: 'aucun',
      refusedTitle: 'Listés mais refusés',
      refusedLead: 'Le ticket les liste, désactivés. L’API les refuse avec le code indiqué.',
      refusedLeadVenue:
        'Le ticket de la place les liste, désactivés, comme non proposés par cette place. La porte de la place les refuse avec le code indiqué.',
      colCode: 'Code de refus',
      loading: 'Chargement…',
      loadFailed: 'Lecture impossible pour le moment.',
      tryAgain: 'Réessayer',
      back: 'Accueil développeurs',
      algoTitle: 'Ordres algorithmiques',
      algoLead:
        'Un ordre algorithmique se place avec POST /api/v1/algo/orders, se lit avec GET /api/v1/algo/orders/:id, se modifie avec PATCH et s’annule avec DELETE sur le même chemin. Chaque réponse porte l’état de l’ordre, l’un de ceux-ci pour tous les types :',
      algoAmend:
        'Une modification baisse la totalQty d’un TWAP, ou déplace son triggerPrice tant qu’il attend encore ; rien d’autre ne change. Une quantité plus grande est refusée trade.amend_qty_up, et une quantité pas plus grande que ce qui est déjà programmé trade.algo_amend_below_placed.',
      colState: 'État',
      colMeaning: 'Signifie',
      state_live: 'En cours, en pause ou en attente de son prix de déclenchement.',
      state_effective: 'Terminé, exécuté en entier.',
      state_partially_effective: 'Terminé, exécuté en partie.',
      state_canceled: 'Annulé : aucune nouvelle tranche n’est placée.',
      state_order_failed: 'Arrêté, ou terminé sans rien d’exécuté.',
    },
  },
);
