import { useRef, useState, type ReactNode } from 'react';
import { Button, Field } from '@intafaced/ui/lit';
import { useResource, type Resource } from '../../../../shared/resource';
import type { ApiResult } from '../../../../shared/api';
import type { PortalApi } from '../api';
import type { MerchantRecord } from '../schemas';
import { formatBytes } from '../settings/reports/model';
import { useUnsavedForm } from '../useUnsavedForm';
import { accountCopy } from '../settings/account/copy';
import { applicationCopy, keyWords } from '../settings/onboarding/application-copy';
import type { Answers, Application, ApplicationSection, Checklist, DocumentRow, EntityType } from '../settings/onboarding/application-api';
import { Actions, DateTime, Facts, Gate, Section as PaySection, SelectField } from './parts';
import { PortalReview } from './review';
import { Blocker } from './onboarding-parts';

/**
 * Step 2's business application (`settings/onboarding/Application.tsx` re-exports it), drawn from the kit for the
 * onboarding room on the flow template: the legal entity, then each part the type asks for, then the review.
 */
type T = ReturnType<typeof applicationCopy.useCopy>['t'];
type Section = Application['sections'][number];

/** The most people one application holds: five answers each, inside the service's 100 answers a section. */
export const MAX_PEOPLE = 18;
const PERSON_FIELDS = ['role', 'name', 'birth_date', 'nationality', 'ownership'] as const;
type Person = Record<(typeof PERSON_FIELDS)[number], string>;
const emptyPerson = (role = ''): Person => ({ role, name: '', birth_date: '', nationality: '', ownership: '' });

const COMPANY_FIELDS = ['legal_name', 'registration_number', 'incorporation_date', 'registered_address', 'tax_id'] as const;
const COMPANY_REQUIRED = ['legal_name', 'registered_address'] as const;

const text = (value: Answers[string] | undefined) => (typeof value === 'string' ? value : '');

/** People are kept as `person_<n>_<field>` answers, so a section stays a flat set of named fields. */
export function peopleFrom(data: Answers): Person[] {
  const indexes = new Set<number>();
  for (const key of Object.keys(data)) {
    const m = /^person_(\d+)_/.exec(key);
    if (m) indexes.add(Number(m[1]));
  }
  return [...indexes]
    .sort((a, b) => a - b)
    .map((n) => Object.fromEntries(PERSON_FIELDS.map((f) => [f, text(data[`person_${n}_${f}`])])) as Person);
}
export function peopleAnswers(people: Person[]): Answers {
  const out: Answers = {};
  people.forEach((person, i) => {
    for (const f of PERSON_FIELDS) if (person[f].trim()) out[`person_${i + 1}_${f}`] = person[f].trim();
  });
  return out;
}
const personDone = (p: Person) =>
  Boolean(p.role && p.name.trim() && p.birth_date && /^[A-Za-z]{2}$/.test(p.nationality.trim())) &&
  (p.ownership.trim() === '' || /^(100|[0-9]{1,2})(\.[0-9]{1,2})?$/.test(p.ownership.trim()));
/** Roles with nobody in them yet. Every published role needs a person, and every person needs a role, name, birth date and nationality. */
export function rolesWithoutPerson(roles: readonly string[], people: Person[]): string[] {
  return roles.filter((role) => !people.some((p) => p.role === role && personDone(p)));
}
export const peopleComplete = (roles: readonly string[], people: Person[]) =>
  people.length > 0 && people.every(personDone) && rolesWithoutPerson(roles, people).length === 0;

/** Checked before anything is sent: the owner's size limit and accepted kinds of file. Null means the file may go. */
export function fileProblem(file: { size: number; type: string }, rules: NonNullable<Checklist['uploadRules']>, t: T): string | null {
  if (file.size < 1) return t('emptyFile');
  if (!rules.contentTypes.some((type) => type.toLowerCase() === file.type.toLowerCase()))
    return t('wrongType', { types: kindsOf(rules.contentTypes) });
  if (file.size > rules.maxBytes) {
    const [size, limit] = [formatBytes(String(file.size)), formatBytes(String(rules.maxBytes))];
    // Just over the limit both round to the same figure, so say it in bytes.
    return size === limit ? t('tooLarge', { size: `${file.size} B`, limit: `${rules.maxBytes} B` }) : t('tooLarge', { size, limit });
  }
  return null;
}
export const kindsOf = (types: readonly string[]) => types.map((type) => (type.split('/')[1] ?? type).toUpperCase()).join(', ');

