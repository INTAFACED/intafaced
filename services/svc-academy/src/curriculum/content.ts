/**
 * CURRICULUM CONTENT — the teaching material itself (TRK-academy.curriculum).
 *
 * `catalog.ts` is the registry: slugs, paths, ordering, query helpers. This file
 * is what a reader actually reads. They are split because the registry's job is
 * lookup and the content's job is instruction, and mixing them made the catalog
 * hard to review on both counts.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * The spine met the tracker's *count* promise (20 playbooks + 3 workbooks) while
 * nineteen of those items carried a three-bullet stub body of roughly 250
 * characters and the remaining six ran 427–634. The count gate in
 * `import-pipeline.ts` only requires 40 characters and a leading heading, so all
 * twenty-five passed validation while teaching close to nothing. This file
 * closes the depth gap the count gate could not see.
 *
 * ── Content rules (binding on every body below) ─────────────────────────────
 *
 * 1. No invented market facts. No prices, quotes, depth, volumes, returns or
 *    backtest results presented as observations. Worked examples use invented
 *    arithmetic and say so on the line above the numbers.
 * 2. No third-party vendor, exchange, broker or education-partner names
 *    (Doctrine §0.7). Copy is platform-native only.
 * 3. No outbound URLs — `brandChecklist` rejects them, and link policy is
 *    platform-owned.
 * 4. Workbooks are drills, and they never paint a simulated fill as a real one.
 *    Simulated execution belongs to the paper market path (`academy.paper-trading`)
 *    and certification/XP belongs to `academy.certs`. Neither is invented here.
 * 5. Nothing in this service moves value. No balances, no ledger, no money type
 *    appears in this module — the money doctrine has no surface to apply to.
 *
 * ── Locale ─────────────────────────────────────────────────────────────────
 *
 * Bodies are English (`en`), the one locale with real assets. Requests for any
 * other locale fall back to these and report `fellBack: true` — see
 * `i18n-strategy.ts`. We never invent a translation.
 */

/** One glossary entry attached to a curriculum item. */
export interface CurriculumKeyTerm {
  readonly term: string;
  readonly definition: string;
}

/**
 * The pedagogical scaffolding around a body: what the reader should be able to
 * do afterwards, the vocabulary the body assumes, and questions that reveal
 * whether they actually got it.
 *
 * This is what turns one markdown blob into a screen a UI can lay out.
 */
export interface CurriculumTeaching {
  /** What a reader can do after the item. Present tense, checkable. */
  readonly objectives: readonly string[];
  /** Vocabulary the body uses and defines. */
  readonly keyTerms: readonly CurriculumKeyTerm[];
  /** Questions to answer before moving on. Not graded here — `academy.certs` owns grading. */
  readonly selfCheck: readonly string[];
}

/**
 * Editorial reading-time estimate at 200 words per minute, rounded up, floor 1.
 *
 * It is a convention for laying out a screen, not a measurement of anyone, and
 * it is derived from the body rather than hand-typed so it cannot drift away
 * from the content it describes.
 */
export function readingMinutes(body: string): number {
  const words = body.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 200));
}

/**
 * Every body on the spine, keyed by slug. `catalog.ts` holds no prose at all.
 *
 * The nineteen expansion items previously carried a three-bullet stub of roughly
 * 250 characters. The six day-one items were hand-written but ran 427–634
 * characters — a screen's worth of headings, not a lesson. Both are here now, at
 * full length, so "which items are real" stops being a question about where a
 * string happens to live.
 */
