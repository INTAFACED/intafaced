# Intafaced app structure

Structure context for agents. Read this before placing a screen, a menu, or a setting.

This file is the structure. It is not a visual design and it does not choose colors. The look stays open. The redesign map on GitHub stays the index and points here.

Older frontend documents do not place rooms. That includes `docs/FRONTEND-EXCHANGE-DESK-SOT-2026-08-25.md`, `docs/FRONTEND-REMAINING-SOT-2026-08-25.md`, `docs/FRONTEND-MASTER-PLAN-WAVE-A-B-2026-07-31.md`, the other `docs/FRONTEND-*` plans, and the files under `docs/styleboard/`. If one of them disagrees with this file about where a room sits, this file wins. Those files may still hold an old layout sketch. They are not the menu.

The finished app is everything in this file, including rooms that have no page yet. A missing page is not a reason to drop the room. The current site is evidence of what already has a URL. It is not the limit.

The first screens to draw are only these three: the shell, the exchange desk, and the Bank overview. Drawing those three does not shrink the finished app. Every other room waits until those three are accepted. It does not wait to be named.

## What is decided, and what is open

Decided here: the doors, which account sees which rooms, Private as a relationship on Personal or Business, the trading desk, the chart's jobs, the view settings, where each current URL sits, and which company or product rule each choice came from.

Open, and not to be invented by an agent:

- Colors, type, and the overall look.
- Which products the look should feel close to. The five companies below were used for structure, not as a taste lock.
- The exact words on an empty screen, beyond the rule that an empty price stays empty.
- Phone layout pixels. The phone uses the same doors. How they are drawn is the shell frame.

## What matters

Read these in this order.

1. The settled structure. Four doors. One ledger. Private is a relationship the team opens. Trade modes are settings on Trade. The chain stays parked until the owner writes GO. An empty price stays empty. A missing page stays in this file. A note here is not permission to build.
2. The room. The screen, the service behind it, why the room exists, and the date that was checked.
3. The audit below. A failed check means stop and fix this file, or bring the line to Nitro.
4. The look stays open. Colors, type, empty-screen wording, and phone pixels are not holes.

## Audit

Checked on 5 October 2026 against `vendor/upstream-exchange/05_Web_Front/src/config/routes.js` at `origin/main` `0a587a3d`. The same file is in this worktree. Parent and child paths are joined. An empty child is the parent address. There are 89 live addresses. A match is the full address on its own. `/pay` is not proved by `/pay/money`. `/uc` is not proved by `/uc/safe`. `/uc/ad` is not proved by `/uc/ad/create`. `/otc/trade/*` is not proved by `/otc/tradeInfo`.

A later agent re-runs that check before placing a screen.

- Open that route file. If `origin/main` has moved, say so. This inventory is current only for that commit.
- Join every parent and child into the full address. The full address has to appear in this file on its own. A shorter piece that hits a longer path is a failed check.
- A live address with no sentence is a gap. Add it to a room this file already has, or bring it to Nitro. A new door is not the fix.
- A service claim is true only when the service file was opened on that pass. Otherwise write unsure. "No service" means the pass looked and did not find one.
- Money moves only through `packages/ledger-client`. A blank price, limit, or sanctions list stays blank.
- `graphify-out` is not part of this file.

The product's own module manifest, `vendor/upstream-exchange/05_Web_Front/src/config/intafaced.js`, was read the same day. It labels bank, support, portfolio, p2p, blueprint, protocol, dex, chain, academy, launch, quant, and execution as partial. It labels pay, market, token, agents, predict, and mining as live. Partial means the surface a person wants can still refuse. That label is the product's own.

Services that are plumbing, not rooms: `svc-edge` is the front door, `svc-ws` is the live connection, `svc-matching` and `svc-matching-rust-stage1` are the matcher, and `svc-fix` is the FIX adapter. The adapter is not a book.

## Why these five

Nitro named the companies. OKX weighs more than the others when they disagree. Strike is the model for a person moving money. Robinhood, Coinbase, and Kraken are the model for a calm home and a professional desk on the same account.

Pages were read from each company's own help, product site, store listing, or official account on 2 October 2026, and read again on 5 October 2026 for rooms this file had not named. A news recap was not used as a source. The live phone apps were not installed. Where a current official page describes the screen, that page is the evidence. Where a page failed, the same article was opened on another address of that company. Rooms that come from Intafaced itself say so. They are not dressed up as a competitor feature. The 5 October read did not add a door. It named statements and tax, a contact list, a scanner, stocks as markets, splitting a bill, money locked for an order or a loan, card rewards, and a request to buy a new listing.

## What a later session can trust

Checked again on 2 October 2026, against the products, not only the first help pass.

