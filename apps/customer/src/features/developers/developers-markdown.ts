/**
 * The markdown variant of each written developer page and the docs index for assistants (`/developers/llms.txt`),
 * served as static files beside the app from `apps/customer/public/developers/`. They are made from the same English
 * copy and route tables as the pages; `developers-reference.test.ts` checks the files against them and rewrites them
 * with `WRITE_DEVELOPER_DOCS=1`.
 */
import { REQUEST_SIGN_VERSION } from '@intafaced/contracts/api-keys';
import { AUTH_ERRORS_PATH } from '@intafaced/contracts/auth-errors';
import { TRADE_ERROR_CATALOGUE } from '@intafaced/contracts/trade-errors';
import { developersCopy } from './developers-copy';
import { docsCopy } from './developers-docs-copy';
import { causeKey, fixKey, tradeErrorsCopy } from './errors/trade-errors-copy';
import { connectivityEndpointsLabel, connectivityStateLabel, dataTermLabel } from './developers-labels';
import { AUDIENCES, DATA_PRODUCTS, DATA_TERMS, SECTIONS, connectivityOptions, hostRows, type Section } from './developers-model';
import {
  CALL_COST,
  neverOnAKeyTable,
  PRODUCTS,
  REST_REFERENCE,
  STREAM_DOOR_PATH,
  STREAM_REFERENCE,
  permissionTable,
  routeLine,
  scopeText,
  streamName,
} from './developers-reference';

const portal = developersCopy.forLocale('en').t;
const docs = docsCopy.forLocale('en').t;
const tradeErrors = tradeErrorsCopy.forLocale('en').t;
const sectionTitle = (id: string) => (portal as (key: string) => string)(`section_${id.replace(/-/g, '_')}`);

const table = (head: string[], rows: string[][]) =>
  [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row.join(' | ')} |`)].join('\n');
const code = (text: string) => `\`${text}\``;

/** Where a section's page is: its page in this portal, the page it is published at, or the slice it waits for. */
const sectionTarget = (section: Section) =>
  section.page ? `/developers/${section.id}` : section.published ? section.published.href : portal('waitsFor', { slice: section.waitsFor });

/** Pages of this portal that read live data (notices an operator publishes), so they have no static markdown variant. */
const LIVE_PAGES = ['status', 'changelog'] as const;

export type DocsPage = { slug: string; title: string; summary: string; body: () => string };

