//import membercenter from '../pages/uc/MemberCenter'
//import tradeInfo from '../pages/otc/TradeInfo'
//import checkuser from '../pages/otc/CheckUser'
//import chat from '../pages/otc/Chat'
//import notice from '../pages/cms/Notice'
//import noticeitem from '../pages/cms/NoticeItem'

// import aboutus from '../pages/cms/AboutUs' /**/
//import moneyindex from '../components/uc/MoneyIndex'
//import record from '../components/uc/Record'
//import trade from '../components/uc/MinTrade'
//import paydividends from '../components/uc/PayDividends'
//import invitingmining from '../components/uc/InvitingMin'
//import recharge from '../components/uc/Recharge'
//import withdraw from '../components/uc/Withdraw'
//import safe from '../components/uc/Safe'
//import account from '../components/uc/Account'
//import withdrawAddr from '../components/uc/WithdrawAddress'

//import Index from '../pages/index/Index'
//import Login from '../pages/uc/Login'
//import Register from '../pages/uc/Register'
//import FindPwd from '../pages/uc/FindPwd'
//import Exchange from '../pages/exchange/Exchange'
//import Help from '../pages/cms/Help'
// import HelpList from '../pages/cms/HelpList' //
// import HelpDetail from '../pages/cms/HelpDetail' //
//import OTCMain from '../pages/otc/Main'
//import OtcTrade from '../pages/otc/Trade'
//import OtcOrder from '../components/uc/myorder'
// import EntrustCurrent from '../components/uc/EntrustCurrent' //Open Orders
// import EntrustHistory from '../components/uc/EntrustHistory' //Order History
//import OtcAd from '../components/otc/MyAd'
//import adPublish from '../pages/otc/AdPublish'
//import identbusiness from '../pages/uc/IdentBusiness'

//import Partner from '../pages/activity/Partner'
//import Bzb from '../pages/activity/Bzb'

// ── HOW TO READ THIS FILE ────────────────────────────────────────────────────
//
// Two things about it are load-bearing and neither is obvious.
//
// 1. THE COMPONENT PATH IS CASE-SENSITIVE IN THE BUILD, AND NOT ON THIS DESK.
//    `require(["../pages/uc/login"])` finds `Login.vue` on Windows and macOS and
//    finds nothing in the Linux build container, where it is a hard
//    `Module not found` and the whole bundle fails. Six paths here were wrong in
//    exactly that way. Match the filename character for character.
//
// 2. `requiresAuth` IS THE ONLY AUTH GATE. It is read by the global
//    `router.beforeEach` in ../main.js, which sends a signed-out visitor to
//    /login with a `redirect` back to where they were going. Before that guard
//    existed, each screen policed itself in `created()` — so the component
//    mounted, painted an empty logged-out shell, fired a request that 401'd, and
//    only then bounced. Screens that forgot to police themselves (/chat,
//    /checkuser, /identbusiness, the whole OTC desk) simply rendered blank.
//    A route that needs a session says so HERE, once.

var intakeRoutes = require('../assets/js/outreach-intake.js');
function publicJourney(resolve, fallback) {
    if (typeof window !== 'undefined' && intakeRoutes.isJoinHost(window.location.hostname)) require(["../pages/intafaced/Outreach"], resolve);
    else fallback(resolve);
}

