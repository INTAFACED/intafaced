import { defineCopy } from '../../shared/i18n';

export const dividendsCopy = defineCopy(
  'account.dividends',
  {
    title: 'Dividend records',
    description: 'Payouts recorded to your account for tokens you hold.',
    whatTitle: 'What dividends are here',
    whatBody:
      'A dividend is a payout recorded to your account because you hold a token. Each record would show the date, the asset, the amount and what it was paid for.',
    needTitle: 'What is needed',
    needBody:
      'A list of your own payouts. That list is not switched on, so nothing is shown here and no amounts are guessed. This is not a statement that you were paid nothing.',
    needToken: 'Token holdings and earning activity are in their own rooms.',
    historyTitle: 'Your dividend history',
    historyLabel: 'Dividend history',
    colDate: 'Date',
    colAsset: 'Asset',
    colAmount: 'Amount',
    colSource: 'Paid for',
    emptyTitle: 'No dividends listed',
    emptyBody: 'Your history will appear in this table when the list is switched on.',
    token: 'Open Token →',
    earn: 'Open Earn →',
    activity: 'Open money activity →',
  },
  {
    es: {
      title: 'Registros de dividendos',
      description: 'Pagos registrados en tu cuenta por los tokens que tienes.',
      whatTitle: 'Qué son los dividendos aquí',
      whatBody:
        'Un dividendo es un pago registrado en tu cuenta porque tienes un token. Cada registro mostraría la fecha, el activo, el importe y el motivo del pago.',
      needTitle: 'Qué hace falta',
      needBody:
        'Una lista de tus propios pagos. Esa lista no está activada, así que aquí no se muestra nada y no se inventa ningún importe. Esto no significa que no hayas cobrado nada.',
      needToken: 'Tus tokens y tu actividad de rendimiento están en sus propias salas.',
      historyTitle: 'Tu historial de dividendos',
      historyLabel: 'Historial de dividendos',
      colDate: 'Fecha',
      colAsset: 'Activo',
      colAmount: 'Importe',
      colSource: 'Motivo del pago',
      emptyTitle: 'No hay dividendos en la lista',
      emptyBody: 'Tu historial aparecerá en esta tabla cuando se active la lista.',
      token: 'Abrir Token →',
      earn: 'Abrir Earn →',
      activity: 'Abrir la actividad del dinero →',
    },
    fr: {
      title: 'Registres de dividendes',
      description: 'Versements enregistrés sur votre compte pour les jetons que vous détenez.',
      whatTitle: 'Ce que sont les dividendes ici',
      whatBody:
        'Un dividende est un versement enregistré sur votre compte parce que vous détenez un jeton. Chaque ligne indiquerait la date, l’actif, le montant et la raison du versement.',
      needTitle: 'Ce qu’il faut',
      needBody:
        'Une liste de vos propres versements. Cette liste n’est pas activée : rien n’est affiché ici et aucun montant n’est deviné. Cela ne veut pas dire que vous n’avez rien reçu.',
      needToken: 'Vos jetons et votre activité de rendement sont dans leurs propres salles.',
      historyTitle: 'Votre historique de dividendes',
      historyLabel: 'Historique des dividendes',
      colDate: 'Date',
      colAsset: 'Actif',
      colAmount: 'Montant',
      colSource: 'Raison du versement',
      emptyTitle: 'Aucun dividende dans la liste',
      emptyBody: 'Votre historique apparaîtra dans ce tableau quand la liste sera activée.',
      token: 'Ouvrir Token →',
      earn: 'Ouvrir Earn →',
      activity: 'Ouvrir l’activité de l’argent →',
    },
  },
);