export const CURRICULUM_BODIES: Readonly<Record<string, string>> = {
  // ── day-one spine ─────────────────────────────────────────────────────────
  //
  // These six shipped with the thin slice. Their headings and their arguments
  // are the originals; what was added is the mechanics, the worked arithmetic
  // and the mistakes — the parts a reader needs and a heading only promises.

  'foundations-risk-first': `# Risk first

Every path in the Academy starts here. Before charts, before setups, before an
agent is allowed near a live order — know what you can lose.

Risk is the only part of a trade that is yours to decide. The market decides
whether you were right; you decide what being wrong costs. Everything below
follows from that split, and most of the ways people lose an account come from
ignoring it while believing they were doing analysis.

## Position size

Size from risk, not conviction. Pick the amount of capital you are willing to
lose on the idea, then work the size backward from the level that proves the idea
wrong. Conviction is not an input — it runs highest exactly when you are least
able to assess it.

The mechanism is one division: the amount you accept losing, divided by the loss
per unit over the distance to your invalidation level.

### Worked example — illustrative arithmetic only

The numbers are invented to show the arithmetic. They are not a quote, an
observation, or anyone's result.

- Account: 10,000 units of the quote currency.
- Risk accepted on this idea, chosen in advance: 1 percent — so 100 units.
- The idea is disproved 5 units of price away from your intended entry.
- Size = 100 / 5 = 20 units of the instrument.

Move the invalidation to 10 units away and the size halves to 10. The amount at
risk did not change. That is the property worth having: your loss when wrong is a
number you chose in advance rather than one the market handed you afterwards.

## Drawdown

Drawdown is the decline from a previous high in account value. It matters because
recovery is not symmetrical with loss — the deeper the hole, the larger the gain
needed to climb out of it, and that arithmetic is indifferent to how the hole was
dug.

A daily loss prompt is a brake, not a challenge. Identity Blueprint guardrails
seed a default; you may raise it, never ignore it quietly. A limit gets all of
its value from being set before the day it binds, so that the version of you
who is losing does not get to renegotiate with the version who was thinking
clearly.

## Common mistakes

- Sizing from what the account can afford rather than from where the idea fails.
- Adding size after a run of winners, which raises the cost of the next loss
  precisely when the internal case for restraint is weakest.
- Treating a leverage setting as a risk setting. Leverage changes the margin
  required to hold a position; it does not change the loss over the invalidation
  distance.
- Holding several positions that share one driver and counting them as several
  independent risks.

## What this is not

This playbook does not move money. Paper practice lands with the workbook flag on
the trade service. Live size is your call, on your rails.

## Before you move on

Write down two numbers: the fraction of the account you will risk on a single
idea, and the daily loss at which you stop for the day. In writing, before your
next order — not during it.`,

  'foundations-order-types': `# Order types you will actually use

Three order types cover nearly everything a trader needs. The differences between
them are not features to compare; they are choices about what you are willing to
be uncertain about.

Every order answers two questions: at what price, and how soon. You may fix one
of them. Fixing both is what a market exists to arbitrate, and it does not sell
that certainty to anybody.

## Market

Fill now at whatever the book offers. You fix time and accept price uncertainty.

Use when waiting costs more than the spread — an exit already decided, a stop
that must not be renegotiated, a position that has to be flat before something
scheduled. What you pay is the spread plus whatever the book charges beyond the
first level for your size, which is why depth matters more here than anywhere
else.

Confirm before send if your guardrails say so. This is the one type where a slip
of the finger is expensive immediately rather than eventually.

## Limit

Fill only at your price or better. You fix price and accept time uncertainty,
including the real possibility of never trading at all.

Use when the level matters more than the speed. The cost is not zero merely
because no spread was crossed: an order that sits unfilled while the idea works
is a genuine loss, just an invisible one. Beginners systematically under-count
it, because unfilled orders leave no mark on a balance and losses that leave no
mark are easy to stop counting.

A limit that never trades is not a broken screen. It is the book declining your
price, which is itself information about what the price is.

## Stop

Exit (or enter) when price crosses a level you already chose. A stop is not a
guarantee of price — it is an instruction to send an order once a level trades.
What arrives next depends on what the book holds at that moment, and where depth
is thin that can be some distance from the trigger.

Write the level before you enter; rewriting it mid-trade is how small losses
become large ones. Know which type of order your stop sends, because that decides
whether you accept a worse price or risk not exiting at all.

## Choosing, in one line

Ask what you cannot tolerate. Cannot tolerate not trading → immediacy. Cannot
tolerate a bad price → a named price. Cannot tolerate an open-ended loss → a
level written in advance, and then honoured.

## Common mistakes

- Demanding immediacy out of impatience and calling it decisiveness.
- Placing a resting order and then chasing it a few units at a time, until you
  have paid for immediacy in instalments and at a worse average.
- Assuming a stop guarantees the trigger price.
- Cancelling a stop because price is "about to come back", which converts a
  decision made calmly into one made under pressure.

## Before you move on

For your next planned trade, write which type you will use to enter, which to
exit, and one sentence each on what you accepted being uncertain about.`,

  'markets-reading-the-book': `# Reading the book

A quote is a moment, not a guarantee. Thin books gap; wide spreads are a tax you
pay whether or not you notice.

The book is the set of resting orders at each price on both sides. It shows what
participants are currently willing to do — and only until they change their
minds, which they may do faster than you can act on what you saw.

## Depth

Look past the top of book. The best price applies only to the size resting at it.
A size that looks comfortable against the top line can consume the next three
levels the moment you demand immediacy.

### Worked example — illustrative arithmetic only

Invented numbers, to show how an average fill is assembled. Not a quote and not
an observation of any market.

Suppose the resting offers are 100 units at a price of 50, then 100 units at 51,
then 300 units at 53. An immediate buy of 150 units takes 100 at 50 and 50 at 51,
averaging about 50.33. The same order for 500 units reaches the third level, and
the average lands materially above the number displayed at the top.

Nothing malfunctioned there. The book did exactly what it advertised. The trader
who sized against the top line simply read one row of a document that had
several.

## Spread

The spread is the distance between the best resting buy and the best resting
sell. Crossing it is a cost paid on entry and usually again on exit, on every
trade, including the losing ones.

A wide spread is not automatically bad — it usually prices genuine uncertainty or
thin participation. It does mean a strategy that trades often pays it often, and
any edge has to clear that hurdle before anything is left over for you.

## When the book is empty

An empty book is a true state, not a rendering failure. The honest response is to
show nothing and refuse to trade, rather than interpolate a plausible number. A
platform that invents a level to keep a screen looking alive is teaching you to
trust a number that nobody was willing to trade at.

## Venue choice

Route on evidence — fees, depth, and settlement posture — not brand loyalty. When
a venue cannot answer, the platform refuses rather than inventing a fill.

## Common mistakes

- Sizing from the top of book without reading the levels behind it.
- Treating each snapshot of a fast-moving book as though it were durable.
- Reading a quiet book as a broken feed, and a broken feed as a quiet book.
- Comparing venues on headline fees while ignoring what their depth costs you at
  your actual size.

## Before you move on

For one instrument you trade, write down how many levels your usual size would
reach if you demanded immediacy right now, and what that implies for the exit you
have planned.`,

  'builder-first-automation': `# First automation, no live capital

An agent without a kill-switch is not an agent you run. Start paper-only.

Automation changes the size of a mistake, not its nature. A rule you would apply
badly by hand will be applied badly a thousand times, faster, and without the
pause in which you might have noticed.

## Guardrails

Identity Blueprint writes default limits (leverage ceiling, daily loss prompt,
confirm-before-market). Treat them as the starting posture, not a ceiling to race
past on day one.

A guardrail is real only when something other than your attention enforces it.
Write each one as a number the code reads: largest position, most orders per
interval, loss at which the run halts itself. If you cannot point at the line
that reads the number, you have written an intention rather than a limit.

## Kill-switch

You must be able to stop the strategy from a surface you control. If you cannot
name that surface, do not start the run.

Name three layers before the first run: the halt inside the application, the stop
of the process itself, and revocation of whatever credential lets it act. Then
exercise each against something actually running. A stop that has never been
tested is decoration, and you learn which kind you own at the worst available
moment.

## Start on paper

Run against the platform's paper market path where it is switched on. A paper run
costs time and nothing else, and it answers questions no amount of reading will:
what the automation does when data stops arriving, when an action is refused, and
when it restarts holding a position it does not remember opening.

Where the paper path is off, the honest state is that those paths are untested —
not that they work.

## What to watch on the first runs

- **Refusals.** Every one should carry a cause you can read afterwards.
- **Restarts.** What does it believe about open positions on the way back up?
- **Duplicates.** Does a retried instruction act twice?
- **Silence.** Does a stalled data source look identical to a calm market? If so,
  the automation cannot tell them apart either.

## Common mistakes

- Arming a run because the code compiles and the logic reads correctly.
- Skipping the paper stage because paper "is not real" — which is exactly why it
  is the right place to be wrong.
- Letting credentials that can touch real balances travel with a paper run.
- Reading an absence of errors as evidence, when nothing exercised the failure
  paths.

## Before you move on

Write your three stop layers and the numeric limits your code actually enforces.
Then stop a running instance three ways and record how long each took and what
was still outstanding afterwards.`,

  'sovereign-self-custody-posture': `# Self-custody posture

The platform is multi-rail. Some balances sit in house custody under the ledger;
some never leave a wallet you control. Confusing the two is how people mis-size
risk.

Custody is not a preference you select from a menu. It is a factual answer to one
question: who can move this, without asking anyone?

## The two postures

**Custodial.** Someone else holds the asset and shows you a balance. What you own
is a claim. Claims are usually easier to live with — they can be reversed,
supported and reconciled — and they depend on the holder remaining both able and
willing to honour them.

**Self-custody.** You hold the key. Nobody can move the asset without you, and
nobody can restore it for you either. Convenience and recourse are what you gave
up to get that.

Neither posture is superior. They fail in different directions, and the whole
skill is knowing which failure you signed up for on each balance you hold.

## Ask one question

If this process dies right now, whose money is stranded and how does it come back?
If you cannot answer, do not move the size.

Ask it of a transfer that is half complete, of a settlement in progress, and of a
lost device. Each has a different answer, and each answer should exist before the
day you need it.

## Obligations follow custody

Where a platform holds the asset, verification and limits attach to it, because
holding someone else's value carries duties that do not evaporate because a
screen is convenient. Where the platform never holds it, those obligations have
nothing to attach to.

That is why requirements differ between surfaces — not preference, and not a
setting anyone can flip for you on request. Treat any offer to bypass one as a
description of who you are dealing with.

## No partner names

Your rails, your labels. Third-party brand names do not appear in Academy copy.

## Common mistakes

- Reading a displayed balance as proof of possession.
- Keeping one backup of a key, in one place, and calling it a backup.
- Assuming a transfer on a self-custody rail can be reversed by contacting
  somebody.
- Practising a recovery for the first time during an actual emergency.

## Before you move on

List every balance you hold. Beside each, write who can move it without asking
you, and what you would still have if that party became unreachable tomorrow.`,

  'foundations-paper-workbook': `# Paper practice drills

Drills for the mechanics of placing, cancelling and honouring an order. Each one
states a task, a rule you must not break, and something checkable afterwards.

Nothing here moves value. Drills that need execution require the platform's paper
market path to be switched on — that flag is owned by the trade service and is
not set from here. Where it is off, the drill stops at the written artifact
rather than pretending to have run.

## Drill 1 — size from an invalidation level

Choose an instrument and write, in this order: the level at which the idea is
disproved, the distance from your intended entry to that level, the amount you
accept losing, and only then the size that arithmetic gives you.

**The rule you must not break:** the size line is written fourth. If you knew the
size before writing the distance, start the sheet again.

**Check yourself:** repeat with the invalidation twice as far away. The size
should fall to roughly half. If it did not, one of the first three lines was
chosen to protect the fourth.

## Drill 2 — place a resting order that does not trade, then cancel it

Place an order at a price the market is not currently offering, leave it alone,
then cancel it and confirm it is gone from your working orders.

**The rule you must not break:** confirm the cancel; never assume it. A request
is not a state.

**Check yourself:** you can say where you saw the confirmation, and your
working-order list is empty.

## Drill 3 — honour an exit you wrote first

Write an exit level before entry. Take the position on the paper path, and when
the level is reached, act on it without renegotiating.

**The rule you must not break:** the level does not move once the position
exists. If you moved it, the drill failed — including when the outcome was
pleasant, because a process that only fails when you are punished is not a
process.

**Check yourself:** the level in your notes before entry matches the level you
acted on.

## Drill 4 — cost the round trip

For one completed paper trade, write down every cost between entry and exit: the
distance you crossed on each side, and any fee the platform states. Subtract the
total from the raw result.

**The rule you must not break:** an unknown cost is recorded as unknown, never as
zero.

**Check yourself:** your net figure is worse than your raw figure, and you can
name each item that made it so.

## Drill 5 — the trade you did not take

Find one setup you decided against and write the sheet anyway: invalidation,
distance, size, exit. Then note what happened afterwards.

**The rule you must not break:** write the sheet before you look at the outcome.

**Check yourself:** you have at least one entry per week where the answer was no.
A journal containing only trades you took is a record of your enthusiasm, not of
your judgement.

## What this workbook deliberately does not do

It produces no fills of its own, holds no balance, and awards no progress.
Simulated execution belongs to the paper market path; certification and any
reward for completing work belong to the certification path. Both are owned
elsewhere and neither is invented here.`,

  // ── foundations ───────────────────────────────────────────────────────────

  'foundations-position-sizing': `# Position sizing without inventing numbers

Size is not a feeling. It is arithmetic you can do before you have an opinion
about direction, and it is the only part of a trade you fully control.

## The three inputs

1. **Account risk** — the fraction of the account you accept losing if this idea
   is wrong. Choose it once, in advance, for a whole class of trades, so that it
   is not being chosen by your mood on the day.
2. **Invalidation distance** — how far price must travel against you before the
   idea is disproved. This comes from structure, not from what you can afford.
3. **Instrument mechanics** — what one unit of the instrument gains or loses per
   unit of price movement, plus the fees and financing that attach to holding it.

Size is the output, not an input: account risk divided by the loss per unit over
the invalidation distance.

## Worked example — illustrative arithmetic only

The numbers below are invented to show the arithmetic. They are not a quote, an
observation, or a result anyone achieved.

- Account: 10,000 units of the quote currency.
- Account risk chosen in advance: 1 percent, so 100 units.
- The idea is disproved 4 units of price away from entry.
- Position size = 100 / 4 = 25 units of the instrument.

Notice what never appeared: a target, a conviction score, or how the last trade
went. Double the invalidation distance and the size halves. That is the whole
mechanism, and it is the same mechanism at every account size.

## Why "invent" is in the title

The failure mode is deciding size first — because it feels right, because it
worked last time, because the balance looks healthy today — and then hunting for
an invalidation level that justifies it. That reverses the arithmetic and
quietly converts a risk budget into a wish.

## Leverage is not size

Leverage changes the margin required to hold a position. It does not change what
you lose if the idea is wrong, which is still the invalidation distance times the
size. Treating a leverage setting as a risk setting is one of the more expensive
category errors available, because it feels like a decision about risk while
leaving actual risk untouched.

## Common mistakes

- Sizing from the account balance rather than from the distance to invalidation.
- Widening the invalidation after entry so the position survives. The risk
  budget was spent the moment you did that.
- Ignoring fees and financing, which are part of the cost of being wrong.
- Using one account-risk fraction for ideas of very different quality without
  ever writing down what distinguishes them.

## Before you move on

Write down the account-risk fraction you will use and one instrument's
mechanics. Compute the size for two different invalidation distances and confirm
the two sizes differ. Where the platform's paper market path is switched on,
practise there. Nothing in this item moves value.`,

  'foundations-invalidation-first': `# Invalidation before entry

Invalidation is the condition that proves your idea wrong. Writing it first is
what makes every later decision mechanical instead of emotional.

## Why the order matters

Choose invalidation before entry and the trade defines itself: size follows from
the distance, the exit is already decided, and being wrong is an outcome you
planned for rather than an event that happens to you.

Choose entry first and invalidation becomes negotiable. You will place it where
the loss feels tolerable, which is a statement about your feelings and not about
the market. The level will then be wherever your comfort happened to sit, which
is not a level anything else in the market cares about.

## What a good invalidation looks like

- **Specific.** A level or a condition, not a mood. "Below the low that started
  the move" can be checked by someone else. "If it looks weak" cannot.
- **Structural.** Derived from where your reasoning breaks. If the structural
  level sits further away than your risk budget allows, the answer is a smaller
  size or no trade — never a closer invalidation.
- **Reachable.** If price would have to do something implausible to reach it, you
  have not written an invalidation. You have written a comfort.
- **Time-bounded where relevant.** "This should have happened by now" is a
  legitimate invalidation and the one people most often forget to write, which
  is why dead ideas keep their capital for weeks.

## Worked example — illustrative arithmetic only

Invented numbers, to show the order of operations rather than any market.

You reason that a level has held repeatedly and expect it to hold again. Your
thesis is wrong if price trades decisively below it. That structural level sits
6 units of price below your entry. Your account risk is 100 units. Size is
therefore 100 / 6, or about 16 units.

Now reverse the order. Had you decided on 50 units of size first, you would have
needed the invalidation about 2 units away — well inside ordinary noise, where
you get stopped out by nothing in particular and then watch the idea work
without you. Same idea, same market, different order of operations, opposite
experience.

## The mid-trade rewrite

Moving an invalidation further away while a position is open converts a planned
loss into an unplanned one. It always feels justified at the time, because the
justifying reasons arrive exactly when they are needed. Decide in advance that
the level moves in your favour or not at all, and treat any exception as a
process failure to be written down even when the trade recovers.

## Common mistakes

- Placing invalidation at an obvious round number where everyone else's sits.
- Reusing one invalidation across several instruments that share a driver.
- Writing no time component, so an idea that stopped being true never exits.
- Confusing invalidation with a target. One is where you are wrong; the other is
  where you would take profit. They are not symmetrical and rarely equidistant.

## Before you move on

Write invalidations for three ideas you are currently watching. For each, state
what would have to be true for you to admit the idea failed — before you hold any
position in it.`,

  'foundations-journal-discipline': `# Trade journal discipline

A journal is not a diary. It is the instrument that turns a sequence of trades
into evidence about your process, and it only works if entries are written at
the times that make them falsifiable.

## Write before, not only after

The pre-trade entry carries almost all of the value, because it is the only one
written while the outcome is still unknown. Before the order, record:

- **Thesis** — one sentence naming what you think is happening and why.
- **Invalidation** — the level or condition that proves the thesis wrong.
- **Size and account risk** — the number, and the fraction of the account it is.
- **Exit plan** — how you leave if right, and how you leave if wrong.
- **Why now** — what changed that makes this the moment rather than last week.

If a line is hard to write, that difficulty is itself information. A thesis you
cannot state in one sentence is usually several theses wearing one coat, or none.

## Write after, honestly

The post-trade entry records what the market did, not how you felt about it:
what filled, at what cost relative to plan, whether the invalidation was
respected, and whether you followed your own exit plan.

Separate outcome from process. A trade can be well executed and lose. A trade
can be badly executed and win. Grading by outcome alone teaches you the wrong
lesson from both, and it teaches the wrong lesson most confidently after a win.

## The forbidden edit

Never rewrite a thesis after the fact so that it matches the result. This is the
single most common way a journal becomes useless: it stops being a record and
becomes a highlight reel that invents skill you did not demonstrate. If your
tooling allows editing past entries, append a correction rather than overwrite,
so the original claim survives next to what actually happened.

## What to review, and when

Review on a schedule, not in the emotional aftermath of a painful trade. You are
looking for repeats: the same invalidation ignored, the same instrument, the same
hour of day, the same "why now" that keeps not mattering.

One repeated mistake found is worth more than a hundred rows of well-formatted
data. If your review never changes anything you do, it is a filing exercise.

## Fields that earn their place

Keep the journal small enough that you actually fill it in. Every field should be
one you have used to change a decision. A schema nobody completes produces
nothing; five fields completed every time produce evidence.

## Before you move on

Write a complete pre-trade entry for an idea you are deliberately not going to
take. It costs nothing and immediately shows which of the five lines you cannot
yet fill in.`,

  'foundations-fees-are-real': `# Fees are real cost

Fees are not administrative noise. They are a fixed adversary that takes the
same amount whether you were right or wrong, and they scale with how often you
act rather than with how well you act.

## Name every cost

The visible fee is rarely the whole cost. A full accounting includes:

- **Explicit fees** on entry and on exit — the round trip, never one side of it.
- **The spread** you crossed in order to get filled.
- **Slippage** beyond the level you were looking at when you decided.
- **Financing or carry** for positions held across the relevant period.
- **Transfer costs** to move value onto or off a rail in the first place.

An estimate that counts only the first line understates the real number, and it
understates it most for exactly the short-horizon approaches that pay it most
often.

## The break-even shift

Costs move the point at which you stop losing money. Whatever your edge is, the
market has to return the costs before it returns anything to you. The shorter the
holding period, the more times you pay, and the larger the share of your result
that costs decide rather than judgement.

## Worked example — illustrative arithmetic only

Invented numbers, to show the multiplication rather than any real schedule.

Suppose a full round trip costs 0.2 percent of position value once everything is
counted, and suppose you take 200 round trips over a period. That is 40 percent
of one position's value paid out over the period, regardless of direction and
regardless of whether the ideas were good.

Substitute your own figures; the multiplication is the point. An approach
evaluated without this line is not being evaluated, it is being flattered.

## Unknown is not free

An empty fee field means you have not looked it up. It does not mean zero. A
journal that silently records blanks as zero will eventually teach you that an
expensive approach was profitable, and you will scale it.

Find the real number, or record it explicitly as unknown so that every conclusion
drawn from it stays provisional until you do.

## What to do about it

- Count the round trip in every plan, before the trade rather than after.
- Compare approaches after costs, never before.
- Treat activity itself as a cost, because it is one.
- Recheck assumed rates periodically. A stale rate is a wrong rate, and it is
  wrong in a direction you will not notice.

## Before you move on

For one instrument and your typical size, write down the full round-trip cost
including the spread you expect to cross. Then work out what fraction of a
typical move in that instrument the number represents.`,

  // ── markets ───────────────────────────────────────────────────────────────

  'markets-spread-and-slippage': `# Spread and slippage honesty

Two different execution costs routinely get blamed on each other. Separating
them is the first step to knowing what your execution actually costs you.

## Spread

The spread is the gap between the best price at which someone will buy and the
best price at which someone will sell. Crossing it is the price of immediacy:
you pay it the moment you demand a fill instead of waiting for one. It is a real
cost even though no statement line names it.

## Slippage

Slippage is the difference between the price you expected and the price you
received. It has two ordinary causes, and they are not the same problem:

1. **Depth** — your order is larger than the size resting at the best level, so
   it consumes the next levels too. This is arithmetic, and it is predictable if
   you look at the book before sending.
2. **Movement** — the market moved between your decision and your fill. This is
   latency and volatility, and no order type removes it entirely.

Conflating them leads to the wrong fix. Depth slippage is solved by sizing and
splitting; movement slippage is not.

## Worked example — illustrative arithmetic only

Invented numbers, to show the mechanism rather than any real book.

Suppose you want 100 units, and the resting sizes available as you go up through
the book are 40 units at one level, 30 at the next, and 30 at the next, each a
little worse than the one before. An order demanding immediate execution takes
all three, and your average cost sits above the best level you were looking at
when you decided.

Nothing malfunctioned. You bought more than the top of the book was offering, and
the arithmetic did what arithmetic does.

## A midpoint is not a tradeable price

A midpoint is a computed average of two sides. It is useful as a reference and it
is not an offer from anyone. Building a plan off the midpoint and then being
surprised by the fill is a category error rather than bad luck, and it is one
that scales badly: the wider the spread, the more the midpoint lies to you.

## Reduce what you can, accept what you cannot

- Use a resting order when the level matters more than the speed, and accept it
  may never trade.
- Split a large order when depth, not urgency, is the binding constraint.
- Treat a wide spread as information about conditions, not as an obstacle to
  push through harder.
- When the book is empty, that is a true state. An interface showing nothing is
  being honest. A number invented to fill the space would not be, and you would
  size off it.

## Before you move on

For one instrument, write down what you would expect to pay in spread for
immediate execution, and separately what depth you would need for an order twice
your usual size. Then look at the book and check whether it is there.`,

  'markets-order-types-honest': `# Order types without magic

Order types do not change what the market will do. They change what you are
asking for and what you are willing to give up to get it. Every one of them
trades certainty of execution against certainty of price.

## The two you must understand first

- **An order demanding immediacy** asks to trade now. You are certain to trade,
  while there is anything to trade against, and uncertain about the price.
- **An order naming a price** asks for a level. You are certain about the worst
  price you will accept and uncertain about whether you trade at all.

You cannot have both certainties at once. Every other order type is a
combination, a condition, or an automation layered on these two, and none of
them escapes the trade-off.

## A resting order that never fills has not failed

It reported something true: nobody was willing to trade at your price while it
was there. The temptation is to conclude the interface is broken and to cross
the spread in irritation. Sometimes crossing is correct — but make it a decision
about urgency, taken deliberately, and not a reflex against an inconvenient
truth.

## A stop is a trigger, not a guarantee

A stop is a level at which an order is sent. What happens next depends entirely
on which order it sends and on the market at that moment.

If it sends an order demanding immediacy, you are exposed to whatever depth
exists then — and in exactly the fast conditions that trigger stops, depth is
often thin. If it sends an order naming a price, you may not trade at all, and
may keep the position you meant to exit.

Neither behaviour is a defect. Knowing which one yours does is your job, and the
answer changes what the stop actually protects you from.

## Cancel is a first-class action

Cancelling is part of the plan, not an admission of error. Practise it: place a
resting order you do not intend to trade, cancel it, and confirm it has left
your working orders.

Between requesting a cancel and its confirmation, the order can still trade.
"Cancel requested" and "cancelled" are different states and should be displayed
as different states. An order you believe is cancelled but which is still working
is one of the more expensive misunderstandings available.

## Never paint a working order as filled

A working order is not a position. Any process — a spreadsheet, a journal, an
interface, an automation — that displays an unfilled order as though it had
traded will produce decisions based on a position you do not hold. Where a status
is unknown, the honest display is unknown.

## Before you move on

For one instrument, write down what your stop actually sends when it triggers.
If you cannot answer from documentation rather than assumption, finding that out
is the next thing to do.`,

  'markets-session-structure': `# Session structure

Liquidity is not constant through a day, and neither is the meaning of a given
move. Session structure is the habit of asking *when* before asking *what*.

## Why time of day changes the read

Participation changes as different groups of participants become active or go
quiet. When fewer participants are quoting, the same order moves price further,
spreads tend to widen, and a move can look decisive while resting on very
little. When more are quoting, a larger order may move price less.

The practical consequence: identical price behaviour can mean different things
depending on how much was behind it. A chart that shows only price hides the
variable that changes the interpretation.

## Opens, middles and closes

- **Around an open**, activity and volatility are commonly elevated as
  information accumulated while the market was quiet gets absorbed. Ranges set
  here are frequently revisited later.
- **In the middle of a session**, activity often settles. A breakout here needs
  more evidence, because there is less participation available to sustain it.
- **Toward a close**, flow can be driven by position management rather than fresh
  opinion — a move that says more about who needs to be flat than about what
  anything is worth.

Treat these as tendencies to verify on the instruments you actually trade, not
as laws. Markets differ, and an instrument that trades continuously has a
different structure again, with its own quiet hours rather than a formal close.

## Observe before you name

The discipline is: watch your instrument across sessions, record what you see,
and only then attach a label. A regime name adopted from someone else's market
is a borrowed conclusion. If you cannot point at your own observations behind a
label, you are pattern-matching a story rather than reading a market.

## A calendar is not law

Scheduled events change participation, and knowing one is coming is useful.
Importing someone else's event calendar and treating it as platform truth is
not — it is an unverified input arriving with authority it has not earned. Note
what you have confirmed matters for your instruments, and hold the rest lightly.

## Common mistakes

- Comparing volatility across sessions without adjusting for participation.
- Sizing identically at every hour of the day.
- Assuming a quiet book is a safe book. For exits it is usually the opposite.
- Concluding from a handful of sessions. Tendencies need a record, not an anecdote.

## Before you move on

Pick one instrument and record, across five sessions, when spreads were widest
and when the largest moves happened. Do not conclude anything yet — build the
record you will later reason from.`,

  'markets-correlation-caution': `# Correlation caution

Two positions in two instruments can be one bet. When they are, your risk is not
what your position list says it is.

## Diversification that is not

Splitting capital across several instruments reduces risk only when the things
driving them differ. If they share a driver, you have not spread risk — you have
multiplied one exposure and given it several names. The position list looks
balanced. The outcome will not be.

## Ask what the shared driver is

For any two positions, answer in one sentence: what would have to happen for both
to lose at the same time? If the answer is a single event, they are one position
for risk purposes and should be sized as one.

Shared drivers commonly include the same underlying asset in a different wrapper,
the same funding conditions, the same sector or supply chain, the same settlement
rail, and the same venue. The last two are easy to miss because they are not
about the asset at all.

## The stacking arithmetic

If you size each of three positions at 1 percent of account risk and all three
share a driver, the honest figure is up to 3 percent on one event, not 1 percent
three times over.

Treat the correlated group's total as the number that has to fit your budget, and
size the members down so that it does. This is the entire adjustment, and it is
routinely skipped because each individual position looks reasonable in isolation.

## Correlation is not constant

Relationships measured in calm conditions frequently change under stress, and
they change in the least convenient direction: things that normally move
independently move together when participants are reducing risk everywhere at
once. A hedge justified purely by a historical relationship can stop hedging at
precisely the moment it was supposed to matter.

Treat any measured relationship as a description of a stated period, not as a
property of the instruments. Write the period down next to the number.

## Hedges must be proved, not assumed

A position is a hedge only if you can state the mechanism by which it offsets the
other one, and the conditions under which that mechanism fails. "These usually
move opposite each other" is an observation about the past. Without a mechanism
you do not have a hedge; you have two positions and a hope, and you are paying
costs on both.

## Common mistakes

- Counting each instrument as independent risk when they share one driver.
- Treating a historical co-move as a hedge without a stated failure mechanism.

## Before you move on

List your open positions and group them by shared driver. Sum the account risk
inside each group. If any group exceeds what you intended to risk on a single
event, you have found the thing to fix before you add anything new.`,

  // ── builder ───────────────────────────────────────────────────────────────

  'builder-kill-switch-drill': `# Kill-switch drill

A stop you have never tested is decoration. This item is about converting "I
could stop it" into a rehearsed, timed action.

## Name the surface first

Before an automation starts, write down exactly how you will stop it: which
control, which command, which credential you would revoke. If the answer is "I
would figure it out", the run does not start. Under stress you will not figure it
out — you will do whatever you have already practised.

## The three layers

A single stop is a single point of failure. Real automations have layers, each of
which works when the one above it is unavailable:

1. **Application stop** — the automation's own halt path. Fastest, and the first
   to be useless if the process is wedged.
2. **Process stop** — ending the runtime that hosts it. Works when the
   application itself is unresponsive.
3. **Credential stop** — revoking the keys or permissions it acts with. Works
   even when the process is beyond your control entirely, including on a machine
   you cannot reach.

The third layer is the one people skip and the one that matters on the day a
host is unreachable. It is also the only layer that still works if the
automation is running somewhere you did not expect.

## Decide what "stopped" means

Stopping the decision loop is not the same as being flat. Decide in advance, and
write down, which of these your kill-switch performs:

- Stop opening new positions and leave existing ones alone.
- Stop opening new positions and cancel resting orders.
- Do both, and close open positions as well.

Each is a legitimate choice with different consequences. Not having chosen is not
a choice, it is a surprise waiting for a bad moment.

## The drill

Run this against the platform's paper market path where it is switched on, and
repeat it whenever the automation changes:

1. Start the automation and let it reach a normal working state.
2. Trigger the application stop. Time it. Record what remained outstanding.
3. Restart, then trigger the process stop. Confirm nothing restarts it for you.
4. Restart, then revoke the credential. Confirm the automation cannot act.
5. Write down each elapsed time and everything still outstanding at the end.

## Common mistakes

- A stop that requires the automation to be healthy in order to work at all.
- A supervisor that helpfully restarts the process you just stopped.
- Credentials cached somewhere the revocation does not reach.
- Never repeating the drill after changing the code, so the measured times
  describe a version that no longer exists.

## Before you move on

Write the three layers for one automation you actually run, with the elapsed time
you measured for each. Any blank line is a layer that does not exist yet.`,

  'builder-logs-not-vibes': `# Logs not vibes

"It seemed to be working" is not a claim anyone can check, including you next
month. An automation that cannot be audited is one you cannot improve, because
you have no way to tell which change helped.

## What a decision record contains

Every action should be reconstructable afterwards from what the system wrote at
the time:

- **When** — a timestamp with a timezone, from a clock you trust.
- **Inputs** — the data the decision was based on, as received.
- **The rule that fired** — which condition matched, and its version.
- **The intended action** — what it decided to do.
- **The result** — what actually happened, including refusals and errors.
- **A correlation id** — one identifier tying these together across services.

The gap between intended action and result is where most real defects live. A log
that records only one of the two hides exactly the thing you need, and it hides
it in a way that looks complete.

## Log refusals as loudly as actions

A system that logs successes and stays silent on refusals produces a record in
which nothing ever went wrong. Silence becomes indistinguishable from "never
ran", and a guard that is quietly failing open looks identical to a guard that is
working perfectly.

When a control blocks an action, that is an event with a cause, and it belongs in
the record with the cause attached.

## Retries belong in the record

Retries are normal, because at-least-once delivery is the ordinary case. If a
retried action is not recorded under the same business key as the original, the
log will show two actions where one occurred, and every count derived from it
will be wrong in a direction that looks like success.

## What not to log

Auditability is not a licence to store everything. Secrets, credentials and
personal data do not belong in logs. Record a reference to the thing rather than
the thing itself. "Missing logs are not privacy" and "logs are a fine place for
secrets" are both wrong, and the second is the more expensive of the two.

## Sampling

Under load, sampling keeps logging affordable. Decide deliberately what is never
sampled away: refusals, errors, and anything on a path that moves value. A
failure that was sampled out is a failure you will not find, and you will not
know it is missing.

## Before you move on

Take one action your automation performed recently and reconstruct it end to end
from logs alone — not from memory, and not by re-reading the source. Every
question you cannot answer names a field that is missing.`,

  'builder-preflight-checklist': `# Automation preflight

Preflight is the short, boring list you complete immediately before arming. Its
value comes from being identical every time and from being written down, because
the run you skip it on is the run that needed it.

## The gate

Every line must be true. A line that is "mostly" true is false.

1. **Mandate written** — instruments, actions, hours and maximum position, in one
   paragraph you could hand to someone else.
2. **Limits enforced in code** — maximum position, maximum orders per interval,
   maximum loss before self-halt. Each names the code path that reads it.
3. **Stops tested today** — application halt, process stop and credential
   revocation, each executed against a running instance with elapsed time
   recorded.
4. **Failure paths refuse** — data source unavailable, data source returning
   nonsense, and action refused by the platform each produce a logged refusal
   rather than a guess.
5. **Audit trail complete** — one action reconstructable end to end from logs
   alone.
6. **Credentials scoped to the run** — a paper run carries credentials that
   cannot act on real balances.
7. **Observability live** — you can watch it working now, not read about it
   afterwards.
8. **Rollback named** — the exact steps back to the last known-good state,
   written before you need them.

## Why each line is enforcement, not intention

A limit nobody enforces is a hope with a number attached. The reason line 2 asks
for the code path is that intentions survive refactors and enforcement does not:
the most common way a limit disappears is not deletion but a configuration edit
that stops it being read.

## Paper before live, without exception

A run against the platform's paper market path, with every limit active, comes
before any live run. Paper is where you find out that limit four was never wired
up. Finding that out live costs money to learn something the checklist would have
told you for nothing.

## Re-run it after every change

Preflight expires. Any change to code, configuration, credentials or venue
invalidates it — including changes you are certain are trivial. "It was only
config" is the sentence that precedes most of these stories.

## Keep the record

Write the completed checklist down with a timestamp and a note of what was
running. When something later goes wrong, the first useful question is "what was
true when we armed it", and memory answers that question badly and confidently.

## Before you move on

Complete this checklist for one automation. Every line you cannot honestly tick
is the work remaining before it is armed.`,

  'builder-failure-modes': `# Failure modes of agents

An automation's behaviour when everything works is the easy part. Its behaviour
when something is missing, stale or wrong is what determines whether it is safe
to run at all.

## Fail closed

When a system cannot establish that an action is correct, the default is to not
take it. Failing closed means an outage costs you opportunity. Failing open means
an outage costs you money, and it does so at the moment you have the least
information about what is happening. Choose which mistake you would rather make,
in advance, in code rather than in a comment.

## The modes worth designing for

**Dark data.** The source is unreachable or stale. The correct response is to
refuse and say so. The dangerous response is to continue with the last value it
saw, because stale data looks exactly like fresh data to the code consuming it.
Attach a timestamp to every input and treat "too old" as unavailable.

**Nonsense data.** The source responds, but with something impossible: a missing
field, an absurd magnitude, a value that contradicts the previous one beyond any
plausible change. Validate at the boundary. A value that passes into your logic
unvalidated will be acted on with total confidence.

**Undeclared capability.** The automation attempts an action it was never
granted. Refuse before dispatch, not after. A capability list checked only at the
end is a report, not a control.

**Partial completion.** A multi-step operation succeeded halfway and then failed.
This is the mode that strands things. For every step, know what state the world
is in if the process dies exactly there, and how that state gets reconciled.

**Duplicate delivery.** The same instruction arrives twice, because retries are
normal. Use a business key that a retry reproduces, so the second arrival finds
the first. A fresh random identifier guarantees it will not.

**Clock disagreement.** Two components disagree about the time. Anything driven
by ordering or expiry is affected. Do not assume clocks agree — make the ordering
explicit where it matters.

## Silence is not success

Every refusal is an event with a cause and belongs in the record. A system that
logs only what it did produces a history in which nothing was ever prevented,
making a well-guarded run indistinguishable from a run that never started.

## Degrade honestly

When the automation cannot do its job, the surfaces around it should say so.
Showing an old value without saying it is old, or an invented value in place of a
missing one, converts a visible outage into an invisible wrong answer. The first
is an inconvenience. The second is the one that costs money, because people act
on it.

## Before you move on

For one automation, write what happens in each of the six modes above. Any mode
where the honest answer is "I am not sure" is a live risk rather than a
documentation gap.`,

  // ── sovereign ─────────────────────────────────────────────────────────────

  'sovereign-rail-map': `# Rail map

Before you can reason about risk you have to know who is holding what. A rail map
is a written inventory that answers that question for every balance you have.

## The question, asked precisely

For each balance, answer three things:

1. **Who holds it?** A platform holding it on your behalf, or a wallet whose keys
   only you control.
2. **What does it take to move it?** Your signature alone, a platform approval,
   or both together.
3. **If the holder disappeared right now, what would you have?** A claim you would
   have to make, or an asset you could still move yourself.

The third question separates a balance you own from a balance you are owed. Both
are legitimate positions to hold. Confusing them is not, and the confusion only
ever surfaces at the worst possible time.

## Custodial rails

When a platform holds the asset, your balance is a record in that platform's
book. The upside is operational: recovery paths, netting, and somebody to
investigate when an operation goes wrong.

Obligations follow custody. A platform that holds assets on your behalf, or that
touches regulated payment rails for you, carries verification and jurisdiction
rules as a consequence. That is where limits and tiers come from — they are
downstream of custody, not a policy preference someone chose.

## Self-custody rails

When you hold the keys, no operator can freeze, reverse or lose your position for
you. That is the entire point, and it is also the entire liability: an
irreversible transfer to a wrong destination stays wrong, and there is no support
queue that can undo it. Key management stops being a chore and becomes the asset
itself.

## Draw the map

Write one row per balance: the holder, what it takes to move it, and the recovery
path if something fails mid-move. Include the boring rows. The ones you did not
think were worth writing down are reliably where a surprise is living.

## The failure question

For any transfer that crosses between rails, ask: if this process dies exactly
here, whose funds are stranded and how do they come back? If you cannot answer,
you do not yet understand the rail well enough to use it at size. "Someone will
sort it out" is not an answer; it is the absence of one.

## Before you move on

Complete the map for every balance you currently hold and mark each row custodial
or self-custody. Any row you cannot classify is the next thing to go and learn.`,

  'sovereign-custody-posture': `# Custody posture in one page

Custody posture is a single page you could hand to someone that says, for every
asset you hold, who is holding it and what follows from that. If it takes more
than a page, it is not yet understood.

## Custody is the fact everything else follows from

Almost every rule you meet is downstream of one question: does the platform hold
the asset?

- **It does not.** There is nothing held on your behalf and nothing to freeze.
  Access tends to be permissionless, and responsibility for keys, destinations
  and irreversibility is entirely yours.
- **It does**, or it touches regulated payment rails on your behalf. Now there is
  an obligation to know who the account holder is, and verification tiers, limits
  and jurisdiction rules follow from that obligation rather than from anyone's
  preference.

Neither is superior. They are different trades with different failure modes, and
mixing up which one you are currently in is what produces surprise.

## Write the page

One row per asset, with four columns: what you hold, who holds it, what it takes
to move it, and what you would have if the holder became unavailable.

Fill in every row, including the small balances. Then read the last column on its
own. That column is your actual exposure to operator failure, and it is routinely
larger than people expect once it is written down in one place instead of
distributed across memory.

## What a support process can and cannot do

An operator can correct its own records, investigate an operation on its own
rails, and explain a refusal. It cannot create value that does not exist, and it
cannot reverse a settled transfer on a rail it does not control.

That boundary is also the shape of the most common fraud: someone claiming an
authority no legitimate operator has, in order to get you to act. If a request
depends on an operator doing something operators cannot do, the request is not
coming from one.

## Withdrawal paths are product law

How value leaves is defined by the product and its rails: which routes exist,
what checks they carry, what timing they have. It is not negotiable in a
conversation, and a promise made in a chat window does not create a path the
rails do not have. Read the documented route before you need it, not during.

## Before you move on

Write your one page. Then, for the row that would hurt most to lose, write what
you would actually do in the first hour if its holder became unavailable.`,

  'sovereign-withdrawal-hygiene': `# Withdrawal hygiene

Most withdrawal losses are not sophisticated attacks. They are ordinary mistakes
made quickly, on transfers that cannot be reversed.

## Verify the destination independently

Destination substitution is a well-known class of attack: something between you
and the screen replaces the destination after you copy it. The defence is
independence — confirm the destination through a channel that would not be
compromised by whatever compromised the first one, and check the whole string
rather than the first and last few characters, because matching only the ends is
exactly what the attack is built to defeat.

## Match the network, not just the destination

A destination that looks valid may belong to a different network than the one you
are sending on. Value sent on the wrong network is frequently unrecoverable even
when everything else about the transfer was correct. Confirm the network on both
sides before you confirm the amount.

## Test small, then send

For any destination you have not used before: send a small amount, confirm it
arrives and is credited as expected, and only then send the rest. The test costs
a fee. The alternative costs the balance.

## Urgency is the attack

Nearly every social-engineering script needs you to act before you check: a
closing window, a threat, an account about to be suspended, a helpful stranger
walking you through it step by step. Real operational problems survive a
ten-minute pause.

Treat imposed urgency as the warning sign in itself, independent of how plausible
the story attached to it is. The story is the part they practised.

## Nobody legitimate needs your keys

No support process requires your private keys or recovery phrase. There is no
exception, no verification step and no emergency that changes this. Anyone asking
has ended the conversation for you.

## Build a routine

Same order, every time: destination verified independently, network matched, test
send, confirmation, then the remainder. A routine you always follow is what
protects you on the day you are tired, distracted, or being deliberately rushed —
which is the day it will matter.

## Common mistakes

- Matching only the first and last characters of a destination instead of the whole string.
- Treating imposed urgency as a reason to skip the independent check.

## Before you move on

Write your withdrawal checklist and put it where you will actually see it at the
moment of sending, rather than in a document you would have to remember to open.`,

  'sovereign-limits-and-tiers': `# Limits and verification tiers

A limit that refuses you is doing its job. Understanding where it comes from
makes it predictable rather than arbitrary, and makes obvious why every offer to
bypass one is a bad offer.

## Where limits come from

Limits generally originate in one of three places, and it is worth knowing which
one you have hit:

1. **Obligation** — where an asset is held on your behalf, or a regulated rail is
   touched for you, the operator must establish who the account holder is.
   Verification tiers express how much has been established; limits express what
   each tier permits.
2. **Risk** — the operator carries exposure while a transfer settles or a
   reversal window is open, so that exposure is capped.
3. **Safety** — velocity and threshold caps that limit the damage a compromised
   account can do, including yours.

The first is why "just turn it off for me" is not on the menu. It is not a
setting; it is a condition under which the service may be provided at all.

## Fail closed, by design

When the system cannot establish that an operation is permitted, it refuses. This
is deliberate. The alternative — allow now and correct later — assumes correction
is always possible, and on irreversible rails it is not.

A good refusal tells you which condition was not met and what would change it. A
refusal that only says no is a product defect worth reporting, and the answer is
still no until the condition is met.

## Raising a limit

The only route is the verification path the product owns: supply what the tier
requires through the documented flow, and the tier changes. No conversation mints
a higher limit, because the limit is not the operator's opinion — it is a
consequence of what has been established.

If someone offers to raise your limit outside that flow, they are either unable
to do it or intending something else. Both mean stop.

## Plan around them

Limits are predictable, which makes them constraints to plan with rather than
obstacles to discover in the middle of an operation:

- Know your current tier and what it permits before you need the headroom.
- Complete verification ahead of time rather than during an urgent transfer.
- Remember limits may apply per operation, per period, or both at once.
- Expect a new destination or a new rail to carry extra checks the first time.

## Before you move on

Find your current tier and the limits attached to it, then write down the single
operation you are most likely to attempt that would exceed them. Decide now
whether to complete the next verification step or to plan within the limit.`,

  'sovereign-incident-hygiene': `# Incident hygiene for operators

An incident is a period of low information and high pressure. Hygiene is the set
of habits that stop the response from causing more damage than the incident did.

## Freeze before you fix

When it is not yet clear whether value is affected, stop the flow before you
investigate. A paused operation is recoverable and annoying. An operation that
kept running on a wrong assumption while you investigated has to be unwound
afterwards, and some of it may not be unwindable.

The instinct to keep the service up is right in general and wrong here. Decide
that priority in advance, so that you are not deciding it for the first time at
the worst possible moment.

## Do not guess in writing

Under pressure, an early guess repeated twice becomes established fact and gets
acted on by people who never heard the caveat. Separate three things explicitly
in every message:

- **What is observed** — measurements and log lines.
- **What is inferred** — reasoning from those observations, marked as inference.
- **What is unknown** — the questions still open.

Losing the third category is what turns one incident into two.

## Write both sides of a reconcile finding

When a count does not match, record what was expected, what was found, and the
difference — before doing anything about it. A note that says only "fixed"
destroys the evidence needed to tell whether the cause is still present, and the
same discrepancy will come back with nothing to compare it against.

## Never invent to fill a gap

If a value is unknown, it is unknown. Under time pressure the temptation is to
put in a plausible number so that a process can continue. An hour later that
number is indistinguishable from a measured one, and every conclusion downstream
of it has inherited it. Leave the gap and label it.

## Keep the timeline as you go

Write events with timestamps while they are happening: what was observed, what
was changed, and by whom. Reconstruction afterwards is unreliable, and the
changes made during the response are simultaneously the hardest part to remember
and the most important part to know.

## Communication stays honest and brand-clean

Say what is affected, what is not yet known, and when you will next update. Do
not promise a resolution time you cannot support. Under pressure, copy drifts
toward whatever is reassuring — the standard for user-facing language does not
relax because the situation is stressful.

## Afterwards

Write the sequence, the cause, and the specific change that prevents recurrence.
"Be more careful" is not a change. If the response itself made things worse at
any point, that belongs in the record too; it is usually the most valuable line
in it.

## Before you move on

For one system you operate, write down what you would freeze first and who has
the authority to do it. If the answer requires finding someone, that is the gap.`,

  // ── workbooks ─────────────────────────────────────────────────────────────
  //
  // Drills, not prose. Each drill states a task, a rule that must not be broken,
  // and something checkable afterwards. Simulated execution belongs to the paper
  // market path; where that path is off, a drill stops rather than pretending.

  'markets-tape-reading-workbook': `# Tape reading workbook

A workbook is drills, not reading. Each drill below states a task, a rule you
must not break, and something you can check afterwards to know whether you did
it honestly.

Every drill here is observation or a paper exercise. Nothing moves value.
Simulated execution requires the platform's paper market path to be switched on;
where it is off, the drill stops at observation. That is the honest state, not a
degraded one.

## What the tape is

The tape is the sequence of completed transactions: what traded, how much, and
when. It is a record of what has already happened, and it is distinct from the
resting orders that show what participants are currently willing to do. Reading
one and describing the other is the most common beginner error, so keep the two
columns separate on your sheet.

## Drill 1 — record what is actually there

Watch one instrument for fifteen minutes and record only completed transactions:
time, size, and whether the record carried an aggressor side.

**The rule you must not break:** where the feed does not tell you which side was
the aggressor, write "unknown". Do not infer it from the direction of price.

**Check yourself:** your sheet contains the word "unknown" at least once, or you
can state exactly how this feed marks the aggressor.

## Drill 2 — silence is a reading

Continue with the same instrument through a period in which nothing trades.
Record the gap: when it began and how long it lasted.

**The rule you must not break:** a quiet period is data. Do not fill it with an
interpolated value, and do not treat a still interface as a broken one.

**Check yourself:** you can state the length of the longest gap you recorded.

## Drill 3 — size in context

Return to your Drill 1 sheet and mark the largest transactions. Then answer in
writing: were they large compared with the rest of this session, or only large
compared with your own usual order?

**The rule you must not break:** "large" is relative to the record you collected,
not to a number you remember from somewhere else.

**Check yourself:** your written answer cites rows from your own sheet.

## Drill 4 — a claim and its evidence

Write one sentence describing what participants appeared to be doing, and beneath
it list the specific rows that support it. Then write the strongest case against
your own sentence.

**The rule you must not break:** every claim cites rows. A sentence with no rows
beneath it gets deleted rather than defended.

**Check yourself:** you were able to write the counter-case. If you could not,
the original sentence was probably a story rather than a reading.

## Drill 5 — paper only, where the path is on

Where the platform's paper market path is enabled, repeat Drill 4 and then place
a paper order consistent with your written claim, including the invalidation you
wrote before sending it.

**The rule you must not break:** no live capital, and no order without an
invalidation written first. Where the paper path is off, this drill is skipped
rather than simulated by hand.

**Check yourself:** the invalidation existed in writing before the order did.

## What this workbook deliberately does not do

It does not score you, award progress, or produce fills of its own. Simulated
execution belongs to the platform's paper market path, and certification and any
reward for completing work belong to the certification path. Both are owned
elsewhere and neither is invented here.`,

  'builder-automation-workbook': `# Automation checklist workbook

Drills for the hour before an automation is armed. Each produces a written
artifact; where the artifact does not exist, the item is not done.

Nothing here moves value. Where a drill needs simulated execution it requires the
platform's paper market path to be switched on; where that path is off, the drill
stops at the written artifact rather than pretending to have run.

## Drill 1 — write the mandate

In one paragraph, state what the automation is allowed to do: which instruments,
which actions, which hours, and the largest position it may hold.

**The rule you must not break:** anything not written here is not permitted. A
mandate that says "trade sensibly" permits everything.

**Check yourself:** someone else could read your paragraph and decide whether a
given action was inside it, without asking you.

## Drill 2 — write the limits as numbers

Convert the mandate into hard numbers the code enforces, rather than intentions
you hold: maximum position, maximum orders per interval, maximum loss before it
halts itself.

**The rule you must not break:** each limit names the code path that enforces it.
A limit nothing reads is a hope with a number attached.

**Check yourself:** for every number you can point at the line that reads it.

## Drill 3 — name and test the stop

Write the three stop layers — application halt, process stop, credential
revocation — then execute each against a running instance, recording how long it
took and what remained outstanding.

**The rule you must not break:** an untested stop counts as absent.

**Check yourself:** you hold three measured times, not three intentions.

## Drill 4 — starve it

Run the automation with its data source unavailable, then with the source
returning nonsense, then with an action refused by the platform.

**The rule you must not break:** it must refuse and record the refusal with a
cause. Any path that continues on invented data is a defect to fix before arming,
not a quirk to work around.

**Check yourself:** each refusal appears in the log, and each names why.

## Drill 5 — prove the audit trail

Take one action the automation performed during these drills and reconstruct it
end to end from logs alone: inputs, rule fired, intended action, outcome.

**The rule you must not break:** reconstruct from the log, not from memory and
not by re-reading the source.

**Check yourself:** every question you could not answer names a missing field.

## Drill 6 — paper run, where the path is on

Where the platform's paper market path is enabled, run the automation end to end
against it for a full session with every limit active.

**The rule you must not break:** paper credentials only. Keys able to act on real
balances do not travel with a paper run.

**Check yourself:** you can show which credential the run used, and demonstrate
that it has no permissions against real balances.

## The arming gate

Arm nothing until Drills 1 through 5 have produced their artifacts. A missing
artifact is itself the answer, and the answer is "not yet".`,
};