export default [
    { path: '/join', component: resolve=>(require(["../pages/intafaced/Outreach"],resolve)) },
    { path: '/join/:journey(invest|trade|merchant|academy|partner)', component: resolve=>(require(["../pages/intafaced/Outreach"],resolve)) },
    { path: '/invest', component: resolve=>(require(["../pages/intafaced/Outreach"],resolve)) },
    { path: '/trade', component: resolve=>(require(["../pages/intafaced/Outreach"],resolve)) },
    { path: '/merchant', component: resolve=>(require(["../pages/intafaced/Outreach"],resolve)) },
    { path: '/', component: resolve=>publicJourney(resolve, r=>require(["../pages/index/Index"],r)) },
    { path: '/index', component: resolve=>(require(["../pages/index/Index"],resolve)) },
    { path: '/login', component: resolve=>(require(["../pages/uc/Login"],resolve)) },
    { path: '/login/returnUrl/:returnUrl', component: resolve=>(require(["../pages/uc/Login"],resolve)) },
    { path: '/register', component: resolve=>(require(["../pages/uc/Register"],resolve)) },
    { path: '/reg', component: resolve=>(require(["../pages/uc/MobileRegister"],resolve)) },
    { path: '/app', component: resolve=>(require(["../pages/uc/AppDownload"],resolve)) },
    { path: '/findPwd', component: resolve=>(require(["../pages/uc/FindPwd"],resolve)) },
    { path: '/exchange', component: resolve=>(require(["../pages/exchange/Exchange"],resolve)) },
    { path: '/exchange/:pair', component: resolve=>(require(["../pages/exchange/Exchange"],resolve)), name: "ExchangePair"},
    { path: '/predict', component: resolve=>(require(["../pages/intafaced/Predict"],resolve)) },
    { path: '/mining', component: resolve=>(require(["../pages/intafaced/Mining"],resolve)) },
    { path: '/help', component: resolve=>(require(["../pages/cms/Help"],resolve)) },
    { path: '/helplist', component: resolve=>(require(["../pages/cms/HelpList"],resolve)) },
    { path: '/helpdetail', component: resolve=>(require(["../pages/cms/HelpDetail"],resolve)) },
    { path: '/notice', component: resolve=>(require(["../pages/cms/Notice"],resolve)) },
    { path: '/announcement', redirect: '/notice' },
    { path: '/invite', component: resolve=>(require(["../pages/invite/Invite"],resolve)) },
    { path: '/lab', component: resolve=>(require(["../pages/activity/Activity"],resolve)) },
    // C2C and P2P are one operating surface. Keep the legacy inbound URL, but
    // resolve it in one hop instead of mounting the retired standalone essay.
    { path: '/ctc', redirect: '/p2p' },
    { path: '/lab/detail/:id', component: resolve=>(require(["../pages/activity/ActivityDetail"],resolve)) },
    { path: '/announcement/:id', component: resolve=>(require(["../pages/cms/NoticeItem"],resolve)), name: "NoticeDetail" },
    { path: '/partner', component: resolve=>publicJourney(resolve, r=>require(["../pages/activity/Partner"],r)) },
    { path: '/bzb', component: resolve=>(require(["../pages/activity/Bzb"],resolve)) },
    // `/whitepaper` is deliberately absent. It rendered `<embed>` of
    // /static/INTAFACEDWhitePaperVer 1.0.pdf and linked a raw.githubusercontent
    // URL; there is no `static/` directory in this tree, so both 404 and the
    // page was a grey box under a header nav item. There is no whitepaper to
    // serve, so there is no route — see the header in ../App.vue.

    // ── INTAFACED platform ────────────────────────────────────────────────────
    // The Sovereign OS modules, embedded in this shell rather than served as a
    // second app on a second port. Every one of them reads through svc-edge
    // (see ../config/intafaced.js); none of them talks to a service directly.
    //
    // /platform is the hub: it holds the svc-identity session the scoped
    // modules need and reports, from a live probe, what each one can do today.
    { path: '/platform', component: resolve=>(require(["../pages/intafaced/Platform"],resolve)) },
    // ── The two deep verticals ────────────────────────────────────────────
    //
    // /bank and /pay are NOT one screen each. svc-bank has eight routers and
    // svc-pay six, and a single flat page per service could reach about a
    // fifth of either. Each row below is one router's surface; the tab strip
    // that links them is generated from ../config/ix-nav.js, so a route added
    // here without a nav row (or the reverse) is visible immediately rather
    // than becoming an orphan page nobody can navigate to.
    //
    // They are FLAT, not nested children. A parent /bank component wrapping a
    // <router-view> would re-mount and re-fetch the overview's three reads on
    // every tab change, and the overview is the one screen none of the others
    // needs. Each row is its own page with its own reads.
    { path: '/bank', component: resolve=>(require(["../pages/intafaced/Bank"],resolve)) },
    { path: '/bank/spaces', component: resolve=>(require(["../pages/intafaced/bank/Spaces"],resolve)) },
    { path: '/bank/transfers', component: resolve=>(require(["../pages/intafaced/bank/Transfers"],resolve)) },
    { path: '/bank/earn', component: resolve=>(require(["../pages/intafaced/bank/Earn"],resolve)) },
    { path: '/bank/loans', component: resolve=>(require(["../pages/intafaced/bank/Loans"],resolve)) },
    { path: '/bank/cards', component: resolve=>(require(["../pages/intafaced/bank/Cards"],resolve)) },
    { path: '/bank/ramps', component: resolve=>(require(["../pages/intafaced/bank/Ramps"],resolve)) },
    { path: '/bank/analytics', component: resolve=>(require(["../pages/intafaced/bank/Analytics"],resolve)) },
    { path: '/bank/business', component: resolve=>(require(["../pages/intafaced/bank/Business"],resolve)) },
    { path: '/pay', component: resolve=>(require(["../pages/intafaced/Pay"],resolve)) },
    { path: '/pay/money', component: resolve=>(require(["../pages/intafaced/pay/Money"],resolve)) },
    { path: '/pay/merchant', component: resolve=>(require(["../pages/intafaced/pay/Merchant"],resolve)) },
    { path: '/pay/network', component: resolve=>(require(["../pages/intafaced/pay/Network"],resolve)) },
    { path: '/pay/permissions', component: resolve=>(require(["../pages/intafaced/pay/Permissions"],resolve)) },
    { path: '/pay/links', component: resolve=>(require(["../pages/intafaced/pay/Links"],resolve)) },
    { path: '/pay/payments', component: resolve=>(require(["../pages/intafaced/pay/Payments"],resolve)) },
    { path: '/pay/settlements', component: resolve=>(require(["../pages/intafaced/pay/Settlements"],resolve)) },
    { path: '/pay/checkout', component: resolve=>(require(["../pages/intafaced/pay/Checkout"],resolve)) },
    { path: '/market', component: resolve=>(require(["../pages/intafaced/Market"],resolve)) },
    { path: '/market/mine', component: resolve=>(require(["../pages/intafaced/market/Mine"],resolve)) },
    { path: '/support', component: resolve=>(require(["../pages/intafaced/Support"],resolve)) },
    { path: '/ops', component: resolve=>(require(["../pages/intafaced/Ops"],resolve)) },
    { path: '/portfolio', component: resolve=>(require(["../pages/intafaced/Portfolio"],resolve)) },
    { path: '/p2p', component: resolve=>(require(["../pages/intafaced/P2P"],resolve)) },
    { path: '/token', component: resolve=>(require(["../pages/intafaced/Token"],resolve)) },
    { path: '/agents', component: resolve=>(require(["../pages/intafaced/Agents"],resolve)) },
    { path: '/blueprint', component: resolve=>(require(["../pages/intafaced/Blueprint"],resolve)) },
    { path: '/protocol', component: resolve=>(require(["../pages/intafaced/Protocol"],resolve)) },
    { path: '/dex', component: resolve=>(require(["../pages/intafaced/Dex"],resolve)) },
    { path: '/quant', component: resolve=>(require(["../pages/intafaced/quant/Sandbox"],resolve)) },
    { path: '/quant/studio', component: resolve=>(require(["../pages/intafaced/quant/Studio"],resolve)) },
    { path: '/quant/backtest', component: resolve=>(require(["../pages/intafaced/quant/Backtest"],resolve)) },
    { path: '/execution', component: resolve=>(require(["../pages/intafaced/execution/Arb"],resolve)) },
    { path: '/chain', component: resolve=>(require(["../pages/intafaced/Chain"],resolve)) },
    // Two modules with no service behind them at all. Same component, told
    // which one it is — see pages/intafaced/NotBuilt.vue.
    { path: '/academy', component: resolve=>publicJourney(resolve, r=>require(["../pages/intafaced/Academy"],r)) },
    { path: '/launch', component: resolve=>(require(["../pages/intafaced/Launch"],resolve)) },

    // `/envelope/:eno` (gift-claim links) was here and is DELETED, not socketed.
    // See REMOVED in ../config/sockets.js for the reasoning: no tracker row at
    // any phase, a payout with no ledger recipe, reachable only by an inbound
    // shared link, and the one screen of the promotions cluster that collected a
    // phone number from an anonymous visitor and triggered an SMS.
    {
        path: '/otc',
        component: resolve=>(require(["../pages/otc/Main"],resolve)),
        meta: { requiresAuth: true },
        children: [{
                // Without this, `/otc` matched the parent and rendered a heading
                // over an empty <router-view> — a page that looks half-loaded
                // forever. USDT is the default market the desk itself falls back
                // to in `activeMenu()`, so this agrees with the screen.
                path: '',
                redirect: 'trade/usdt'
            },
            {
                path: 'trade/*',
                component: resolve=>(require(["../pages/otc/Trade"],resolve))
            }
        ]
    },
    {
        path: '/uc',
        component: resolve=>(require(["../pages/uc/MemberCenter"],resolve)),
        // The money book and custody refusal are readable signed out: their
        // own states say "sign in" / "unknown", never $0. Identity and the
        // retired account-mall routes remain gated individually below.
        children: [{
                path: '',
                component: resolve=>(require(["../components/uc/Safe"],resolve)),
                meta: { requiresAuth: true }
            },
            {
                path: 'safe',
                component: resolve=>(require(["../components/uc/Safe"],resolve)),
                meta: { requiresAuth: true }
            },
            {
                path: 'account',
                component: resolve=>(require(["../components/uc/Account"],resolve)),
                meta: { requiresAuth: true }
            },
            {
                path: 'money',
                component: resolve=>(require(["../components/uc/MoneyIndex"],resolve))
            },
            {
                path: 'record',
                component: resolve=>(require(["../components/uc/Record"],resolve))
            },
            {
                path: 'recharge',
                component: resolve=>(require(["../components/uc/Recharge"],resolve))
            },
            {
                path: 'withdraw',
                component: resolve=>(require(["../components/uc/Withdraw"],resolve))
            },
            {
                path: 'withdraw/address',
                component: resolve=>(require(["../components/uc/WithdrawAddress"],resolve))
            },
            {
                path: 'ad',
                component: resolve=>(require(["../components/otc/MyAd"],resolve)),
                meta: { requiresAuth: true }
            },
            {
                path: 'ad/create',
                component: resolve=>(require(["../pages/otc/AdPublish"],resolve)),
                meta: { requiresAuth: true }
            },
            {
                path: 'ad/update',
                component: resolve=>(require(["../pages/otc/AdPublish"],resolve)),
                meta: { requiresAuth: true }
            },
            {
                path: 'order',
                component: resolve=>(require(["../components/uc/myorder"],resolve)),
                meta: { requiresAuth: true }
            },
            {
                path: 'entrust/current',
                component: resolve=>(require(["../components/uc/EntrustCurrent"],resolve))
            },
            {
                path: 'entrust/history',
                component: resolve=>(require(["../components/uc/EntrustHistory"],resolve))
            }, {
                path: 'trade',
                component: resolve=>(require(["../components/uc/MinTrade"],resolve)),
                meta: { requiresAuth: true }
            },
            {
                path: 'invitingmining',
                component: resolve=>(require(["../components/uc/InvitingMin"],resolve)),
                meta: { requiresAuth: true }
            },
            {
                path: 'paydividends',
                component: resolve=>(require(["../components/uc/PayDividends"],resolve)),
                meta: { requiresAuth: true }
            },
            {
                path: 'promotion/mycards',
                component: resolve=>(require(["../components/uc/PromotionMyCards"],resolve)),
                meta: { requiresAuth: true }
            },
            {
                path: 'promotion/mypromotion',
                component: resolve=>(require(["../components/uc/MyPromotion"],resolve)),
                meta: { requiresAuth: true }
            },
            {
                path: 'innovation/myorders',
                component: resolve=>(require(["../components/uc/InnovationOrders"],resolve)),
                meta: { requiresAuth: true }
            }
            // `innovation/myminings` (cloud-mining contracts) was here and is
            // DELETED, not socketed — see REMOVED in ../config/sockets.js. No
            // tracker row plans it (mining.pool is Stratum/PPLNS, a different
            // product), and it quoted a daily return the platform does not pay.
        ]
    },
    // The four below are reachable only as a signed-in party to an OTC order or
    // a merchant application. Signed out they used to render an empty frame and
    // sit there; now the guard turns them round at the door.
    {
        name: 'tradeInfo',
        path: '/otc/tradeInfo',
        component: resolve=>(require(["../pages/otc/TradeInfo"],resolve)),
        meta: { requiresAuth: true }
    },
    {
        path: '/checkuser',
        component: resolve=>(require(["../pages/otc/CheckUser"],resolve)),
        meta: { requiresAuth: true }
    },
    {
        path: '/chat',
        component: resolve=>(require(["../pages/otc/Chat"],resolve)),
        meta: { requiresAuth: true }
    },
    {
        path: '/identbusiness',
        component: resolve=>(require(["../pages/uc/IdentBusiness"],resolve)),
        meta: { requiresAuth: true }
    },
    // Ten commented-out routes stood here — /newhelp, /question, /agreement,
    // /rate, /about-rule, /about-protocol, /about-fee, /about-notice, /join-us,
    // /about-merchant. Every component they named (newhelp, question, agreement,
    // rate, exchargerule, userprotocol, feenote, homenotice, joinus,
    // merchantprotocol) is absent from this tree; none can be uncommented into
    // anything. They read as a backlog and are a fiction, so they are gone.
    // `noticeindex` — the only one of those components that did exist — is gone
    // with them: it pushed to /noticeDetail?id=123, a route that has never been
    // in this table, off a Table full of mock rows.
    {
        path: '/about-us',
        component: resolve=>(require(["../pages/cms/AboutUs"],resolve))
    },

    // ── LAST, AND IT MUST STAY LAST ─────────────────────────────────────────
    //
    // vue-router hoists `*` to the end of its own path list regardless of where
    // it appears, so the previous position (line 86, above thirty live routes)
    // was not actually breaking them. It read as though it were, which is worse
    // than a bug you can see: every future editor has to re-derive that.
    //
    // The component changed too. This used to be the HOME PAGE, so a typo, a
    // stale bookmark or a link to a route we deleted showed a working site and
    // said nothing — indistinguishable from success, and it is why nobody could
    // tell which of these routes were real. It now says the address is not one
    // of ours and offers the way back.
    { path: '*', component: resolve=>(require(["../pages/NotFound"],resolve)) }
];