/** What the summary lists as still needed: each unfinished part, and by name each document not sent or marked invalid. */
export function stillNeeded(application: Application, checklist: Checklist | null, t: T): string[] {
  const docs = checklist?.rows.filter((r) => r.state === 'missing' || r.state === 'rejected').map((r) => keyWords(r.key)) ?? [];
  return application.missing.map((section) =>
    section === 'documents' && docs.length > 0
      ? `${t('section_documents')}: ${docs.join(', ')}`
      : t(`section_${section}` as 'section_people'),
  );
}

export type ApplicationViewProps = {
  portal: PortalApi;
  merchant: MerchantRecord;
  /** The business's verification as it now stands, which can be newer than `merchant`. */
  kybStatus: MerchantRecord['kybStatus'];
  kybRef: string | null;
  types: Resource<EntityType[]>;
  application: Resource<Application | null>;
  checklist: Resource<Checklist | null>;
  /** A write answered with the application as it now stands. `cleared` when its documents stopped counting. */
  onChanged: (application: Application, cleared?: boolean) => void;
  reloadDocuments: () => void;
  onSubmitted: () => void;
  retry: () => void;
  /** Goes up each time the application is cleared, so every part's form starts again from what the service holds. */
  generation: number;
};

/** Step 2's business application: the legal entity, then each part the type asks for, then the review. */
export function BusinessApplication({
  portal,
  merchant,
  kybStatus,
  kybRef,
  onSubmitted,
}: {
  portal: PortalApi;
  merchant: MerchantRecord;
  kybStatus: MerchantRecord['kybStatus'];
  kybRef: string | null;
  onSubmitted: () => void;
}) {
  const types = useResource(async (s) => {
    const r = await portal.kybEntityTypes(s);
    return r.ok ? { ok: true as const, data: r.data.entityTypes } : r;
  }, 'portal:kyb-types');
  const loaded = useResource((s) => portal.kybApplication(merchant.id, s), `portal:kyb-application:${merchant.id}`);
  const [fresh, setFresh] = useState<Application | null>(null);
  const [round, setRound] = useState(0);
  const application: Resource<Application | null> = fresh ? { status: 'ready', data: fresh } : loaded.resource;
  const current = application.status === 'ready' ? application.data : null;
  const asksDocuments = Boolean(current?.sections.some((s) => s.section === 'documents' && s.required));
  const docsKey = `${current?.applicationId ?? 'none'}:${current?.entityType ?? ''}:${current?.country ?? ''}:${asksDocuments}:${round}`;
  const checklist = useResource(
    (s) => (current && asksDocuments ? portal.kybDocuments(current.applicationId, s) : Promise.resolve({ ok: true as const, data: null })),
    `portal:kyb-documents:${docsKey}`,
  );
  // A reload after an upload keeps the rows on screen, so each row's "sent" note and chosen file stay put; a cleared
  // application (another key) starts from nothing.
  const lastDocs = useRef<{ key: string; data: Checklist | null } | null>(null);
  if (checklist.resource.status === 'ready') lastDocs.current = { key: docsKey, data: checklist.resource.data };
  const docs: Resource<Checklist | null> =
    checklist.resource.status === 'loading' && lastDocs.current?.key === docsKey
      ? { status: 'ready', data: lastDocs.current.data }
      : checklist.resource;
  return (
    <ApplicationView
      portal={portal}
      merchant={merchant}
      kybStatus={kybStatus}
      kybRef={kybRef}
      types={types.resource}
      application={application}
      checklist={docs}
      onChanged={(next, cleared) => {
        setFresh(next);
        if (cleared) setRound((n) => n + 1);
      }}
      reloadDocuments={checklist.reload}
      generation={round}
      onSubmitted={onSubmitted}
      retry={() => {
        setFresh(null);
        types.reload();
        loaded.reload();
        checklist.reload();
      }}
    />
  );
}

/** What every part below the gates gets: the published types and the application, both read. */
type Inner = Omit<ApplicationViewProps, 'types' | 'application'> & { types: EntityType[]; application: Application };