- **OKX.** The beginner's guide, updated 15 September 2026, still says the app opens on Home, Trade is a bottom destination, and Assets is the bottom-right corner. Inside Assets, Portfolio shows funding, trading, earn, loan, and pay as buckets of one login. Intafaced keeps earn on Money and pay on Pay, and does not split the ledger into a funding account and a trading account. The US download page calls the same product "The New Money App" and says the portfolio, the watchlist, and orders sync across phone, web, and desktop. A September 2026 article that claimed a Simple / Exchange / Web3 switch is not used. Its cited post was deleted, and OKX's own preferences page says the Lite / Pro switch is gone.
- **Strike.** The live product pages, not the 2023 blog alone, are the source for the three relationships. Individual is one platform: buy, borrow, get paid, pay bills, send. Business is one business account: treasury, borrow, accept payments, pay bills. Private is concierge on that same company: a relationship manager, a large order handled off the public book, limits set per account, and reports. Strike's own account, 29 July 2026, says moving between personal and business is one tap and no logout, on web, Android, and iOS. The Google Play listing updated 22 September 2026 still describes that app: buy and sell, direct deposit, target orders, chart widgets, and borrowing. A different company named Strike Finance ships a perpetuals app. It is not this Strike.
- **Robinhood.** The current help page "Using advanced charts" says the phone chart is opened on the asset, then Advanced. It is not a second app. Indicator sets sync with Legend. Robinhood's own account, 26 June 2026, says price and indicator alerts roll out on Legend and on the phone charts. Robinhood's own newsroom, 29 September 2026, says Social is in the US app and is coming to Legend as a widget. Social stays out of this structure. The same note says foldable phones and tablets get a wider layout of the same app. That is a way to draw the shell, not a new door.
- **Coinbase.** The current send article still says the phone send starts on a Pay tab. Advanced remains a desk on the same account: chart, depth, book, ticket, open orders. The Base app's Home, Social, Trade, and Wallet tabs belong to a different, self-custody app. They are not the Intafaced customer bar. The old Coinbase Pro phone article is stale. Pro was replaced by Advanced. Do not follow it.
- **Kraken.** The app guide updated 3 August 2026 lists the calm phone as Home, Portfolio, Explore, Activity, a plus button to buy, sell, and convert, and a Funded tab for trading with Kraken's money. Account sits in the corner. Funded is not copied. It would be a second pool of money. Kraken Pro's own guide, updated 1 October 2026, is still the widget desk, with Classic and Advanced layouts. The apps page updated 11 August 2026 still lists Kraken, Kraken Pro, Krak, and a separate Kraken Wallet. Intafaced keeps one product. A Kraken blog on 10 July 2026 said a rebuilt consumer app was coming and not yet the documented app. The August pages still describe the tabs above, so that rebuild is not the structure to copy. On-chain tokens inside the Kraken app, announced 18 June 2026, stay out until the owner says the chain starts.

## Words that look alike

Use these meanings. Do not mix them.

- **Business account.** The Strike-style account. A company, its owners, and the merchant desk. A person can hold a Personal account and a Business account and switch without logging out.
- **Business bank.** A tab inside the bank on Money. It is the company's cash accounts. It is not the Business account switch.
- **Launch.** The customer room in More, for issuing and listing an asset.
- **Launch sequence.** The team page that runs a release. Customers never see it.
- **Market.** The catalogue in More, where listings are browsed.
- **A market inside Trade.** One pair on the desk. Picking it updates the chart, the book, and the ticket.
- **Earn.** A bank room on Money. It does not also live in More. OKX puts earning products under Explore. Intafaced keeps them with the balance, because that is where a person looks for yield on money they already hold.
- **Private.** A relationship on a Personal account or a Business account. Same doors, same look, same ledger. A named person at Intafaced for large orders. Not a third account and not a door.
- **Paper.** In this company, the word alone means simulated trading. The practice switch on the desk is called **simulated**. **Paper Design** is the design tool. Sample numbers exist only inside Paper Design, and they are marked as samples.

## Personal and Business

Strike's own signup page says the person chooses a Personal or a Business account. A business also submits the company and each owner. If both accounts are verified, the app switches between them without a logout. Source: Strike, "How do I create an account?"

That is the mode Intafaced uses. It is one product and one look. It is not a fifth door and not a second ledger.

- **Personal** is the default. Money, Trade, Pay as send, receive, and person-to-person, and More.
- **Business** is the company account on the same login. Switching to it reveals the merchant desk inside Pay, and the business-bank tab is the natural landing inside Money for that account.

## Private

Strike Private is the model, and it is part of this structure. Strike's live Private page, read 2 October 2026, calls it concierge for size: a dedicated relationship manager, a large order executed off the public book, limits set per account rather than by a public tier, a custom rate, a person for the loan, and reports an accountant can export. The 5 October 2023 announcement names who it is for: high-net-worth individuals, businesses, family offices, and institutions. They use the same Strike product. Getting in is a conversation, then a relationship manager. It is not a tab. Strike's help center shows the split: everyone else uses the help center, and a private customer writes to their account manager. Strike's published dollar lines are Strike's. This file does not copy a number across. Intafaced does not invent a cutoff.

Private sits on the account the client already has. A person can be Private. A business can be Private. The team opens it. There is no self-serve switch in the tab bar, and there is no fifth door.

What a private client sees, in the same app:

- The same four doors, the same desk, and the same ledger.
- Their account manager in the person menu and in Help. Help for everyone else stays the help center. Help for a private client also shows that person, the way Strike's own help page splits the two.
- A large buy or sell can go through that person as well as through the desk. The price on the screen is the price the desk gave. The screen does not invent one.
- The ordinary caps do not apply to that account. The cap that does apply is the one the team set for that client. A blank cap refuses the order. It does not guess a limit.

What Private does not do:

- It does not open the chain, self-custody, or Lightning. Strike includes those in the private relationship. Intafaced keeps them parked until the owner says the chain starts. A private client can be told that the chain is not open. Private is not a side door into it.
- It does not add a third look, a third app, or a second book of money.
- The team door gains one control: who is private, and who their manager is. Customers never see that list. Checked 5 October 2026. No screen for that list, and no service that records who is private, were found.

## The spine

One product. Four customer doors.

| Door  | Job                                                         | Where the person lands |
| ----- | ----------------------------------------------------------- | ---------------------- |
| Money | What they hold, and the bank behind it                      | Here, after sign-in    |
| Trade | The desk                                                    | One tap from Money     |
| Pay   | Send, receive, person-to-person, and, in Business, get paid | One tap                |
| More  | The rooms that are real and are not daily doors             | One tap                |

Search sits in the bar on every door. It is not a fifth door. The old platform index (`/platform`) is not a customer door. It is a live probe of what each module can do today. The team can open it. Customers find rooms through the four doors and through search.

The phone stacks the same four doors. A later phone item, not a door, is a home-screen price and a pay button. Strike's own widget page lists a price chart, a buy action, and pay-with-cash or pay-with-bitcoin, currently on iPhone. OKX documents a home-screen price widget and a floating position widget. Robinhood's own newsroom, 29 September 2026, says a foldable phone or a tablet may show two panes of the same app. That wider drawing is part of the shell frame. It does not add a door. A social feed on the chart stays out. Robinhood's same newsroom says Social is already in the US app and is coming to the desktop desk as a widget. It was seen. It is not part of this structure.

The public front sits in front of the doors. It is not a fifth product. It holds home (`/`, `/index`), sign-in (`/login`, including `/login/returnUrl/:returnUrl`), create account (`/register`, `/reg`), password recovery (`/findPwd`), help (`/help`, `/helplist`, `/helpdetail`), notices (`/notice`, `/announcement/:id`; `/announcement` redirects to `/notice`), about (`/about-us`), invite (`/invite`), the app download (`/app`), partner (`/partner`), and campaigns (`/lab`, `/lab/detail/:id`, `/bzb`). Campaigns are public activity pages. They are not doors. The campaign list (`/lab`) and `/bzb` say there is no surface behind them. There is no whitepaper route. The old one pointed at a file the repo does not have. Sign-in calls `svc-identity`, including a passkey. An address this file does not name (`*`) says the address is not one of ours. It does not show the home page. Help is up and has no help service behind it. Notices are two things on one page: public announcements have no service, and the personal inbox and price alerts use `svc-notify`.

The person menu is the corner, not a door. The shell is `/uc`. An empty visit shows the same security screen as `/uc/safe`. The account screen is `/uc/account`. It lists named wallets under the same person through `svc-identity`. The screen's own words say that list is a catalogue: no balances, and no ledger posts. Security (`/uc/safe`) already enrolls a passkey through `svc-identity`. Verification, language, and View sit here too. Merchant verification (`/identbusiness`) appears for someone opening a Business account. Promotions sit here too (`/uc/promotion/mycards`, `/uc/promotion/mypromotion`). Those two are the live screens. A promotions address with nothing after it is not a route. Dividend records (`/uc/paydividends`) sit here, as does a beneficiary, who receives the account. Strike's own account, 5 August 2026, shipped that as an account control, not a door. They are not doors.

The team door is separate, same look, never on the customer bar: kill-switches, launch sequence, jurisdiction, ledger, and operator tools. The customer URL `/ops` belongs to this door. It is not a More room. The screen is there. The service is `svc-ops`. It keeps no balances of its own. Warehouse, payroll, and chain custody refuse when they are not set.

## Money

This is the calm screen. OKX calls the matching pages Portfolio and Activity. Strike splits the home into a cash balance and a bitcoin balance. Robinhood's home is one balance and a list of holdings. Coinbase's help puts holdings under My Assets, with an available balance that is the total minus funds on hold.

Intafaced lands on one total. The portfolio page (`/portfolio`) is that holdings screen, not a separate product. The holdings read goes through `svc-ledger`. Under it:

- Each holding. Open one and you get the price, a simple line or candle chart, buy, sell, send, and a repeat buy. The simple chart has an Advanced control that opens the desk on that market. Robinhood's current "Using advanced charts" page is the source: search the asset, then Advanced. It is not a second app. Repeat buy is Strike's recurring buy. A target order, from Strike's current store listing, is a buy or sell that waits for a price. It lives on this holding and on the ticket. Cost basis, what the holding cost against what it is worth now, sits on this holding too. Strike shipped that on the bitcoin chart in August 2025. It is not a door.
- Pending and available, shown apart. Pending can be used to buy. It cannot be sent until it is available. Taken from Strike's own limits page. Coinbase states the same hold in "Understand your available balance." Money locked for an open order or a loan is shown apart from both. Strike calls that reserved. It is the same ledger. No separate screen for it was found on 5 October 2026.
- Deposit, withdraw, addresses, and the record of money moving (`/uc/recharge`, `/uc/withdraw`, `/uc/withdraw/address`, `/uc/record`, `/uc/money`). Deposit, withdraw, and saved addresses are an honest refusal. The screen says custody is not built. There is no custody service behind them.
- Statements and tax, on Money, next to that record. The screen is not built. `svc-ledger` can reproduce a statement when the lots exist, and it refuses when they do not. `svc-tax` exports the tax lots and keeps no balance of its own. A blank tax map refuses. No tax figure is invented. OKX, Coinbase, Kraken, and Strike each document a tax or statement room. This is one room, not a door.
- The bank, behind the balance: overview (`/bank`), spaces (`/bank/spaces`), transfers (`/bank/transfers`), earn (`/bank/earn`), loans (`/bank/loans`), cards (`/bank/cards`), moving between cash and crypto (`/bank/ramps`), spending analytics (`/bank/analytics`), and business bank accounts (`/bank/business`). The service is `svc-bank`. Loans are the borrow room. Strike's individual page and OKX's asset buckets both call this borrow or loan. It stays in the bank. It does not become a door, and it does not also live in More. Repeating transfers already live on the transfers screen. Direct deposit, a paycheck landing in the balance, is a Money action. Strike's individual page and the 22 September 2026 store listing both have it. No screen and no service for that paycheck were found on 5 October 2026. The room stays.
- The whole total can be shown in dollars or in a coin. OKX's preferences page lets the person pick the display currency, including a coin. The number can be hidden.

Cards are a bank room. A real card issuer plugs in later. Until then the screen says the issuer is not connected, and it says the programme is simulated. Rewards on the card wait for that issuer. There is no rewards service before then. Coinbase and Krak document rewards on the card. They are a line on this room, not a door. Moving between cash and crypto (`/bank/ramps`) says the same kind of thing: simulated, no live fiat rail.

There is one ledger. OKX moves funds from a funding account to a trading account. Intafaced does not. A trading view and a spending view are two ways to look at the same ledger. A screen never keeps its own balance.

Deposit and withdraw stay on the route and say they are not built. They do not show a fake form that looks live.

## Trade

One door. The mode is a setting, not a new door. OKX's own trading-settings page is the source: inside Trade you pick Spot, Futures, or Trading bots, and an account mode decides what that screen may do.

The current desk is `/exchange` and `/exchange/:pair`. Open orders and order history are `/uc/entrust/current` and `/uc/entrust/history`. The older account trade list is `/uc/trade`. They belong to this door. The service behind the desk is `svc-trade`.

Modes and tools, for the finished app, including ones that have no page yet:

- Spot. A new person stays here.
- Margin. On OKX it is a switch on the spot ticket, cross or isolated. Same here. A margin section is on the desk when the market is a perpetual. Whether the spot ticket itself has that switch was not confirmed on 5 October 2026.
- Futures, perpetual and dated. Not built as its own page yet. It is still a mode of this door. A perpetual mode is on the desk, and `svc-trade` has a futures policy. How much of a futures order can be placed was not proved on 5 October 2026.
- Options. Not built as its own page yet. Same door. The chain is the options surface, under the chart, when options exist. On 5 October 2026 the desk mode said that chain is unavailable. `svc-trade` has an options policy and no chain on the screen.
- Convert. An action on the holding and on the ticket, and a mode on the current desk. It is not a door. Asking for a quote calls `svc-trade`. Execute does not send that quote back. The screen is partly wired.
- Copy. A mode of this door, and also listed in More so it can be found. This one comes from Intafaced's own product, not from a help page of the five companies. The follow action calls `svc-trade`. A blank rule refuses it. OKX's copy mode that was read sits on the self-custody DEX, which stays parked. Copy stays off that chain.
- Bots. A mode of this door, reachable from the ticket, and listed in More. OKX puts Trading bots inside Trade. No bots screen and no separate bots service were found on 5 October 2026. Quant is a different room. When bots exist, their money stays on the one ledger. OKX isolates bot funds in their own pot. Intafaced does not.
- Stocks. Markets on this door, not a second brokerage account and not a door. Coinbase, Kraken, and OKX document stock or stock-token trading, often as another account. No stocks screen and no separate stocks service were found on 5 October 2026.
- A scanner. A widget of this desk, not a door. Robinhood Legend has one. OKX has rankings on Home. No scanner screen and no scanner service were found on 5 October 2026.
- Execution (`/execution`). Cross-venue execution. It lives in this door, next to bots. Quant can open it. It is not a customer door. The service is `svc-execution`.
- The quote desk (`/otc`, `/otc/trade/*`, `/otc/tradeInfo`). Opening `/otc` sends the person to the trade screen. That screen reads offers from `svc-p2p`. There is no separate quote-desk service. A person asks for a price instead of taking the book. It is part of Trade. The counterparty check (`/checkuser`) and the order chat (`/chat`) belong to that quote, and also to a person-to-person trade in Pay. They are not doors.