export const DOCS_PAGES: readonly DocsPage[] = [
  {
    slug: 'index',
    title: portal('title'),
    summary: portal('lead'),
    body: () =>
      [
        portal('lead'),
        `## ${portal('accessTitle')}`,
        portal('accessBody'),
        ...AUDIENCES.flatMap((audience) => [
          `## ${portal(`audience_${audience}`)}`,
          portal(`access_${audience}`),
          SECTIONS.filter((section) => section.audience === audience)
            .map((section) => `- ${sectionTitle(section.id)}: ${sectionTarget(section)}`)
            .join('\n'),
        ]),
      ].join('\n\n'),
  },
  {
    slug: 'hosts',
    title: portal('hostsTitle'),
    summary: portal('hostsLead'),
    body: () =>
      [
        portal('hostsPageLead'),
        table(
          [portal('colProtocol'), portal('colEnvironment'), portal('colHost')],
          hostRows().map((row) => [
            portal(`protocol_${row.protocol}`),
            portal(`environment_${row.environment}`),
            row.cell.state === 'set' ? row.cell.host : portal('hostUnset'),
          ]),
        ),
        portal('hostsStaticNote'),
        portal('regionalStaticNote'),
      ].join('\n\n'),
  },
  {
    slug: 'rest',
    title: sectionTitle('rest'),
    summary: docs('restLead'),
    body: () =>
      [
        docs('restLead'),
        (['restUrls', 'restJson', 'restTimes', 'restIds', 'restSymbols', 'restDecimals', 'restErrors'] as const)
          .map((key) => `- ${docs(key)}`)
          .join('\n'),
        docs('restPaging'),
      ].join('\n\n'),
  },
  {
    slug: 'reference',
    title: sectionTitle('reference'),
    summary: docs('referenceLead'),
    body: () =>
      [
        docs('referenceLead'),
        ...PRODUCTS.flatMap((product) => {
          const routes = REST_REFERENCE.filter((route) => route.product === product);
          const streams = STREAM_REFERENCE.filter((stream) => stream.product === product);
          return [
            `## ${docs(`product_${product}`)}`,
            ...(routes.length || streams.length ? [] : [docs('fundingNone')]),
            ...(routes.length
              ? [
                  table(
                    [docs('colRoute'), docs('colName'), docs('colPermission')],
                    routes.map((route) => [
                      code(routeLine(route)),
                      code(route.name) + (route.onlyWithFuturesMatching ? ` · ${docs('onlyWithMatching')}` : ''),
                      route.access === 'public'
                        ? docs('publicRoute', { scope: scopeText(route) })
                        : route.access === 'internal'
                          ? docs('internalRoute')
                          : scopeText(route),
                    ]),
                  ),
                ]
              : []),
            ...(streams.length
              ? [
                  table(
                    [docs('colStream'), docs('colDoor'), docs('colPermission')],
                    streams.map((stream) => [
                      code(streamName(stream)),
                      `${docs(`door_${stream.door}`)} ${code(STREAM_DOOR_PATH[stream.door])}`,
                      stream.private ? docs('privateStream', { scope: 'trade:read' }) : docs('publicStream'),
                    ]),
                  ),
                ]
              : []),
          ];
        }),
        docs('referenceMore'),
        docs('streamsLive'),
      ].join('\n\n'),
  },
  {
    slug: 'permissions',
    title: sectionTitle('permissions'),
    summary: docs('permissionsLead'),
    body: () =>
      [
        docs('permissionsLead'),
        table(
          [docs('colScope'), docs('colEndpoints')],
          [
            ...permissionTable().map((row) => [code(row.scope), row.routes.map((route) => code(routeLine(route))).join(', ')]),
            ...neverOnAKeyTable().map((row) => [
              code(row.scope),
              row.routes.length > 0
                ? `${docs('neverOnKeyStaff')} ${row.routes.map((route) => code(routeLine(route))).join(', ')}`
                : docs('neverOnKey'),
            ]),
          ],
        ),
      ].join('\n\n'),
  },
  {
    slug: 'openapi',
    title: sectionTitle('openapi'),
    summary: docs('openapiLead'),
    body: () =>
      [
        docs('openapiLead'),
        `- ${docs('openapiDownload')}: /developers/openapi.json`,
        `- ${docs('collectionDownload')}: /developers/collection.json`,
        docs('openapiCost', { cost: CALL_COST }),
        docs('openapiHosts'),
      ].join('\n\n'),
  },
  {
    slug: 'quickstart',
    title: sectionTitle('quickstart'),
    summary: docs('quickstartLead'),
    body: () =>
      [
        docs('quickstartLead'),
        [
          `1. ${docs('stepAccount')}: ${docs('stepAccountBody')}`,
          `2. ${docs('stepKey')}: ${docs('stepKeyBody')}`,
          `3. ${docs('stepClock')}: ${docs('stepClockBody')} ${docs('clockHow')} ${docs('clockWindowLive')}`,
          `4. ${docs('stepCall')}: ${docs('stepCallBody')}`,
        ].join('\n'),
      ].join('\n\n'),
  },
  {
    slug: 'authentication',
    title: sectionTitle('authentication'),
    summary: docs('authLead'),
    body: () =>
      [
        docs('authLead'),
        `## ${docs('authKeyTitle')}`,
        docs('authKeyBody'),
        `## ${docs('authSignTitle')}`,
        docs('authSignBody'),
        [
          `1. ${docs('authLineVersion', { version: REQUEST_SIGN_VERSION })}`,
          `2. ${docs('authLineMethod')}`,
          `3. ${docs('authLinePath')}`,
          `4. ${docs('authLineTimestamp')}`,
          `5. ${docs('authLineNonce')}`,
          `6. ${docs('authLineBody')}`,
        ].join('\n'),
        `## ${docs('authWindowTitle')}`,
        `${docs('authRefusals')} ${docs('authPolicyRead')}`,
        `- ${docs('authErrorsLink')}: /developers/errors/auth`,
      ].join('\n\n'),
  },
  {
    slug: 'errors',
    title: sectionTitle('errors'),
    summary: tradeErrors('lead'),
    body: () =>
      [
        tradeErrors('lead'),
        `## ${tradeErrors('tableTitle')}`,
        table(
          [tradeErrors('colCode'), tradeErrors('colStatus'), tradeErrors('colDetail'), tradeErrors('colCause'), tradeErrors('colFix')],
          TRADE_ERROR_CATALOGUE.map((entry) => [
            code(entry.code),
            String(entry.status),
            code(entry.intafacedCode),
            tradeErrors(causeKey(entry.cause)),
            tradeErrors(fixKey(entry.cause)),
          ]),
        ),
        `- ${tradeErrors('authLink')}: ${AUTH_ERRORS_PATH}`,
      ].join('\n\n'),
  },
  {
    slug: 'connectivity',
    title: sectionTitle('connectivity'),
    summary: docs('connectivityLead'),
    body: () =>
      [
        docs('connectivityLead'),
        table(
          [docs('colOption'), docs('colStatus'), docs('colEndpoints2')],
          connectivityOptions().map(({ option, state, hosts }) => [
            docs(`option_${option}`),
            connectivityStateLabel(docs, state),
            [
              connectivityEndpointsLabel(docs, option),
              ...hosts.map(
                ({ protocol, cell }) =>
                  `${portal(`protocol_${protocol}`)}: ${cell.state === 'set' ? code(cell.host) : portal('hostUnset')}`,
              ),
            ].join('; '),
          ]),
        ),
        portal('hostsStaticNote'),
        `## ${docs('timeTitle')}`,
        `${docs('timeLead')} ${docs('clockHow')}`,
      ].join('\n\n'),
  },
  {
    slug: 'data-terms',
    title: sectionTitle('data-terms'),
    summary: docs('dataTermsLead'),
    body: () =>
      [
        docs('dataTermsLead'),
        portal('termsStaticNote'),
        table(
          [docs('colProduct'), ...DATA_TERMS.map((term) => dataTermLabel(docs, term))],
          DATA_PRODUCTS.map((product) => [docs(`product_${product}`), ...DATA_TERMS.map(() => docs('termUnset'))]),
        ),
      ].join('\n\n'),
  },
];

export const markdownOf = (page: DocsPage) => `# ${page.title}\n\n${page.body()}\n`;

/**
 * The docs index for assistants: each written page once, by its markdown variant; the live pages, which read published
 * notices and so have no static variant; every other section where it is published or what it waits for; then the
 * machine-readable files.
 */
export function llmsTxt(): string {
  return [
    `# ${portal('title')}`,
    `> ${portal('lead')}`,
    '## Pages',
    DOCS_PAGES.map((page) => `- [${page.title}](/developers/${page.slug}.md): ${page.summary}`).join('\n'),
    '## Live pages',
    LIVE_PAGES.map((id) => `- [${sectionTitle(id)}](/developers/${id})`).join('\n'),
    '## Other sections',
    SECTIONS.filter((section) => !section.page)
      .map((section) => `- ${sectionTitle(section.id)}: ${sectionTarget(section)}`)
      .join('\n'),
    '## Files',
    [
      `- [OpenAPI](/developers/openapi.json): ${docs('openapiCost', { cost: CALL_COST })}`,
      `- [Collection](/developers/collection.json): ${docs('openapiHosts')}`,
    ].join('\n'),
    '',
  ].join('\n\n');
}
