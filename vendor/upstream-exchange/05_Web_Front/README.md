# INTAFACED trading shell

> Product web front for the INTAFACED exchange desk

## Install Prerequisites
The following dependencies are required to run an instance:

1. NodeJS - 9.11.2
2. Npm - 5.6.0

## Build Setup

``` bash
# install dependencies
npm i

# serve with hot reload at localhost:8080
npm run dev

# build for production with minification
npm run build

```



## Future
1. 统一改用less,实验可以通过变量覆盖的方式定制主题;
2. iview组件按需引用;
3. exchange.vue等大文件，代码拆分/组件化;


## 前端开发规范
1. 页面使用驼峰法命名，如Exchange.vue,WithdrawRecord.vue,名称为英文单词，并且要能正确描述该模块功能
2. 变量命名禁止使用拼音，特别是拼音缩写
3. 页面比较多时应该使用文件夹做分类
4. 模块中data变量应该尽量少，比较多时应该使用子对象进行管理



## Public prelaunch enquiries

`/join`, `/invest`, `/trade` and `/merchant` open the public enquiry flow. On the exact hostname `join.intafaced.com`, `/`, `/academy` and `/partner` also open it. On other hosts, the existing `/academy` and `/partner` product routes remain available; use `/join/academy` and `/join/partner` for local enquiry previews. Named country selectors use a dependency-free public-domain IANA ISO country table, with `Intl.DisplayNames` for labels; these self-reported geography choices do not define access policy or a sanctions list. Every selected audience uses questionnaire version 1 from `packages/contracts/src/outreach-crm.ts`.

The client saves contact before the longer questions and POSTs bare JSON through the existing edge `/api/ops/trpc/outreach.capture`, `outreach.resume`, `outreach.answer` and `outreach.addInterests` routes without an account bearer. It generates an independent browser-crypto 256-bit continuation capability and request UUID before first capture. Pending requests, confirmed receipts and unsent forms use this tab’s `sessionStorage` by default. “Remember my draft on this device” additionally stores encrypted AES-GCM data and a non-extractable 256-bit WebCrypto key in origin-bound IndexedDB. The browser-local key supplies no backend identity or email ownership. Device recovery reopens only after the visitor chooses to continue and the server accepts the continuation capability. It does not work across devices or browsers. Raw prospect fields and capabilities never enter the persistent envelope, links, ordinary logs or analytics. Browser-origin compromise is outside this local encryption boundary.

Confirmed receipts enforce the server’s actual continuation expiry. A lost initial response retains the same retry identity with unknown expiry until the server confirms or refuses it; no guessed client deadline extends backend authority. Asynchronous storage commits request intent before the first network attempt. Identical failed attempts retain their request UUID; changed input creates a new intent. Resume reconciles the latest revision after cached/lost responses. Unsent groups and fields persist separately from confirmed answers, and the UI reports local storage only after a successful write. Unavailable storage has an on-page limitation. Forgetting local access awaits removal of both tab and persistent drafts; it does not delete the durable enquiry.

The selected Raycast-inspired graphite/lime design is recorded in `.21st/design.json` and scoped to outreach. The actual aperture/wordmark remains `logo.svg`; licensed Inter variable fonts are self-hosted, with `src/assets/fonts/OFL.txt`. Original rendered graphite fins replace the rejected CSS rings. Optimized desktop and deliberate 5:3 phone crops use a decorative static picture with a brief welcome reveal; source hash/crop/compression recipe is in `src/assets/images/outreach/art-recipe.json`. Native Vue choice cards and segmented progression adapt searched 21st patterns. Saved contact options and optional encrypted device recovery use native disclosure. Phone actions respect the safe area while the visitor scrolls the form. Reduced motion disables arrival/advance animation.

Investor entry preselects investor and follows welcome → contact receipt → participation/profile/role → optional context → editable unsent review → durable Send enquiry. Introduction-only enquiries omit amount and save `undecided`; no other required fields are inferred. Other audiences retain every version 1 field. Currency names use browser `Intl.DisplayNames` and searchable choices, with canonical codes on the wire. Money stays a decimal string. Saved details are read-only; append-only interests create new questionnaires while preserving originals. Completion requires all currently selected questionnaires saved.

Set public build inputs `OUTREACH_CONTACT_URL` (approved HTTPS destination or plain mailto address) and `OUTREACH_RETENTION_NOTICE` (approved public text, up to 1000 characters) to publish the actual guest contact/correction route and retention explanation. Unsafe URLs refuse locally. Blank values stay absent; the authenticated account `/support` page is not advertised as a guest correction route. These publication values are business configuration, not backend authority.

The planned deck button is “Discuss the investment” → `https://join.intafaced.com/invest`, with only a configured opaque source hint. The actual outgoing Canva export/Papermark button click remains a separate acceptance check; this frontend proof does not establish it.

Production hosting must configure **HTTPS for the exact `join.intafaced.com` host**, serve this existing shell's `dist/` assets, and return `dist/index.html` for HTML navigation to `/`, `/join`, `/invest`, `/trade`, `/merchant`, `/academy`, `/partner` and `/join/*`. Proxy `/api/ops/trpc/*` to the existing edge without rewriting its public prefix. DNS, certificate and reverse-proxy host routing are deployment inputs; port mappings alone do not configure this domain. This frontend does not provision them.

Enquiry reply permission and optional marketing permission are separate. Completion confirms saved contact and selected answers; it does not confirm email delivery, product access or an investment. Operator retention/deletion/export policy, public privacy copy, outbound email sender/gateway and durable backend configuration must be confirmed for live launch. This code contains no private fundraising source or provider viewer identity inference. Only a schema-valid opaque `source` query hint is forwarded as `sourceKey`.

Focused local checks (Node 24 and the existing shell dependencies):

```bash
node src/assets/js/outreach-intake.golden.js
../../../node_modules/.bin/vitest run src/outreach-intake.contract.test.ts
npm run build
node test/outreach/public-intake.browser.mjs
```

The browser proof serves local build assets with fixture API replies, exercises all five selected journeys at 320px, 390px, 1280px and 1440px, including investor and introducer flows, actual tab closure/reopening in the same browser, unsent review/edit, lost-response retries, added interests, encrypted storage/key checks, expiry, font/logo loading, keyboard access, reduced motion and overflow. Screenshots and local recordings are written to `/tmp/intafaced-outreach-quality-journey-proof`. A reduced-height viewport checks input access; physical mobile software-keyboard behavior still requires a device walkthrough. It does not submit to a live service or claim deployed-host validation.