A position mode, taken from OKX, applies once futures exist: one-way, or hedge (a long and a short at the same time). Switching account mode changes what Trade shows. It does not change the doors.

**Simulated** is a switch on this desk. It is clearly marked. It cannot move ledger money. It is not a door, and it is not Paper Design. The switch was not on the desk's mode row on 5 October 2026. The room stays. OKX's demo mode is a separate practice balance. This switch is not that.

### The desk

Coinbase Advanced, Kraken Pro, Robinhood Legend, and OKX describe the same desk. The chart is the largest piece. Around it:

- The order ticket.
- The book, buys on one side and sells on the other, and depth.
- Recent trades.
- Open orders, positions, and the balance that can be used.
- Favorites. Picking a market updates the chart, the book, and the ticket together. Robinhood calls this linking widgets. OKX calls the list Favourites.
- A scanner, as named with the modes above. The other Legend widgets, a snapshot, positions, a watchlist, recent orders, and an account summary, are this same desk.
- Alerts. Robinhood's own account, 26 June 2026, says price and indicator alerts exist on the desktop desk and on the phone charts. The phone chart has them too. The inbox and the alert list use `svc-notify`, on the notices page.

Layouts are saved. Kraken ships Classic and Advanced presets and lets the person drag panels, with up to four charts. OKX allows up to ten chart workspaces and can hide the order panel so the chart fills the screen. Robinhood Legend allows several layouts and templates, and up to eight charts. The first frame Intafaced draws is one chart. The finished desktop can hold several charts and more than one saved layout. The competitor counts are what those products ship. They are not a cap on Intafaced.

The phone uses the same market, the same drawings, and the same indicator set. The stack is chart, then ticket, then book. Landscape and full screen belong to the desk. OKX also lets the chart sit at the top, the bottom, or be hidden. That choice is a view setting.

### The ticket

Order types taken from Coinbase Advanced's own order-type page, OKX, and Kraken:

- Market, limit, stop, and stop-limit.
- A target and a stop attached to the order. Coinbase calls the pair a bracket when it is placed on a position that already exists.
- Post only, reduce only, and time in force: good till canceled, immediate or cancel, fill or kill.
- A large order split over time. Coinbase calls this TWAP.
- On futures, reverse the position. OKX requires the button and a confirmation before it appears. Intafaced does the same.
- Size in coin, contracts, or the quote currency.
- The fee before the order is sent.
- The last choices can stay on that device. Coinbase calls these sticky settings. They do not have to sync across devices.

If there is no price, the ticket refuses. It does not invent one. A hotkey may send on desktop. Kraken documents Ctrl+Enter and Cmd+Return. The warning before send, and the warning before cancel, can each be turned off.

### The chart

The chart has jobs. The engine is a separate rule, stated at the end of this section.

Jobs, for the finished desk:

- Type: line, candlestick, and Heikin Ashi. Robinhood Legend names those types. More types can be added later. This list is the start, not a ceiling.
- Interval: from one minute through a month. OKX's candlestick page also includes a time chart and landscape.
- Indicators, and a saved set the person can apply again. The starter set is moving average, volume, VWAP, RSI, MACD, and Bollinger. Coinbase says its TradingView chart has many more. The desk can hold more sets. An agent does not invent a list of a hundred indicators in the first frame, and does not refuse a set later because it was not in the starter list.
- Drawings: a trendline, a level, and the shapes OKX names (rectangle and the rest). Drawings and indicator sets sync between phone and desktop. OKX syncs drawings and says candle colors do not sync. Intafaced syncs the up-and-down color as well, because it is an account setting, not a per-device scribble.
- Compare a second market on the same chart.
- A countdown on the current candle. Optional news marks. Each can be hidden.
- Open orders, the position, the stop, and, on futures, the liquidation price, drawn on the chart and draggable. OKX's candlestick page lists open orders, historical orders, and drag-to-modify. Kraken's derivatives guide lists open orders, position, mark, and liquidation on the chart.
- A press on the chart or on a price ladder starts an order. Robinhood Legend and Kraken Desktop both do this. The ladder is a widget of the desk, not a door.
- Options, when they exist, use a chain: calls on one side, puts on the other, the strike in the middle. Robinhood's own options-chain article is the source. OKX's candlestick page says options do not use that candle chart. The chain is the options surface. It still lives inside Trade.

The engine rule: the chart already in the product is the one that ships now. A licensed TradingView chart is allowed only after the owner has access. A copied TradingView does not go into the public repository. OKX and Coinbase let a person use TradingView from inside the chart settings. The choice can exist in the product. The copy cannot.

A missing price leaves the chart empty.

### View

One View section, opened from the person menu or from the desk. These settings change the screen. They are not doors.