export function ApplicationView(props: ApplicationViewProps) {
  const { t } = applicationCopy.useCopy();
  return (
    <PaySection title={t('appTitle')} description={t('appBody')}>
      <Gate resource={props.types} retry={props.retry} rows={2}>
        {(types) => (
          <Gate resource={props.application} retry={props.retry} rows={3}>
            {(application) => {
              const turnedDown = application?.state === 'submitted' && props.kybStatus === 'rejected';
              const start =
                types.length === 0 ? (
                  <Blocker reason={t('noTypesReason')} needs="entity type requirements" title={t('noTypesTitle')}>
                    {t('noTypesBody')}
                  </Blocker>
                ) : (
                  <StartForm {...props} types={types} />
                );
              if (application && !turnedDown) return <Started {...props} types={types} application={application} />;
              if (turnedDown)
                return (
                  <div>
                    <Started {...props} types={types} application={application} />
                    <h3>{t('againTitle')}</h3>
                    {start}
                  </div>
                );
              // Verified or under review another way (a verification reference): nothing to apply for here.
              if (props.kybStatus === 'pending' || props.kybStatus === 'approved')
                return <p role="note">{props.kybStatus === 'approved' ? t('otherApproved') : t('otherPending')}</p>;
              return start;
            }}
          </Gate>
        )}
      </Gate>
    </PaySection>
  );
}

/** A type and a country it is offered in. Countries follow the chosen type. */
function TypeAndCountry({
  types,
  entityType,
  country,
  onChange,
}: {
  types: EntityType[];
  entityType: string;
  country: string;
  onChange: (entityType: string, country: string) => void;
}) {
  const { t } = applicationCopy.useCopy();
  const [chosenType, chosenCountry] = offered(types, entityType, country);
  const chosen = types.find((type) => type.entityType === chosenType)!;
  return (
    <div>
      <SelectField
        label={`${t('fEntityType')} *`}
        value={chosen.entityType}
        onChange={(next) => onChange(next, types.find((type) => type.entityType === next)?.countries[0] ?? '')}
        options={types.map((type) => [type.entityType, typeWord(type.entityType, t)] as const)}
        hint={t('hEntityType')}
      />
      <SelectField
        label={`${t('fCountry')} *`}
        value={chosenCountry}
        onChange={(next) => onChange(chosen.entityType, next)}
        options={chosen.countries.map((code) => [code, code] as const)}
        hint={t('hCountry')}
      />
    </div>
  );
}

/** The type and country as the selects show them: what was asked when it is offered, else the first offered. */
function offered(types: EntityType[], entityType: string, country: string): [string, string] {
  const chosen = types.find((type) => type.entityType === entityType) ?? types[0];
  if (!chosen) return [entityType, country];
  return [chosen.entityType, chosen.countries.includes(country) ? country : (chosen.countries[0] ?? '')];
}

const typeWord = (entityType: string, t: T) => t(`type_${entityType}` as 'type_trust');

function StartForm({ portal, merchant, types, onChanged }: Omit<ApplicationViewProps, 'types'> & { types: EntityType[] }) {
  const { t } = applicationCopy.useCopy();
  const [entityType, setEntityType] = useState<string>(types[0]!.entityType);
  const [country, setCountry] = useState(types[0]!.countries[0] ?? '');
  const saver = useSaver();
  return (
    <div data-testid="form-stack">
      <TypeAndCountry
        types={types}
        entityType={entityType}
        country={country}
        onChange={(type, code) => {
          setEntityType(type);
          setCountry(code);
        }}
      />
      <p className="lt-hint">{t('startBody')}</p>
      <Actions>
        <Button
          tone="primary"
          disabled={saver.busy}
          onClick={() =>
            saver.run(
              () => portal.kybApplicationStart(merchant.id, entityType, country),
              (app) => onChanged(app),
            )
          }
        >
          {t('start')}
        </Button>
      </Actions>
      <SaverNote saver={saver} />
    </div>
  );
}