/**
 * Teaching scaffolding for every item on the spine, keyed by slug.
 *
 * `catalog.ts` refuses to build an item whose slug is missing here, so a new
 * catalog entry cannot ship without the structure a reader needs.
 */
export const CURRICULUM_TEACHING: Readonly<Record<string, CurriculumTeaching>> = {
  // ── day-one spine ─────────────────────────────────────────────────────────

  'foundations-risk-first': {
    objectives: [
      'State the maximum you are willing to lose on an idea before you look at the entry.',
      'Derive position size from an invalidation level rather than from conviction.',
      'Explain why a daily loss limit is a brake rather than a target to reach.',
    ],
    keyTerms: [
      {
        term: 'Capital preservation',
        definition: 'Treating the survival of the account as the constraint every other decision fits inside.',
      },
      { term: 'Drawdown', definition: 'The decline from a previous high in account value, measured over a stated period.' },
      {
        term: 'Guardrail',
        definition: 'A pre-set limit that constrains an action, applied by default rather than recalled under pressure.',
      },
    ],
    selfCheck: [
      'What fraction of the account are you willing to lose on a single idea, and when did you decide it?',
      'If your invalidation level moves twice as far away, what happens to your position size?',
      'Which of your limits is enforced by something other than your own memory?',
    ],
  },

  'foundations-order-types': {
    objectives: [
      'Choose between an order demanding immediacy and one naming a price, and say what you gave up.',
      'Describe what a stop order actually sends when it triggers.',
      'Write an exit level before entry rather than during the trade.',
    ],
    keyTerms: [
      {
        term: 'Immediacy',
        definition: 'Trading now at whatever the book offers, accepting price uncertainty in exchange for certainty of execution.',
      },
      { term: 'Resting order', definition: 'An order waiting at a named price, which may never trade.' },
      { term: 'Trigger level', definition: 'A price at which an order is sent — not a price at which a fill is guaranteed.' },
    ],
    selfCheck: [
      'When is waiting more expensive than crossing the spread?',
      'What does your stop send when it triggers, and where did you confirm that?',
      'Why is rewriting an exit level mid-trade a process failure even when it works out?',
    ],
  },

  'markets-reading-the-book': {
    objectives: [
      'Read past the top of the book before sizing an order.',
      'Explain why a quote is a moment rather than a promise.',
      'Choose a venue on evidence rather than familiarity.',
    ],
    keyTerms: [
      { term: 'Depth', definition: 'The size resting at each price level, which determines what a larger order actually costs.' },
      { term: 'Top of book', definition: 'The best available price on each side, and only the size resting there.' },
      { term: 'Gapping', definition: 'Price moving between levels without trading in between, common where depth is thin.' },
    ],
    selfCheck: [
      'For your usual size, how many levels deep would an immediate order reach?',
      'What does an empty book tell you, and what would an invented number tell you instead?',
      'Which evidence — not habit — decides where you route?',
    ],
  },

  'builder-first-automation': {
    objectives: [
      'Refuse to start an automation that has no named stop.',
      'Treat default guardrails as a starting posture rather than a ceiling to race past.',
      'Run on a paper path before any live capital is involved.',
    ],
    keyTerms: [
      { term: 'Kill-switch', definition: 'A control that stops an automation, operated from a surface you can reach.' },
      { term: 'Paper run', definition: 'A run against a simulated market, with no live capital and no real balances involved.' },
      { term: 'Default limit', definition: 'A constraint applied before you configure anything, so an unconfigured run is still bounded.' },
    ],
    selfCheck: [
      'Name the exact surface from which you would stop your automation right now.',
      'Which of your guardrails did you change from the default, and what justified it?',
      'What has to be true before this automation sees live capital?',
    ],
  },

  'sovereign-self-custody-posture': {
    objectives: [
      'Classify each balance you hold as custodial or self-custody.',
      'Answer the stranded-funds question for any transfer you are about to make.',
      'Recognise that obligations follow custody rather than preference.',
    ],
    keyTerms: [
      { term: 'Custody', definition: 'Who actually holds an asset and can move it, as distinct from who is shown a balance.' },
      { term: 'Stranded funds', definition: 'Value left in an indeterminate state because a process failed part-way through.' },
      { term: 'Multi-rail', definition: 'Holding value across several settlement systems, each with its own rules and failure modes.' },
    ],
    selfCheck: [
      'For your largest balance: who holds it, and what would you have if they became unavailable?',
      'If a transfer you are planning died half-way, whose funds are stranded?',
      'Which of your balances have you never actually classified?',
    ],
  },

  'foundations-paper-workbook': {
    objectives: [
      'Size an entry from an invalidation level rather than from an available balance.',
      'Place and cleanly cancel an order that does not trade.',
      'Respect an exit level that was written before entry.',
    ],
    keyTerms: [
      { term: 'Paper market', definition: 'A simulated market flagged as such by the trade service, where no value moves.' },
      { term: 'Clean cancel', definition: 'An order confirmed as gone from working orders, not merely requested for cancellation.' },
      { term: 'Drill', definition: 'A rehearsed exercise with a rule that must not be broken and a checkable outcome.' },
    ],
    selfCheck: [
      'Did you write the invalidation before the order existed?',
      'Did you confirm the cancel, or only request it?',
      'When the exit level was reached, did you take it without renegotiating?',
    ],
  },

  // ── deepened items ───────────────────────────────────────────────────────

  'foundations-position-sizing': {
    objectives: [
      'Compute a position size from account risk and invalidation distance.',
      'Explain why leverage is a margin setting rather than a risk setting.',
      'Detect the reversed arithmetic of picking a size and then justifying a stop.',
    ],
    keyTerms: [
      { term: 'Account risk', definition: 'The fraction of the account you accept losing on one idea, chosen in advance.' },
      { term: 'Invalidation distance', definition: 'How far price must move against you before the idea is disproved.' },
      {
        term: 'Leverage',
        definition: 'A change to the margin required to hold a position; it does not change the loss if the idea fails.',
      },
    ],
    selfCheck: [
      'Your account risk is a fixed amount and the invalidation distance doubles. What happens to size?',
      'Why is sizing from the account balance rather than the invalidation distance a mistake?',
      'Which costs belong in the cost of being wrong, besides the price move itself?',
    ],
  },

  'foundations-invalidation-first': {
    objectives: [
      'Write a specific, structural invalidation before choosing an entry.',
      'Recognise a time-based invalidation as a legitimate exit condition.',
      'Explain what widening an invalidation mid-trade actually does to the plan.',
    ],
    keyTerms: [
      { term: 'Invalidation', definition: 'The level or condition that proves an idea wrong, written before entry.' },
      { term: 'Structural level', definition: 'A level derived from where your reasoning breaks, not from what you can afford to lose.' },
      { term: 'Noise', definition: 'Ordinary movement that carries no information about your thesis.' },
    ],
    selfCheck: [
      'Is your invalidation checkable by someone who cannot read your mind?',
      'What is the time component of your current idea, and what happens when it expires?',
      'The structural level is further than your budget allows. What are the two acceptable responses?',
    ],
  },

  'foundations-journal-discipline': {
    objectives: [
      'Write a pre-trade entry containing thesis, invalidation, size, exit plan and why now.',
      'Grade a trade on process separately from outcome.',
      'Append corrections rather than overwrite an original thesis.',
    ],
    keyTerms: [
      { term: 'Pre-trade entry', definition: 'The record written before the order, while the outcome is still unknown.' },
      { term: 'Process grade', definition: 'An assessment of whether the plan was followed, independent of whether it profited.' },
      {
        term: 'Retroactive edit',
        definition: 'Changing a past record so that it matches the result — the failure this item exists to prevent.',
      },
    ],
    selfCheck: [
      'Which of the five pre-trade lines do you consistently leave blank?',
      'Name a trade that was well executed and lost. What did you learn from it?',
      'Has your last review changed anything you actually do?',
    ],
  },

  'foundations-fees-are-real': {
    objectives: [
      'List the five cost components of a round trip.',
      'Explain why cost matters more as holding period shortens.',
      'Record an unknown fee as unknown rather than as zero.',
    ],
    keyTerms: [
      { term: 'Round trip', definition: 'The full cost of entering and exiting once, counting both sides.' },
      { term: 'Break-even shift', definition: 'How far the market must move in your favour before costs are recovered.' },
      { term: 'Carry', definition: 'The cost or benefit of holding a position across a period, separate from price movement.' },
    ],
    selfCheck: [
      'Which of the five cost components do you currently not measure at all?',
      'Why does a blank fee field mislead more than an obviously wrong one?',
      'How would doubling your number of round trips change your cost total?',
    ],
  },

  'markets-spread-and-slippage': {
    objectives: [
      'Distinguish spread cost from slippage, and depth slippage from movement slippage.',
      'Explain why a midpoint is a reference rather than a tradeable price.',
      'Choose between splitting an order and accepting immediacy, on the correct grounds.',
    ],
    keyTerms: [
      { term: 'Spread', definition: 'The gap between the best buying and best selling price; the cost of demanding immediacy.' },
      { term: 'Slippage', definition: 'The difference between the price you expected and the price you received.' },
      { term: 'Midpoint', definition: 'A computed average of two sides — a reference, not an offer from anyone.' },
    ],
    selfCheck: [
      'Your fill was worse than expected. Which of the two causes was it, and how do you know?',
      'Which cause does splitting an order address, and which does it not?',
      'What is the honest display when the book is empty?',
    ],
  },

  'markets-order-types-honest': {
    objectives: [
      'State the trade-off every order type makes between certainty of execution and certainty of price.',
      'Distinguish "cancel requested" from "cancelled" and act accordingly.',
      'Refuse to display a working order as a position.',
    ],
    keyTerms: [
      { term: 'Working order', definition: 'An order that is live in the market and has not traded — not a position.' },
      { term: 'Cancel confirmation', definition: 'Acknowledgement that an order has left the book; until then it can still trade.' },
      { term: 'Trigger', definition: 'A level at which an order is sent, whose consequences depend on which order it sends.' },
    ],
    selfCheck: [
      'Which certainty does each of the two basic order types give you, and which does it withhold?',
      'What can happen between requesting a cancel and its confirmation?',
      'Why is showing an unfilled order as filled worse than showing nothing?',
    ],
  },

  'markets-session-structure': {
    objectives: [
      'Ask when a move happened before interpreting what it means.',
      'Adjust expectations for spread and impact according to participation.',
      'Build your own record before adopting a regime label.',
    ],
    keyTerms: [
      { term: 'Participation', definition: 'How many participants are actively quoting and trading at a given time.' },
      { term: 'Session', definition: 'A period of a market day with its own characteristic participation and behaviour.' },
      { term: 'Borrowed conclusion', definition: 'A label adopted from someone else’s market without observations of your own behind it.' },
    ],
    selfCheck: [
      'Why can the same price move mean different things at different hours?',
      'What did your own five-session record show about when spreads were widest?',
      'Which of your current beliefs about "the open" came from your own observations?',
    ],
  },

  'markets-correlation-caution': {
    objectives: [
      'Group open positions by shared driver and size the group as one.',
      'Treat a measured relationship as a description of a stated period.',
      'Require a mechanism before calling a position a hedge.',
    ],
    keyTerms: [
      { term: 'Shared driver', definition: 'The single event or condition that would cause several positions to lose at once.' },
      {
        term: 'Stacking',
        definition: 'Holding one exposure several times under different names, so the total exceeds the intended budget.',
      },
      {
        term: 'Hedge mechanism',
        definition: 'The stated reason one position offsets another, plus the conditions under which it stops working.',
      },
    ],
    selfCheck: [
      'What single event would cause your two largest positions to lose together?',
      'Three positions at 1 percent each share a driver. What is the honest risk figure?',
      'For your current hedge: what is the mechanism, and when does it fail?',
    ],
  },

  'builder-kill-switch-drill': {
    objectives: [
      'Name three independent stop layers for an automation you run.',
      'Decide in advance what "stopped" means for your automation.',
      'Measure and record how long each stop actually takes.',
    ],
    keyTerms: [
      { term: 'Application stop', definition: 'The automation’s own halt path — fastest, and useless if the process is wedged.' },
      { term: 'Credential stop', definition: 'Revoking the keys an automation acts with; works even when the process is beyond reach.' },
      { term: 'Flat', definition: 'Holding no open position — distinct from having merely stopped making decisions.' },
    ],
    selfCheck: [
      'Which of your three layers still works if the host is unreachable?',
      'Does your kill-switch leave open positions alone, cancel resting orders, or close everything?',
      'When did you last measure the elapsed time for each layer?',
    ],
  },

  'builder-logs-not-vibes': {
    objectives: [
      'Record the six fields that make an action reconstructable afterwards.',
      'Log refusals with causes, not only successful actions.',
      'Decide deliberately what is never sampled away.',
    ],
    keyTerms: [
      { term: 'Correlation id', definition: 'One identifier tying the parts of a single operation together across services.' },
      {
        term: 'Business key',
        definition: 'An identifier a retry reproduces, so a duplicate finds the original rather than creating a second record.',
      },
      {
        term: 'Sampling',
        definition: 'Recording a fraction of events to control volume — safe only where the exclusions are chosen deliberately.',
      },
    ],
    selfCheck: [
      'Which two of the six fields would you most likely find missing in your own logs?',
      'Why does a log without refusals look identical to a system that never ran?',
      'What does your sampling policy never drop, and who decided that?',
    ],
  },

  'builder-preflight-checklist': {
    objectives: [
      'Complete an eight-line preflight before arming an automation.',
      'Name the code path enforcing each limit rather than the intention behind it.',
      'Re-run preflight after any change, including configuration.',
    ],
    keyTerms: [
      { term: 'Mandate', definition: 'A written statement of what an automation is permitted to do; anything unwritten is not permitted.' },
      { term: 'Self-halt', definition: 'An automation stopping itself on reaching a pre-set loss, without anyone intervening.' },
      { term: 'Rollback', definition: 'The written steps back to the last known-good state, prepared before they are needed.' },
    ],
    selfCheck: [
      'Which preflight line can you not honestly tick for your current automation?',
      'Why does a configuration edit invalidate preflight as much as a code change?',
      'Where is your completed checklist recorded, with a timestamp?',
    ],
  },

  'builder-failure-modes': {
    objectives: [
      'Design a default that refuses when correctness cannot be established.',
      'Name the six failure modes and your automation’s behaviour in each.',
      'Degrade visibly rather than substituting an invented value.',
    ],
    keyTerms: [
      { term: 'Fail closed', definition: 'Declining to act when the system cannot establish that an action is correct.' },
      { term: 'Stale data', definition: 'A value that arrived earlier and still looks fresh to code that does not check its timestamp.' },
      {
        term: 'Partial completion',
        definition: 'A multi-step operation that succeeded part-way and then failed — the mode that strands things.',
      },
    ],
    selfCheck: [
      'Which failure mode does your automation currently handle worst?',
      'What does your code do with an input whose timestamp is older than expected?',
      'Where would a user see that your system is degraded rather than simply wrong?',
    ],
  },

  'sovereign-rail-map': {
    objectives: [
      'Classify every balance you hold by holder, by what moves it, and by what survives holder failure.',
      'Answer the stranded-funds question before any cross-rail transfer.',
      'Explain why verification requirements follow custody.',
    ],
    keyTerms: [
      { term: 'Rail', definition: 'A settlement system through which value moves, each with its own rules and failure modes.' },
      { term: 'Custodial balance', definition: 'A record in an operator’s book representing value they hold on your behalf.' },
      { term: 'Claim', definition: 'What you hold when an operator holds the asset — a right to receive rather than the asset itself.' },
    ],
    selfCheck: [
      'For each balance you hold: claim, or asset you could still move yourself?',
      'Which rows of your map did you have to guess at?',
      'For your next cross-rail transfer, where exactly could it strand?',
    ],
  },

  'sovereign-custody-posture': {
    objectives: [
      'Write a one-page custody posture covering every asset you hold.',
      'State what an operator can and cannot do, and use that to recognise a fraudulent request.',
      'Read a documented withdrawal route before you need it.',
    ],
    keyTerms: [
      { term: 'Custody posture', definition: 'A single-page statement of who holds each asset and what follows from that.' },
      { term: 'Permissionless', definition: 'Access that requires no account gate because nothing is being held on your behalf.' },
      {
        term: 'Operator authority',
        definition: 'The set of things an operator can actually do — correcting its own records, not creating value.',
      },
    ],
    selfCheck: [
      'Reading only the last column of your page, what is your total exposure to operator failure?',
      'A request requires an operator to reverse a settled transfer on a rail it does not control. What is it?',
      'Where is the documented withdrawal route for your largest balance?',
    ],
  },

  'sovereign-withdrawal-hygiene': {
    objectives: [
      'Verify a destination through an independent channel before sending.',
      'Match the network as deliberately as the destination.',
      'Treat imposed urgency as the warning sign, independent of the story.',
    ],
    keyTerms: [
      { term: 'Destination substitution', definition: 'An attack that replaces a copied destination between the source and your screen.' },
      { term: 'Test send', definition: 'A small first transfer to a new destination, confirmed before the remainder follows.' },
      { term: 'Recovery phrase', definition: 'The secret that reconstructs your keys — never required by any legitimate support process.' },
    ],
    selfCheck: [
      'Why is checking the first and last few characters insufficient?',
      'Which pauses in your routine would a rushed request try to remove?',
      'What is the correct response to any request for your recovery phrase?',
    ],
  },

  'sovereign-limits-and-tiers': {
    objectives: [
      'Identify which of the three sources a limit you have hit comes from.',
      'Explain why fail-closed is the correct default on irreversible rails.',
      'Use the documented verification path rather than seeking a bypass.',
    ],
    keyTerms: [
      {
        term: 'Verification tier',
        definition: 'A level expressing how much has been established about an account holder, which limits follow from.',
      },
      {
        term: 'Fail closed',
        definition: 'Refusing an operation the system cannot establish as permitted, rather than allowing and correcting later.',
      },
      {
        term: 'Velocity cap',
        definition: 'A limit on how much can move within a period, bounding the damage a compromised account can do.',
      },
    ],
    selfCheck: [
      'The last limit that refused you: obligation, risk, or safety?',
      'Why can correction-after-the-fact not substitute for refusal on an irreversible rail?',
      'What does an offer to raise your limit outside the documented flow tell you?',
    ],
  },

  'sovereign-incident-hygiene': {
    objectives: [
      'Freeze an unclear money path before investigating it.',
      'Separate observed, inferred and unknown in every incident message.',
      'Record both sides of a reconcile finding before acting on it.',
    ],
    keyTerms: [
      { term: 'Freeze', definition: 'Stopping a flow while its correctness is unknown, accepting downtime over unwindable damage.' },
      { term: 'Reconcile finding', definition: 'A recorded mismatch between expected and found, kept with the difference intact.' },
      {
        term: 'Incident timeline',
        definition: 'Timestamped events written during the response, including the changes made by responders.',
      },
    ],
    selfCheck: [
      'Which system would you freeze first, and who has authority to do it?',
      'In your last incident write-up, was inference marked as inference?',
      'What is the cost of writing only "fixed" against a discrepancy?',
    ],
  },

  'markets-tape-reading-workbook': {
    objectives: [
      'Record completed transactions without inferring an aggressor side that the feed did not carry.',
      'Treat a period of silence as data rather than as a broken interface.',
      'Support every claim about participant behaviour with rows from your own record.',
    ],
    keyTerms: [
      { term: 'Tape', definition: 'The sequence of completed transactions — what traded, how much, and when.' },
      {
        term: 'Aggressor side',
        definition: 'Which side initiated a transaction, where the feed records it and unknown where it does not.',
      },
      { term: 'Counter-case', definition: 'The strongest argument against your own reading, written before you rely on the reading.' },
    ],
    selfCheck: [
      'How does this feed mark the aggressor side, and what do you write when it does not?',
      'What was the longest quiet period you recorded, and what did you do with it?',
      'Could you write the counter-case to your own Drill 4 claim?',
    ],
  },

  'builder-automation-workbook': {
    objectives: [
      'Produce a written mandate specific enough for someone else to adjudicate.',
      'Demonstrate each limit by pointing at the code path that reads it.',
      'Prove the audit trail by reconstructing a real action from logs alone.',
    ],
    keyTerms: [
      { term: 'Mandate', definition: 'The written statement of permitted actions; anything absent from it is forbidden.' },
      { term: 'Arming gate', definition: 'The rule that no automation starts until every preflight artifact exists.' },
      {
        term: 'Scoped credential',
        definition: 'A credential whose permissions match the run — a paper run carries no authority over real balances.',
      },
    ],
    selfCheck: [
      'Could someone else use your mandate to decide whether an action was permitted?',
      'For each limit, which line of code reads it?',
      'Which fields were missing when you tried to reconstruct an action from logs?',
    ],
  },
};
