import 'server-only';
import { bankCardProgrammeDeskSchema, bankCardProgrammeFiguresSchema, type BankCardProgrammeFigures } from '@intafaced/contracts';
import { founderCall, parseWith, type FounderCallContext, partFrom, type Part, founderRecordCall } from '@/lib/desk';
import { refusalWords, type Authorization, type Cardholder, type CardholderDetail, type Desk } from './model';
import {
  BANK_OPS_CARD_PROGRAMME_CARDHOLDERS,
  BANK_OPS_CARD_PROGRAMME_AUTHORIZATION,
  BANK_OPS_CARD_PROGRAMME_CARDHOLDER,
} from '@intafaced/contracts/bank-ops-procedures';

const labels = {
  service: 'svc-bank',
  forbiddenMessage: 'svc-bank did not accept this founder session for the card programme. Reading needs admin:read.',
  refusedMessage: refusalWords,
} as const;

export async function readDesk(ctx: FounderCallContext): Promise<{ asOf: string; desk: Part<Desk> }> {
  const result = await founderCall(ctx, 'bank', 'ops.cardProgrammeDesk', 'GET', undefined, parseWith(bankCardProgrammeDeskSchema));
  return { asOf: new Date().toISOString(), desk: partFrom(result, (d) => d, labels) };
}

export async function searchCardholders(ctx: FounderCallContext, query: string): Promise<Part<Cardholder[]>> {
  const result = await founderRecordCall(ctx, BANK_OPS_CARD_PROGRAMME_CARDHOLDERS, { query });
  return partFrom(result, (d) => d, labels);
}

export async function readAuthorization(ctx: FounderCallContext, id: string): Promise<{ asOf: string; part: Part<Authorization> }> {
  const result = await founderRecordCall(ctx, BANK_OPS_CARD_PROGRAMME_AUTHORIZATION, { id });
  return { asOf: new Date().toISOString(), part: partFrom(result, (d) => d, labels) };
}

export async function readCardholder(
  ctx: FounderCallContext,
  cardholderId: string,
): Promise<{ asOf: string; part: Part<CardholderDetail> }> {
  const result = await founderRecordCall(ctx, BANK_OPS_CARD_PROGRAMME_CARDHOLDER, { cardholderId });
  return { asOf: new Date().toISOString(), part: partFrom(result, (d) => d, labels) };
}

/** The programme's own figures as the card partner reports them, from the funding read (J-bank-26 #5). */
export type ProgrammeFigures = BankCardProgrammeFigures;
export async function readProgrammeFigures(ctx: FounderCallContext): Promise<Part<ProgrammeFigures>> {
  const result = await founderCall(ctx, 'bank', 'ops.cardProgrammeFunding', 'GET', undefined, parseWith(bankCardProgrammeFiguresSchema));
  return partFrom(result, (d) => d, labels);
}