function Started(props: Inner) {
  const { t } = applicationCopy.useCopy();
  const { application, checklist } = props;
  const docs = checklist.status === 'ready' ? checklist.data : null;
  const draft = application.state === 'draft';
  const needed = stillNeeded(application, docs, t);
  // The verification's outcome belongs to this application only when its reference names it.
  const outcome = props.kybRef === `application:${application.applicationId}` ? props.kybStatus : null;
  const status = draft
    ? application.missing.length === 0
      ? t('statusReady')
      : t('statusPending')
    : outcome === 'approved'
      ? t('statusApproved')
      : outcome === 'rejected'
        ? t('statusRejected')
        : t('statusSubmitted');
  const published = props.types.find((type) => type.entityType === application.entityType);
  return (
    <div>
      <Facts
        items={[
          [t('statusLabel'), <strong>{status}</strong>],
          [t('fEntityType'), typeWord(application.entityType, t)],
          [t('fCountry'), application.country],
          draft
            ? [t('dueBy'), application.dueAt ? <DateTime value={application.dueAt} dayOnly /> : t('dueNone')]
            : [t('submittedOn'), application.submittedAt ? <DateTime value={application.submittedAt} /> : '—'],
        ]}
      />
      {draft ? (
        <div>
          <h3>{t('neededTitle')}</h3>
          {needed.length === 0 ? (
            <p>{t('neededNone')}</p>
          ) : (
            <ul aria-label={t('neededTitle')}>
              {needed.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <p role="note">
          {outcome === 'approved'
            ? t('approvedNote')
            : outcome === 'rejected'
              ? t('rejectedNote')
              : docs?.rows.some((row) => row.state === 'rejected')
                ? t('resendNote')
                : t('submittedNote')}
        </p>
      )}
      {application.sections
        .filter((section) => section.required)
        .map((section) => (
          <SectionPanel key={`${section.section}:${props.generation}`} {...props} section={section} published={published} />
        ))}
      {draft && <Submit {...props} />}
      {draft && <ChangeType {...props} />}
    </div>
  );
}

function SectionPanel(props: Inner & { section: Section; published: EntityType | undefined }) {
  const { t } = applicationCopy.useCopy();
  const { section } = props;
  const state = section.state === 'complete' ? t('sectionDone') : section.state === 'draft' ? t('sectionDraft') : t('sectionEmpty');
  const title = t(`section_${section.section}` as 'section_people');
  let body: ReactNode = null;
  if (section.section === 'company_details') body = <CompanyDetails {...props} />;
  else if (section.section === 'people') body = <People {...props} roles={props.published?.peopleRoles ?? rolesIn(section.data)} />;
  else if (section.section === 'questionnaires') body = <Questions {...props} keys={props.published?.questionnaireKeys ?? []} />;
  else if (section.section === 'documents') body = <Documents {...props} />;
  return (
    <section aria-label={title}>
      <h3>
        {title} · <span className="lt-hint">{state}</span>
      </h3>
      {body}
    </section>
  );
}

const rolesIn = (data: Answers) => [
  ...new Set(
    peopleFrom(data)
      .map((p) => p.role)
      .filter(Boolean),
  ),
];

/** One save of one section, at the version this page read. Complete when every required answer is in. */
function useSectionSave(props: Inner & { section: Section }) {
  const saver = useSaver();
  const save = (complete: boolean, data: Answers) =>
    saver.run(
      () => props.portal.kybApplicationSave(props.application.applicationId, props.section.section, props.section.version, complete, data),
      (next) => props.onChanged(next),
      complete ? 'savedDone' : 'saved',
    );
  return { saver, save };
}

function CompanyDetails(props: Inner & { section: Section }) {
  const { t } = applicationCopy.useCopy();
  const { t: a } = accountCopy.useCopy();
  const draft = props.application.state === 'draft';
  const [form, setForm] = useState<Record<(typeof COMPANY_FIELDS)[number], string>>(
    () =>
      Object.fromEntries(COMPANY_FIELDS.map((f) => [f, text(props.section.data[f])])) as Record<(typeof COMPANY_FIELDS)[number], string>,
  );
  const { saver, save } = useSectionSave(props);
  const changed = COMPANY_FIELDS.some((f) => form[f].trim() !== text(props.section.data[f]));
  useUnsavedForm(draft && changed, a('acUnsaved'));
  const done = COMPANY_REQUIRED.every((f) => form[f].trim());
  const set = (f: (typeof COMPANY_FIELDS)[number]) => (e: { target: { value: string } }) => setForm({ ...form, [f]: e.target.value });
  const answers = () => Object.fromEntries(COMPANY_FIELDS.filter((f) => form[f].trim()).map((f) => [f, form[f].trim()]));
  return (
    <form
      data-testid="form-stack"

      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        save(done, answers());
      }}
    >
      <Field
        label={`${t('fLegalName')} *`}
        value={form.legal_name}
        onChange={set('legal_name')}
        maxLength={200}
        disabled={!draft}
        required
      />
      <div>
        <Field
          label={t('fRegistrationNumber')}
          value={form.registration_number}
          onChange={set('registration_number')}
          maxLength={64}
          hint={t('hRegistrationNumber')}
          disabled={!draft}
        />
        <Field
          label={t('fIncorporationDate')}
          type="date"
          value={form.incorporation_date}
          onChange={set('incorporation_date')}
          disabled={!draft}
        />
      </div>
      <Field
        label={`${t('fRegisteredAddress')} *`}
        value={form.registered_address}
        onChange={set('registered_address')}
        maxLength={500}
        autoComplete="street-address"
        disabled={!draft}
        required
      />
      <Field label={t('fTaxId')} value={form.tax_id} onChange={set('tax_id')} maxLength={64} hint={t('hTaxId')} disabled={!draft} />
      {draft && <SaveRow saver={saver} done={done} />}
    </form>
  );
}

function People(props: Inner & { section: Section; roles: string[] }) {
  const { t } = applicationCopy.useCopy();
  const { t: a } = accountCopy.useCopy();
  const { roles } = props;
  const draft = props.application.state === 'draft';
  const saved = peopleFrom(props.section.data);
  const [people, setPeople] = useState<Person[]>(() => (saved.length > 0 ? saved : [emptyPerson(roles[0])]));
  const { saver, save } = useSectionSave(props);
  const answers = peopleAnswers(people);
  const changed = JSON.stringify(answers) !== JSON.stringify(peopleAnswers(saved));
  useUnsavedForm(draft && changed, a('acUnsaved'));
  const missingRoles = rolesWithoutPerson(roles, people);
  const done = peopleComplete(roles, people);
  const update = (i: number, f: keyof Person) => (e: { target: { value: string } }) =>
    setPeople(people.map((p, j) => (j === i ? { ...p, [f]: e.target.value } : p)));
  return (
    <form
      data-testid="form-stack"

      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        save(done, answers);
      }}
    >
      <p className="lt-hint">{t('peopleBody')}</p>
      {missingRoles.length > 0 && <p role="note">{t('peopleRolesNeeded', { roles: missingRoles.map(keyWords).join(', ') })}</p>}
      {people.map((person, i) => (
        <fieldset key={i} disabled={!draft}>
          <legend>{t('personN', { n: i + 1 })}</legend>
          <SelectField
            label={`${t('fRole')} *`}
            value={person.role}
            onChange={(role) => setPeople(people.map((p, j) => (j === i ? { ...p, role } : p)))}
            options={roles.map((role) => [role, keyWords(role)] as const)}
          />
          <Field label={`${t('fPersonName')} *`} value={person.name} onChange={update(i, 'name')} maxLength={200} required />
          <div>
            <Field label={`${t('fBirthDate')} *`} type="date" value={person.birth_date} onChange={update(i, 'birth_date')} required />
            <Field label={`${t('fNationality')} *`} value={person.nationality} onChange={update(i, 'nationality')} maxLength={2} required />
          </div>
          <Field
            label={t('fOwnership')}
            inputMode="decimal"
            value={person.ownership}
            onChange={update(i, 'ownership')}
            maxLength={6}
            hint={t('hOwnership')}
          />
          {draft && people.length > 1 && (
            <Button tone="secondary" type="button" onClick={() => setPeople(people.filter((_, j) => j !== i))}>
              {t('removePerson')}
            </Button>
          )}
        </fieldset>
      ))}
      {draft &&
        (people.length < MAX_PEOPLE ? (
          <Actions>
            <Button tone="secondary" type="button" onClick={() => setPeople([...people, emptyPerson(missingRoles[0] ?? roles[0])])}>
              {t('addPerson')}
            </Button>
          </Actions>
        ) : (
          <p className="lt-hint">{t('peopleFull')}</p>
        ))}
      {draft && <SaveRow saver={saver} done={done} />}
    </form>
  );
}

