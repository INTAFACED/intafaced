/**
 * The decimal math of `@intafaced/ledger-client/money`, and nothing else.
 *
 * A front end formats and compares amounts; it never posts to the ledger. Depending on this package instead of
 * ledger-client gives it the parse, format and scaled-bigint arithmetic with no way to reach a recipe or a ledger
 * client. The code itself stays in ledger-client, so the math the ledger reconciles with is the math the screens show.
 */
export * from '@intafaced/ledger-client/money';
