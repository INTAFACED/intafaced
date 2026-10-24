import { defineCopy } from '../../shared/i18n';

/** The bills pot on a space's own page (BK-pots-03, J-bank-07 #4). */
const en = {
  title: 'Bills pot',
  isBills: 'This pot pays your bills.',
  notBills: 'This pot does not pay your bills.',
  fallbackOn:
    'Top-up from your account is on. When a standing order from this pot finds too little, the difference moves from your account into the pot first, and the order pays once.',
  fallbackOff:
    'Top-up from your account is off. When a standing order from this pot finds too little, it is refused and recorded, and nothing moves.',
  use: 'Pay bills from this pot',
  useTitle: 'Pay bills from this pot',
  useNote: 'Standing orders from this pot pay your bills. If another pot paid them, it stops. Top-up from your account starts off.',
  turnOn: 'Top up from my account',
  turnOnTitle: 'Top up this bills pot from your account',
  turnOnNote:
    'When a standing order from this pot finds too little, the difference moves from your account into the pot first, then the order pays. If your account is short too, nothing moves and the order is recorded as refused.',
  turnOff: 'Stop topping up',
  turnOffTitle: 'Stop topping up this bills pot',
  turnOffNote: 'A standing order from this pot that finds too little will be refused and recorded, and nothing moves.',
  stop: 'Stop paying bills from this pot',
  stopTitle: 'Stop paying bills from this pot',
  stopNote: 'The money in the pot stays where it is. Standing orders from it still run, without a top-up.',
  pot: 'Pot',
  topUp: 'Top-up from your account',
  on: 'On',
  off: 'Off',
} as const;

const es = {
  title: 'Espacio de facturas',
  isBills: 'Este espacio paga tus facturas.',
  notBills: 'Este espacio no paga tus facturas.',
  fallbackOn:
    'La recarga desde tu cuenta está activada. Cuando una orden periódica desde este espacio encuentra saldo insuficiente, la diferencia pasa primero de tu cuenta al espacio y la orden se paga una vez.',
  fallbackOff:
    'La recarga desde tu cuenta está desactivada. Cuando una orden periódica desde este espacio encuentra saldo insuficiente, se rechaza y queda registrada, y no se mueve nada.',
  use: 'Pagar facturas desde este espacio',
  useTitle: 'Pagar facturas desde este espacio',
  useNote:
    'Las órdenes periódicas desde este espacio pagan tus facturas. Si otro espacio las pagaba, deja de hacerlo. La recarga desde tu cuenta empieza desactivada.',
  turnOn: 'Recargar desde mi cuenta',
  turnOnTitle: 'Recargar este espacio de facturas desde tu cuenta',
  turnOnNote:
    'Cuando una orden periódica desde este espacio encuentra saldo insuficiente, la diferencia pasa primero de tu cuenta al espacio y luego se paga la orden. Si tu cuenta tampoco alcanza, no se mueve nada y la orden queda registrada como rechazada.',
  turnOff: 'Dejar de recargar',
  turnOffTitle: 'Dejar de recargar este espacio de facturas',
  turnOffNote:
    'Una orden periódica desde este espacio que encuentre saldo insuficiente se rechazará y quedará registrada, y no se moverá nada.',
  stop: 'Dejar de pagar facturas desde este espacio',
  stopTitle: 'Dejar de pagar facturas desde este espacio',
  stopNote: 'El dinero del espacio se queda donde está. Las órdenes periódicas desde él siguen, sin recarga.',
  pot: 'Espacio',
  topUp: 'Recarga desde tu cuenta',
  on: 'Activada',
  off: 'Desactivada',
} satisfies Record<keyof typeof en, string>;

const fr = {
  title: 'Espace factures',
  isBills: 'Cet espace paie tes factures.',
  notBills: 'Cet espace ne paie pas tes factures.',
  fallbackOn:
    'Le complément depuis ton compte est activé. Quand un virement permanent depuis cet espace trouve un solde insuffisant, la différence passe d’abord de ton compte à l’espace, puis le virement est payé une fois.',
  fallbackOff:
    'Le complément depuis ton compte est désactivé. Quand un virement permanent depuis cet espace trouve un solde insuffisant, il est refusé et enregistré, et rien ne bouge.',
  use: 'Payer les factures depuis cet espace',
  useTitle: 'Payer les factures depuis cet espace',
  useNote:
    'Les virements permanents depuis cet espace paient tes factures. Si un autre espace les payait, il arrête. Le complément depuis ton compte commence désactivé.',
  turnOn: 'Compléter depuis mon compte',
  turnOnTitle: 'Compléter cet espace factures depuis ton compte',
  turnOnNote:
    'Quand un virement permanent depuis cet espace trouve un solde insuffisant, la différence passe d’abord de ton compte à l’espace, puis le virement est payé. Si ton compte est aussi insuffisant, rien ne bouge et le virement est enregistré comme refusé.',
  turnOff: 'Arrêter le complément',
  turnOffTitle: 'Arrêter le complément de cet espace factures',
  turnOffNote: 'Un virement permanent depuis cet espace qui trouve un solde insuffisant sera refusé et enregistré, et rien ne bougera.',
  stop: 'Arrêter de payer les factures depuis cet espace',
  stopTitle: 'Arrêter de payer les factures depuis cet espace',
  stopNote: 'L’argent de l’espace reste où il est. Les virements permanents depuis cet espace continuent, sans complément.',
  pot: 'Espace',
  topUp: 'Complément depuis ton compte',
  on: 'Activé',
  off: 'Désactivé',
} satisfies Record<keyof typeof en, string>;

export const billsPotCopy = defineCopy('customer.money.bills-pot', en, { es, fr });