function Questions(props: Inner & { section: Section; keys: string[] }) {
  const { t } = applicationCopy.useCopy();
  const { t: a } = accountCopy.useCopy();
  const draft = props.application.state === 'draft';
  const keys = props.keys.length > 0 ? props.keys : Object.keys(props.section.data);
  const [answers, setAnswers] = useState<Record<string, string>>(() =>
    Object.fromEntries(keys.map((k) => [k, text(props.section.data[k])])),
  );
  const { saver, save } = useSectionSave(props);
  useUnsavedForm(draft && keys.some((k) => (answers[k] ?? '').trim() !== text(props.section.data[k])), a('acUnsaved'));
  const done = keys.every((k) => (answers[k] ?? '').trim());
  return (
    <form
      data-testid="form-stack"

      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        save(done, Object.fromEntries(keys.filter((k) => (answers[k] ?? '').trim()).map((k) => [k, answers[k]!.trim()])));
      }}
    >
      <p className="lt-hint">{t('questionsBody')}</p>
      {keys.map((key) => (
        <Field
          key={key}
          label={`${keyWords(key)} *`}
          value={answers[key] ?? ''}
          onChange={(e) => setAnswers({ ...answers, [key]: e.target.value })}
          maxLength={2000}
          disabled={!draft}
          required
        />
      ))}
      {draft && <SaveRow saver={saver} done={done} />}
    </form>
  );
}