- Light, dark, or match the phone. OKX and Kraken both offer this. The choice of brand color is not this setting and is not made in this file.
- Which color means up. Green up and red down is the default. The person can reverse it. OKX's candlestick page is the source. The choice follows the account onto every screen.
- Where the daily candle starts: a 24-hour clock, or a chosen time zone. OKX offers UTC, UTC+8, and 24-hour.
- Language. The product already has it. OKX puts it in preferences. It lives here.
- Where the chart sits on the phone: top, bottom, or hidden.
- What the chart draws: open orders, position, stop, liquidation, old fills, news. Each can be off.
- Confirm before send. Confirm before cancel. Futures also have a cooling-off switch that blocks new futures trades for a chosen time. OKX documents that switch.
- Display currency for the whole total. Hide the number. Hide small balances. Favorites as a list or as cards. Kraken documents the last two.
- Pending and available, as above.

## Pay

Personal Pay is how a person moves money, taken from Strike, plus the person-to-person market the product already has. The Pay landing is `/pay`. The screen is there. The service is `svc-pay`.

- Send to a name, and request. Coinbase's own send article also lets a person pay from a Pay tab by contact or address. Same job. A saved contact list sits inside send. Coinbase and Strike document it. No contact-list screen and no service for it were found on 5 October 2026.
- Receive, and choose whether it stays in the asset or converts.
- Split a bill, inside Pay, from an activity line or from receive. Krak documents it. No screen and no service were found on 5 October 2026. It is not a door.
- Person-to-person (`/p2p`). Offers, orders, and the chat on an order. The person's own offer list is `/uc/ad`. Creating or editing an offer is `/uc/ad/create` and `/uc/ad/update`. That person's order list is `/uc/order`. `/ctc` redirects to `/p2p`. It is the same room, not a second product. A Personal account sees this. It is not hidden behind Business. The service is `svc-p2p`.
- Bill pay, and sending to a bank account abroad. Strike's limits page lists both. They are rooms inside Pay for the finished app. They are not built yet. No screen and no service were found on 5 October 2026. They are not doors. They are not optional extras to be dropped because the page is missing.
- Lightning and on-chain receive are the chain. They stay out of the menu until the owner says the chain starts. The structure has a place for them inside Pay. The product does not build them in the first build. The place stays reserved so a later agent does not invent a new door for them.

Business Pay is the merchant desk. It appears only in the Business account.

- The merchant's own balance (`/pay/money`). Personal holdings stay on Money.
- Links (`/pay/links`), checkout (`/pay/checkout`), payments (`/pay/payments`), customers, payouts, settlements (`/pay/settlements`), and disputes.
- The merchant home (`/pay/merchant`), sub-merchants (`/pay/network`), and permissions (`/pay/permissions`). These routes exist today.
- Invoices and subscriptions. Not built as their own pages yet. They still belong here. The business-bank screen can issue a hosted pay link and calls that an invoice. That link uses the pay service. It is not a second book. Subscriptions have a service inside `svc-pay` and no customer page. Strike Business is the reason a business can run payments. The product plan already includes billing.
- Reports. Strike Business's own announcement says a business can export activity for accounting.
- A developer test mode: keys and webhooks that cannot move live money. Strike's business signup page says the API is an extra verification, not a separate app.

A person who is not on a Business account never sees the merchant list. They still see send, receive, and person-to-person.

## More

Rooms that are real and are not on the main bar. OKX puts the longer list under Explore, reached from the bottom of the app, not from the trade ticket. Same idea here.

- Academy (`/academy`). The page is there. The service is `svc-academy`. An old comment in the route file still says this room has no service. That comment is stale.
- Agents (`/agents`). The service is `svc-agents`. An agent does not get its own trading balance. Robinhood's trading agent uses a separate pot. This room stays on the one ledger.
- Quant, including the studio (`/quant/studio`) and backtest (`/quant/backtest`). The sandbox entry is `/quant`. The service is `svc-quant`. This is not the bots room.
- Launch (`/launch`). Innovation orders (`/uc/innovation/myorders`) belong to this room. The page asks `svc-protocol` for launch status. The chain stays parked until the owner writes GO. Launch is not a side door into it.
- Market, the catalogue (`/market`) and the person's own listings (`/market/mine`). The service is `svc-market`. A person can also ask to buy a new listing as it opens. Robinhood's own help calls that IPO Access. The screen is not built. Whether the service is the catalogue or Launch was not settled on 5 October 2026. It is a line on this room, not a door, and it is not the issuing side. The issuing side is Launch.
- Prediction markets (`/predict`). The service is `svc-trade`. An empty list stays empty.
- Mining (`/mining`), including the invite list (`/uc/invitingmining`). The service is `svc-mining-pool`.
- Token (`/token`). This is the token room. It is not the display-currency setting in View. The service is `svc-token`.
- Blueprint (`/blueprint`). The service is `svc-blueprint`.
- Support (`/support`). The service is `svc-support`.
- Copy and bots, also inside Trade.
- Campaigns that are signed-in activity rather than the public front. The public campaign URLs are listed with the front door.

## What Intafaced has that those five do not

