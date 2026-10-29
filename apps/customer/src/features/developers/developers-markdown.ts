/**
 * The markdown variant of each written developer page and the docs index for assistants (`/developers/llms.txt`),
 * served as static files beside the app from `apps/customer/public/developers/`. They are made from the same English
 * copy and route tables as the pages; `developers-reference.test.ts` checks the files against them and rewrites them
 * with `WRITE_DEVELOPER_DOCS=1`.
 */
import { developersCopy } from './developers-copy';
import { docsCopy } from './developers-docs-copy';
import { DATA_PRODUCTS, SIGN_WINDOW_SECONDS } from './DocsPages';
import { AUDIENCES, ENVIRONMENTS, PROTOCOLS, SECTIONS, hostTable } from './developers-model';
import {
  CALL_COST,
  NEVER_ON_A_KEY,
  PRODUCTS,
  REST_REFERENCE,
  STREAM_REFERENCE,
  permissionTable,
  routeLine,
  scopeFor,
} from './developers-reference';

const portal = developersCopy.forLocale('en').t;
const docs = docsCopy.forLocale('en').t;
const sectionTitle = (id: string) => (portal as (key: string) => string)(`section_${id.replace(/-/g, '_')}`);

const table = (head: string[], rows: string[][]) =>
  [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row.join(' | ')} |`)].join('\n');
const code = (text: string) => `\`${text}\``;

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
            .map(
              (section) =>
                `- ${sectionTitle(section.id)}: ${
                  section.page || section.published ? `/developers/${section.id}` : portal('waitsFor', { slice: section.waitsFor ?? '' })
                }`,
            )
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
          PROTOCOLS.flatMap((protocol) =>
            ENVIRONMENTS.map((environment) => {
              const row = hostTable().find((entry) => entry.protocol === protocol && entry.environment === environment)!;
              return [
                portal(`protocol_${protocol}`),
                portal(`environment_${environment}`),
                row.cell.state === 'set' ? row.cell.host : portal('hostUnset'),
              ];
            }),
          ),
        ),
        portal('hostsRegional'),
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
                      code(route.name),
                      route.anonymous ? docs('publicRoute', { scope: scopeFor(route.method) }) : scopeFor(route.method),
                    ]),
                  ),
                ]
              : []),
            ...(streams.length
              ? [
                  table(
                    [docs('colStream'), docs('colPermission')],
                    streams.map((stream) => [
                      code(stream.channel),
                      stream.private ? docs('privateStream', { scope: 'trade:read' }) : docs('publicStream'),
                    ]),
                  ),
                ]
              : []),
          ];
        }),
        docs('referenceMore'),
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
            ...NEVER_ON_A_KEY.map((scope) => [code(scope), docs('neverOnKey')]),
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
          `3. ${docs('stepClock')}: ${docs('stepClockBody')} ${docs('clockHow')} ${docs('clockOutside', { seconds: SIGN_WINDOW_SECONDS })}`,
          `4. ${docs('stepCall')}: ${docs('stepCallBody')}`,
        ].join('\n'),
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
          [
            [docs('option_internet'), docs('statusHostUnset'), docs('endpointsProduction')],
            [docs('option_redundant'), docs('statusHostUnset'), docs('endpointsRegional')],
            [docs('option_low_latency'), docs('parkedHardware'), docs('endpointsNone')],
            [docs('option_colocation'), docs('parkedHardware'), docs('endpointsNone')],
          ],
        ),
        `## ${docs('timeTitle')}`,
        `${docs('timeLead')} ${docs('clockHow')}`,
      ].join('\n\n'),
  },
  {
    slug: 'data-terms',
    title: docs('dataTermsTitle'),
    summary: docs('dataTermsLead'),
    body: () =>
      [
        docs('dataTermsLead'),
        docs('dataTermsWaits'),
        table(
          [
            docs('colProduct'),
            docs('colEntitlement'),
            docs('colRedistribution'),
            docs('colRetention'),
            docs('colPrivacy'),
            docs('colCommercial'),
          ],
          DATA_PRODUCTS.map((product) => [docs(`product_${product}`), ...Array.from({ length: 5 }, () => docs('termUnset'))]),
        ),
      ].join('\n\n'),
  },
];

export const markdownOf = (page: DocsPage) => `# ${page.title}\n\n${page.body()}\n`;

/** The docs index for assistants: each written page once, by its markdown variant, then the machine-readable files. */
export function llmsTxt(): string {
  return [
    `# ${portal('title')}`,
    `> ${portal('lead')}`,
    '## Pages',
    DOCS_PAGES.map((page) => `- [${page.title}](/developers/${page.slug}.md): ${page.summary}`).join('\n'),
    '## Files',
    [
      `- [OpenAPI](/developers/openapi.json): ${docs('openapiCost', { cost: CALL_COST })}`,
      `- [Collection](/developers/collection.json): ${docs('openapiHosts')}`,
    ].join('\n'),
    '',
  ].join('\n\n');
}