const usable = (row: DocumentRow) => row.state === 'provided' || row.state === 'accepted';

function Documents(props: Inner & { section: Section }) {
  const { t } = applicationCopy.useCopy();
  const draft = props.application.state === 'draft';
  // Sent and not yet decided: a document marked Invalid takes a new file, nothing else changes.
  const underReview = !draft && props.kybRef === `application:${props.application.applicationId}` && props.kybStatus === 'pending';
  const { saver, save } = useSectionSave(props);
  return (
    <Gate resource={props.checklist} retry={props.retry} rows={2}>
      {(checklist) => {
        if (!checklist) return null;
        const rules = checklist.uploadRules;
        const allSent = checklist.rows.every(usable);
        return (
          <div data-testid="form-stack">
            <p className="lt-hint">{t('docsBody')}</p>
            {checklist.vendorCheck.status === 'not_connected' && (
              <Blocker reason={t('docsVendorReason')} needs="automatic document check" title={t('docsVendorTitle')}>
                {t('docsVendor')}
              </Blocker>
            )}
            {rules ? (
              <p className="lt-hint">
                {t('docsLimits', { size: formatBytes(String(rules.maxBytes)), types: kindsOf(rules.contentTypes) })}
              </p>
            ) : (
              <Blocker reason={t('docsRulesReason')} needs="document upload rules" title={t('docsRulesTitle')}>
                {t('docsRulesBody')}
              </Blocker>
            )}
            <table className="lt-table">
              <thead>
                <tr>
                  <th scope="col">{t('docName')}</th>
                  <th scope="col">{t('docState')}</th>
                  <th scope="col">{t('docFile')}</th>
                </tr>
              </thead>
              <tbody>
                {checklist.rows.map((row) => (
                  <DocumentLine
                    key={row.key}
                    {...props}
                    row={row}
                    rules={draft || (underReview && row.state === 'rejected') ? rules : null}
                  />
                ))}
              </tbody>
            </table>
            {draft && props.section.state !== 'complete' && (
              <>
                <Actions>
                  <Button tone="primary" disabled={!allSent || saver.busy} onClick={() => save(true, {})}>
                    {t('docsConfirm')}
                  </Button>
                </Actions>
                {!allSent && <p className="lt-hint">{t('docsConfirmNeeded')}</p>}
              </>
            )}
            <SaverNote saver={saver} />
          </div>
        );
      }}
    </Gate>
  );
}

function DocumentLine({ portal, application, row, rules, reloadDocuments }: Inner & { row: DocumentRow; rules: Checklist['uploadRules'] }) {
  const { t } = applicationCopy.useCopy();
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const saver = useSaver();
  const name = keyWords(row.key);
  return (
    <tr>
      <th scope="row">{name}</th>
      <td>
        <strong>{t(`docState_${row.state}` as 'docState_missing')}</strong>
        {row.state === 'rejected' && row.rejectionReason && (
          <small className="lt-hint">{t('docReason', { reason: row.rejectionReason })}</small>
        )}
        {row.document && <small className="lt-hint">{t('docSent', { size: formatBytes(String(row.document.byteLength)) })}</small>}
      </td>
      <td>
        {rules && (
          <div data-testid="form-stack">
            <Field
              label={t('chooseFile', { name })}
              type="file"
              aria-label={t('chooseFile', { name })}
              accept={rules.contentTypes.join(',')}
              onChange={(event) => {
                const picked = event.target.files?.[0] ?? null;
                setFile(picked);
                setProblem(picked ? fileProblem(picked, rules, t) : null);
              }}
            />
            {problem && <small role="alert">{problem}</small>}
            <Button
              tone="secondary"
              disabled={!file || Boolean(problem) || saver.busy}
              onClick={() =>
                file &&
                saver.run(
                  async () => portal.kybDocumentUpload(application.applicationId, row.key, file.type, await base64Of(file)),
                  () => {
                    setFile(null);
                    reloadDocuments();
                  },
                  'uploaded',
                  { name },
                )
              }
            >
              {saver.busy ? t('uploading') : t('upload')}
            </Button>
            <SaverNote saver={saver} />
          </div>
        )}
      </td>
    </tr>
  );
}