These stay. They are not dropped because a competitor has no room with that name, and they are not dropped because the page is thin.

- One ledger. No funding account and no trading account. Views only.
- The bank behind Money: spaces, loans, cards, ramps, analytics, business bank accounts.
- The team door: kill-switches, launch sequence, jurisdiction, ledger, operator tools, and `/ops`.
- Jurisdiction as a real constraint. A missing tier says so. It does not invent a permission.
- Honest empty. A missing price, a missing balance, an unbuilt custody screen, and an unconnected card issuer say what is missing. A banner does not make a made-up number allowed.
- The parked chain. The decentralized exchange (`/dex`, service `svc-dex`), the protocol (`/protocol`, service `svc-protocol`), and the chain (`/chain`, service `svc-indexer`), including self-custody, can keep their URLs and stay out of the menu until the owner says that work starts. The pages are there. The module's own label for each is partial. They are not customer doors.
- Academy, agents, blueprint, quant, launch, mining, prediction markets, token, execution, and the market catalogue.

## Left out, and why

- Kraken's three apps, and Kraken Funded. One product. The simple app is Money plus a simple chart. Pro is Trade. Krak's job, paying a person, is Pay. Funded, trading with the house's money, is not a door and not a second pool.
- OKX's old switch between a Lite app and a Pro app. OKX's own preferences page says the current app no longer has it.
- OKX Wallet, DEX trader mode, and on-chain stock tokens. Those are the self-custody and chain surface. The URLs can exist. They are not customer doors until the chain starts.
- Strike Private as a fifth door or a third account. It is a relationship on Personal or Business, specified above.
- A social feed on the chart.
- A second chart product on the phone.
- A copied TradingView in the public repository.
- Brand colors, type, and a taste lock. Not this file.
- Two books of money.
- A customer door named Platform. Search and the four doors replace that index.
- A whitepaper page. There is no paper to serve.
- Seen on 5 October 2026 and left here: a second banking app, child or joint accounts, a membership plan, a rewards tier, Krak Salary Match, a tax-filing concierge with a published cutoff, Breakout, NinjaTrader, and Kraken Prop. Private already has the manager. The cutoff is not copied. Prop and evaluation trading are another pot of money.

## First build

Draw only the shell with these four doors, the exchange desk, and the Bank overview. The merchant desk, the extra trade modes, More, and the team frames come after those three are accepted. Naming them here is what makes the later build possible. It is not permission to build them in the first pass.

## Sources

Read 2 October 2026, from the companies themselves, and read again on 5 October 2026 for rooms this file had not named. Intafaced routes were read from `vendor/upstream-exchange/05_Web_Front/src/config/routes.js` on `origin/main` at `0a587a3d`. The route check joined parent and child and matched each full address.

- Robinhood, "How to sign up for IPO Access" and "About IPO Access," read 5 October 2026: a person asks to buy shares as a company goes public. `https://robinhood.com/us/en/support/articles/how-to-sign-up-for-ipo-access/` and `https://robinhood.com/us/en/support/articles/ipo-access/`
- Robinhood, "Concierge Tax and Estate Services," read 5 October 2026: a dated pilot with a cutoff. Not adopted. `https://robinhood.com/us/en/support/articles/concierge-tax-estate/`
- Krak, "Split a bill on Krak," updated 30 June 2026. `https://support.krak.app/articles/krak-split-bill`