export async function base64Of(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function Submit({ portal, application, onChanged, onSubmitted }: Inner) {
  const { t } = applicationCopy.useCopy();
  return (
    <Actions>
      <PortalReview
        title={t('submit')}
        variant="primary"
        description={t('submitBody')}
        perform={() => portal.kybApplicationSubmit(application.applicationId)}
        onConfirmed={(next) => {
          onChanged(next);
          onSubmitted();
        }}
        disabled={application.missing.length > 0}
        disabledReason={t('submitNeeded')}
      />
    </Actions>
  );
}

function ChangeType({ portal, application, types, onChanged }: Inner) {
  const { t } = applicationCopy.useCopy();
  const [initialType, initialCountry] = offered(types, application.entityType, application.country);
  const [entityType, setEntityType] = useState<string>(initialType);
  const [country, setCountry] = useState(initialCountry);
  const [changed, setChanged] = useState(false);
  const same = entityType === application.entityType && country === application.country;
  return (
    <section aria-label={t('changeTitle')}>
      <h3>{t('changeTitle')}</h3>
      <p className="lt-hint">{t('changeBody')}</p>
      {types.length > 0 && (
        <TypeAndCountry
          types={types}
          entityType={entityType}
          country={country}
          onChange={(type, code) => {
            setEntityType(type);
            setCountry(code);
            setChanged(false);
          }}
        />
      )}
      <Actions>
        <PortalReview
          title={t('changeButton')}
          variant="secondary"
          description={t('changeBody')}
          perform={() => portal.kybApplicationChangeType(application.applicationId, entityType, country)}
          onConfirmed={(next) => {
            setChanged(true);
            onChanged(next, true);
          }}
          disabled={same}
          disabledReason={t('changeSame')}
        />
        <PortalReview
          title={t('restart')}
          variant="secondary"
          description={t('restartBody')}
          perform={() => portal.kybApplicationRestart(application.applicationId)}
          onConfirmed={(next) => onChanged(next, true)}
        />
      </Actions>
      {changed && <p role="status">{t('changed')}</p>}
    </section>
  );
}

// ---- one write at a time, with its outcome in words ------------------------------------------------------

type SavedKey = 'saved' | 'savedDone' | 'uploaded';
type Saver = ReturnType<typeof useSaver>;

function useSaver() {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const { t } = applicationCopy.useCopy();
  const run = async <D,>(call: () => Promise<ApiResult<D>>, then: (data: D) => void, done?: SavedKey, vars?: Record<string, string>) => {
    setBusy(true);
    setNote(null);
    try {
      const result = await call();
      if (result.ok) {
        setNote(done ? { ok: true, text: t(done, vars as never) } : null);
        then(result.data);
      } else setNote({ ok: false, text: result.message });
    } finally {
      setBusy(false);
    }
  };
  return { busy, note, run };
}

function SaverNote({ saver }: { saver: Saver }) {
  if (!saver.note) return null;
  return saver.note.ok ? <p role="status">{saver.note.text}</p> : <p role="alert">{saver.note.text}</p>;
}

function SaveRow({ saver, done }: { saver: Saver; done: boolean }) {
  const { t } = applicationCopy.useCopy();
  return (
    <>
      <Actions>
        <Button tone="primary" type="submit" disabled={saver.busy}>
          {t('save')}
        </Button>
      </Actions>
      {!done && <p className="lt-hint">{t('saveFixFirst')}</p>}
      <SaverNote saver={saver} />
    </>
  );
}

export type { ApplicationSection };