- OKX, "How do I set up the commonly used transaction features?": account mode, position mode, interface, up and down colors, chart position, cooling-off. `https://www.okx.com/help/trading-settings-faq`
- OKX, "How do I use and adjust the candlestick chart?": chart settings, trading display, order book, drawings, TradingView as a chart display, options charts unsupported. `https://www.okx.com/help/candlestick-faqs-and-settings`
- OKX, "How do I use the chart trading layout?": up to ten workspaces, hide the order panel, chart position on the app. `https://www.okx.com/help/how-do-i-use-the-chart-trading-layout`
- OKX, "How do I set my preferences?": theme, display currency, language, liquidation price, and the note that Lite and Pro can no longer be switched. `https://www.okx.com/en-us/help/preferences-faq`
- OKX, "Getting started with Simple Earn": Explore, then Grow, for earn products. Intafaced keeps earn on Money. `https://www.okx.com/help/getting-started-with-coins`
- OKX, "How do I conduct spot trading?": Trade, then Spot, funding account to trading account. The transfer is theirs. Intafaced does not copy it. `https://www.okx.com/help/cryptocurrency-trading-app-web`
- Strike, "How do I create an account?": Personal or Business, switch without logout. `https://strike.me/support/how-do-i-create-an-account/`
- Strike, "What are my transaction limits?": personal and business limits, pending unavailable to send, Bill Pay, Send Globally, Strike Private for large orders. `https://strike.me/faq/what-are-my-limits/`
- Strike, "Announcing Strike Private" (5 October 2023): white-glove service, not an in-app mode. `https://strike.me/blog/announcing-strike-private/`
- Strike, "Announcing Strike Business" (14 March 2024): same money actions as a person, plus reports and developer access. `https://strike.me/blog/announcing-strike-business/`
- Coinbase Help, "Coinbase vs Coinbase Advanced": simple account versus the desk on the same account. `https://help.coinbase.com/en/getting-started/other/coinbase-vs-coinbase-advanced`
- Coinbase Help, "Coinbase Advanced dashboard overview": chart, depth, book, ticket, open orders, sticky settings. `https://help.coinbase.com/en/coinbase/trading-and-funding/advanced-trade/dashboard-overview`
- Coinbase Help, "Understanding the order types": market, limit, stop, bracket, attached target and stop, TWAP. `https://help.coinbase.com/en/coinbase/trading-and-funding/advanced-trade/order-types`
- Coinbase Help, "Steps to send crypto": the Pay tab, send by contact or address. `https://help.coinbase.com/en/coinbase/trading-and-funding/cryptocurrency-trading-pairs/how-to-send-and-receive-cryptocurrency.html`
- Coinbase Help, "Understand your available balance": available is total minus holds. `https://help.coinbase.com/customer/portal/articles/1403838-money-left-my-bank-account-where-is-my-bitcoin`
- Kraken Support, "Which Kraken platform is best for me?" (1 October 2026): Kraken, Kraken Pro, and Krak, one login, an app switcher. `https://support.kraken.com/articles/14984895395092-which-kraken-platform-is-best-for-me-`
- Kraken Support, "Kraken Pro trading interface guide" (1 October 2026): widgets, Classic and Advanced, light and dark, up to four charts. `https://support.kraken.com/articles/kraken-pro-trading-interface-guide`
- Kraken Support, "Trading Widgets on Kraken Pro": hide small balances, cancel confirmation, favorites as cards, orders on the chart. `https://support.kraken.com/articles/trade-widget-settings`
- Kraken Support, "How to trade on Kraken Desktop" (1 October 2026): order from the chart. `https://support.kraken.com/articles/how-to-trade-on-kraken-desktop`
- Robinhood, "Trading with Robinhood Legend": trade from the chart, the ladder, and the options chain, hotkeys. `https://robinhood.com/us/en/support/articles/trading-with-robinhood-legend/`
- Robinhood, "Layouts on Legend": saved layouts and templates. `https://robinhood.com/us/en/support/articles/layouts-on-legend/`
- Robinhood, "Widgets in Robinhood Legend": chart, indicators, drawings, ladder, options chain. `https://robinhood.com/us/en/support/articles/widgets-in-robinhood-legend/`
- Robinhood, "Options chain": calls one side, puts the other, strike in the middle. `https://robinhood.com/us/en/support/articles/options-chain/`
- Robinhood newsroom, "Introducing Robinhood Legend Charts on Mobile" (17 June 2025): the phone chart matches the desktop, including drawings. `https://robinhood.com/us/en/newsroom/introducing-robinhood-legend-charts-on-mobile/`
- Robinhood, "Using advanced charts": on the phone, open the asset, then Advanced. Indicator sets sync with Legend. `https://robinhood.com/us/en/support/articles/using-advanced-charts/`
- Robinhood newsroom, "HOOD Summit 2026" (29 September 2026): Social in the US app, a Legend widget coming, foldable and tablet layouts of the same app. Social is not adopted. `https://robinhood.com/us/en/newsroom/hood-summit-2026`
- Robinhood's own account, 26 June 2026: price and indicator alerts on Legend and on the phone charts.
- OKX, "OKX Beginner's Guide," updated 15 September 2026: Home, Trade, Assets, and the portfolio buckets. `https://www.okx.com/help/okx-beginners-guide`
- OKX US download page, read 2 October 2026: one account across phone, web, and desktop. `https://www.okx.com/en-us/download`
- Strike, "Private," read 2 October 2026: relationship manager, size execution, limits per account, reports. `https://strike.me/private`
- Strike, "Individual" and "Business," read 2 October 2026. `https://strike.me/individual` and `https://strike.me/business`
- Strike's own account, 29 July 2026: personal and business switch in one tap, no logout, on web, Android, and iOS.
- Strike, "How do I add price or payment widgets": iPhone widgets for price, buy, and pay. `https://strike.me/faq/how-do-i-add-price-or-payment-widgets-to-my-home-or-lock-screen`
- Google Play, "STRIKE: Buy & Hold Bitcoin," updated 22 September 2026. Not Strike Finance.
- Kraken Support, "Navigating the Kraken app," updated 3 August 2026. `https://support.kraken.com/articles/360059154531-navigating-the-kraken-app`
- Kraken Support, "Kraken's official mobile apps," updated 11 August 2026. `https://support.kraken.com/articles/360001332083-kraken-s-official-mobile-apps`
- Kraken Blog, "Coming soon: bringing Kraken to life," 10 July 2026: a rebuilt consumer app announced, not the documented tabs. `https://blog.kraken.com/news/new-kraken-app-coming-soon`
- Kraken Blog, "On-chain token trading is now built into the Kraken app," 18 June 2026. Not adopted while the chain is parked.
