import React, { useEffect, useReducer, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createJourney } from './journey';
import { HaloInput, HaloTextarea } from './components/halo-input';
import { HaloField, HaloFieldLabel, HaloFieldContent, HaloFieldDescription, HaloFieldError } from './components/halo-field';
import { GradientButtonGroup } from './components/gradient-button-group';
import { HaloToggleGroup } from './components/halo-toggle-group';
import { HaloProgress } from './components/halo-progress';
import { PrimaryMetal } from './components/primary-metal';
import { TextAnimate } from './components/text-animate';
import { BlurFade } from './components/blur-fade';
import logo from '../../../vendor/upstream-exchange/05_Web_Front/src/assets/images/logo.svg';
import './outreach.css';

function TextField({ id, label, help, multiline, hideLabel, ...props }: any) {
  const [invalid, setInvalid] = useState(false);
  const [validationMessage, setValidationMessage] = useState('');
  const Control = multiline ? HaloTextarea : HaloInput;
  const check = (event: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setInvalid(!event.currentTarget.validity.valid);
    setValidationMessage(event.currentTarget.validationMessage);
    props.onBlur?.(event);
  };
  return (
    <HaloField data-invalid={invalid || undefined}>
      <HaloFieldLabel htmlFor={id} className={hideLabel ? 'sr-only' : undefined}>
        {label}
      </HaloFieldLabel>
      <HaloFieldContent>
        <Control
          {...props}
          id={id}
          invalid={invalid}
          aria-describedby={[help && `${id}-help`, invalid && `${id}-error`].filter(Boolean).join(' ') || undefined}
          onInvalid={(event: React.InvalidEvent<HTMLInputElement | HTMLTextAreaElement>) => {
            setInvalid(true);
            setValidationMessage(event.currentTarget.validationMessage);
          }}
          onBlur={check}
          onChange={(event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
            if (invalid && event.currentTarget.validity.valid) setInvalid(false);
            props.onChange?.(event);
          }}
        />
        {help && <HaloFieldDescription id={`${id}-help`}>{help}</HaloFieldDescription>}
        {invalid && <HaloFieldError id={`${id}-error`}>{validationMessage}</HaloFieldError>}
      </HaloFieldContent>
    </HaloField>
  );
}

function App() {
  const [, refresh] = useReducer((value) => value + 1, 0);
  const [vm] = useState<any>(() => createJourney(refresh));
  const welcomePlayed = useRef(false);
  const [entryReveal, setEntryReveal] = useState(true);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      welcomePlayed.current = true;
      setEntryReveal(false);
    }, 700);
    return () => window.clearTimeout(timer);
  }, []);
  const contactValue = (key: string, value: unknown) => {
    vm.contact[key] = value;
    refresh();
  };
  const act = (key: string, ...args: unknown[]) => {
    welcomePlayed.current = true;
    setEntryReveal(false);
    void vm.act(key, ...args);
  };
  const begin = () => {
    welcomePlayed.current = true;
    act('begin');
  };
  const answer = (key: string, value: unknown) => vm.setAnswer(key, value);
  const submit = (key: string) => (event: React.FormEvent) => {
    event.preventDefault();
    if (key === 'advance' && vm.visibleFields.some((field: any) => field.type === 'select' && !vm.answers[field.key])) {
      vm.error = 'Choose an option to continue.';
      refresh();
      return;
    }
    act(key);
  };
  const toggle = (key: string, value: string) => {
    const values = vm.answers[key] || [];
    answer(key, values.includes(value) ? values.filter((item: string) => item !== value) : values.concat(value));
  };
  const interest = (key: string, captured = false) => {
    const values = captured ? vm.selectedInterests : vm.contact.interests;
    const next = values.includes(key) ? values.filter((value: string) => value !== key) : values.concat(key);
    if (captured) vm.selectedInterests = next;
    else vm.contact.interests = next;
    refresh();
  };
  const primary = (label: string, method?: string, disabled = false) => (
    <PrimaryMetal
      type={method ? 'button' : 'submit'}
      label={label}
      busy={vm.busy}
      disabled={disabled}
      onClick={method ? () => act(method) : undefined}
    />
  );
  const back = (method?: string, ...args: unknown[]) => (
    <button
      type="button"
      className="outreach-text-button"
      disabled={vm.busy}
      onClick={() => {
        if (method) act(method, ...args);
        else {
          vm.screen = 'welcome';
          refresh();
        }
      }}
    >
      ← Back
    </button>
  );
  const interests = (captured = false) => (
    <form key={captured ? 'append-interest' : 'initial-interest'} onSubmit={submit(captured ? 'saveInterests' : 'confirmInterests')}>
      <fieldset disabled={vm.busy}>
        <legend>
          What interests you? <small>Select one or more.</small>
        </legend>
        <GradientButtonGroup
          label="Select your interests"
          items={vm.audiences.map((item: any) => ({
            id: item.key,
            label: item.label,
            description: item.description,
            disabled: captured && (vm.draft.contact.interests.includes(item.key) || !!vm.state.local.extension),
          }))}
          value={captured ? vm.selectedInterests : vm.contact.interests}
          disabled={vm.busy}
          onValueChange={(value) => {
            if (captured) vm.selectedInterests = value;
            else vm.contact.interests = value;
            refresh();
          }}
        />
      </fieldset>
      {captured && <p className="outreach-small">Your saved interests and original answers stay preserved.</p>}
      <div className="outreach-actions">
        {captured ? (
          <button type="button" className="outreach-text-button" onClick={() => act('closeInterests')}>
            Cancel
          </button>
        ) : (
          back()
        )}
        {primary(captured ? 'Add & continue' : 'Continue', undefined, captured ? !vm.newInterests.length : !vm.contact.interests.length)}
      </div>
    </form>
  );
  const question = () => (
    <form key={`${vm.currentAudience}:${vm.group}`} onSubmit={submit('advance')}>
      <div className="outreach-questions">
        {vm.visibleFields.map((field: any) => (
          <React.Fragment key={field.key}>
            {field.type === 'select' && field.options.length <= 3 ? (
              <HaloToggleGroup
                className="question-choice-well"
                aria-label={field.label}
                items={field.options.map(([value, label]: string[]) => ({ value, label }))}
                value={vm.answers[field.key]}
                onValueChange={(value) => answer(field.key, value)}
                disabled={vm.busy}
              />
            ) : field.type === 'checks' ? (
              <fieldset disabled={vm.busy}>
                <legend className="sr-only">{field.label}</legend>
                {field.options.map(([value, label]: string[]) => (
                  <label className="interest-choice" key={value} data-selected={vm.answers[field.key].includes(value) || undefined}>
                    <input
                      type="checkbox"
                      value={value}
                      checked={vm.answers[field.key].includes(value)}
                      onChange={() => toggle(field.key, value)}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </fieldset>
            ) : field.type === 'countries' ? (
              <fieldset disabled={vm.busy}>
                <legend className="sr-only">{field.label}</legend>
                <TextField
                  id="country-search"
                  label="Find operating countries"
                  type="search"
                  placeholder="Find a country"
                  value={vm.countrySearch}
                  onChange={(event: any) => {
                    vm.countrySearch = event.target.value;
                    refresh();
                  }}
                />
                <label className="sr-only" htmlFor="operating-countries">
                  {field.label}
                </label>
                <select
                  id="operating-countries"
                  multiple
                  size={5}
                  required
                  value={vm.answers[field.key]}
                  onChange={(event) =>
                    answer(
                      field.key,
                      Array.from(event.target.selectedOptions, (option) => option.value),
                    )
                  }
                >
                  {vm.filteredCountries.map((item: any) => (
                    <option key={item.code} value={item.code}>
                      {item.name}
                    </option>
                  ))}
                </select>
                <p className="outreach-small">Choose one or more. {vm.answers[field.key].map(vm.countryLabel).join(', ')}</p>
              </fieldset>
            ) : field.type === 'select' ? (
              <label>
                <span className="sr-only">{field.label}</span>
                <select
                  value={vm.answers[field.key]}
                  onChange={(event) => answer(field.key, event.target.value)}
                  required
                  disabled={vm.busy}
                >
                  <option disabled value="">
                    Select an option
                  </option>
                  {field.options.map(([value, label]: string[]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                {field.key === 'investorType' && (
                  <small className="field-help">Choose your own profile or the organisation you represent.</small>
                )}
              </label>
            ) : (
              <TextField
                id={`outreach-${vm.currentAudience}-${field.key}`}
                label={field.label}
                hideLabel
                value={vm.answers[field.key]}
                onChange={(event: any) => answer(field.key, event.target.value)}
                onBlur={(event: any) => answer(field.key, event.target.value.trim())}
                type={field.type === 'url' ? 'url' : 'text'}
                multiline={field.type === 'textarea'}
                maxLength={field.max}
                required={!['website', 'scope'].includes(field.key)}
                disabled={vm.busy}
              />
            )}
          </React.Fragment>
        ))}
        {vm.questionStep?.kind === 'amount' && (
          <fieldset disabled={vm.busy}>
            <legend className="sr-only">
              {vm.currentAudience === 'investor' ? 'What amount are you considering?' : 'Processing volume'}
            </legend>
            <p className="outreach-small">
              An estimate is fine. You can leave this undecided. This is context for discussion, not a payment or commitment.
            </p>
            <HaloToggleGroup
              aria-label="Amount preference"
              value={vm.answers.amountStatus}
              items={[
                {
                  value: vm.currentAudience === 'investor' ? 'undecided' : 'unknown',
                  label: vm.currentAudience === 'investor' ? 'Not decided yet' : 'Not sure yet',
                },
                { value: 'stated', label: 'Share an indicative amount' },
              ]}
              onValueChange={(value) => answer('amountStatus', value)}
              disabled={vm.busy}
            />
            {vm.answers.amountStatus === 'stated' && (
              <div className="outreach-grid">
                <TextField
                  id="amount"
                  label="Amount"
                  value={vm.answers.amount}
                  onChange={(event: any) => answer('amount', event.target.value)}
                  type="text"
                  inputMode="decimal"
                  pattern="(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?"
                  maxLength={60}
                  required
                  help="Use digits and an optional decimal point. No commas or currency symbols."
                />
                <label>
                  Currency
                  <select
                    aria-label="Currency"
                    value={vm.answers.currency}
                    onChange={(event) => answer('currency', event.target.value)}
                    required
                  >
                    <option disabled value="">
                      Choose currency
                    </option>
                    {vm.filteredCurrencies.map((item: any) => (
                      <option key={item.code} value={item.code}>
                        {item.name} · {item.code}
                      </option>
                    ))}
                  </select>
                </label>
                <TextField
                  id="currency-search"
                  label="Find a currency"
                  type="search"
                  placeholder="Search by name or code"
                  value={vm.currencySearch}
                  onChange={(event: any) => {
                    vm.currencySearch = event.target.value;
                    refresh();
                  }}
                />
                {vm.currentAudience === 'merchant' && (
                  <label>
                    Volume period
                    <select
                      aria-label="Volume period"
                      value={vm.answers.period}
                      onChange={(event) => answer('period', event.target.value)}
                      required
                    >
                      <option disabled value="">
                        Choose period
                      </option>
                      {['daily', 'monthly', 'annual'].map((value) => (
                        <option key={value} value={value}>
                          {value[0].toUpperCase() + value.slice(1)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            )}
          </fieldset>
        )}
        {vm.questionStep?.kind === 'timing' && (
          <label>
            <span className="sr-only">When would you consider taking part?</span>
            <select value={vm.answers.timing} onChange={(event) => answer('timing', event.target.value)} required disabled={vm.busy}>
              <option disabled value="">
                Select an option
              </option>
              {vm.timing.map(([value, label]: string[]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        )}
        {vm.questionStep?.kind === 'message' && (
          <TextField
            id="outreach-message"
            label="What would you like us to know?"
            hideLabel
            multiline
            rows={3}
            value={vm.answers.message}
            onChange={(event: any) => answer('message', event.target.value)}
            maxLength={2000}
            disabled={vm.busy}
            placeholder="A question, an introduction, or a little more context."
          />
        )}
      </div>
      <div className="outreach-actions">
        {vm.group ? back('goGroup', vm.group - 1) : back()}
        {primary(vm.group === vm.reviewIndex - 1 ? 'Review your answers' : 'Continue')}
      </div>
    </form>
  );
  return (
    <div
      className={`outreach-page invitation-theme dark ${vm.screen === 'welcome' ? 'is-welcome' : ''} ${entryReveal ? 'entry-reveal' : ''}`}
      data-framework="react"
    >
      <a className="skip-link" href={vm.screen === 'welcome' ? '#welcome-title' : '#intake-heading'}>
        Skip to main content
      </a>
      <picture className="invitation-scene" aria-hidden="true">
        <img src={vm.heroDesktop} alt="" width={1672} height={941} decoding="async" fetchPriority="high" />
      </picture>
      <header className="invitation-header">
        <a href="/join" aria-label="INTAFACED">
          <img src={logo} alt="INTAFACED" width={150} height={35} />
        </a>
        <button
          type="button"
          className="outreach-text-button"
          disabled={vm.busy || !vm.storageReady}
          onClick={() => act('changeInterests')}
        >
          Other interests <span aria-hidden="true">↗</span>
        </button>
      </header>
      {(vm.expiredDraft || vm.state.expired) && (
        <p className="outreach-notice expiry-notice" role="status">
          Your previous draft access expired. You can start a new enquiry.
        </p>
      )}
      {vm.screen === 'welcome' ? (
        <section role="main" className="outreach-welcome" aria-labelledby="welcome-title">
          <div className="welcome-content">
            {welcomePlayed.current ? (
              <h1
                id="welcome-title"
                tabIndex={-1}
                ref={(node) => {
                  vm.refs.welcomeTitle = node;
                }}
              >
                A conversation
                <br />
                about INTAFACED.
              </h1>
            ) : (
              <TextAnimate
                id="welcome-title"
                tabIndex={-1}
                as="h1"
                by="line"
                animation="blurInUp"
                accessible
                once
                startOnView={false}
                delay={0.09}
                duration={0.16}
                variants={{
                  hidden: { opacity: 0, y: 6, filter: 'blur(4px)' },
                  show: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { duration: 0.22, ease: 'easeOut' } },
                }}
              >
                {'A conversation\nabout INTAFACED.'}
              </TextAnimate>
            )}
            <p className="welcome-description">Tell us how you’d like to take part.</p>
            <div className="welcome-action">
              <PrimaryMetal
                className="welcome-cta"
                type="button"
                onClick={begin}
                label={vm.resumeAvailable ? 'Continue your enquiry' : 'Begin'}
              >
                ↗
              </PrimaryMetal>
            </div>
            <p className="outreach-small">
              {vm.resumeAvailable ? 'A previous enquiry is available in this browser.' : 'No account needed. No investment commitment.'}
            </p>
          </div>
        </section>
      ) : (
        <section role="main" className="outreach-workspace" aria-busy={vm.busy} aria-labelledby="intake-heading">
          <div className="outreach-form-panel">
            <p id="question-progress-label" className="outreach-eyebrow">
              {vm.progressLabel}
            </p>
            {vm.currentAudience && !vm.interestsOpen && !vm.interestChangeRequested && !vm.complete && (
              <HaloProgress
                className="invitation-progress"
                value={vm.group}
                max={vm.reviewIndex}
                aria-label={
                  vm.isReview
                    ? 'Answers ready for review; not submitted yet'
                    : `Question ${vm.group + 1} of ${vm.reviewIndex}; answers not submitted yet`
                }
                aria-valuetext={
                  vm.isReview
                    ? 'Answers ready for review; not submitted yet.'
                    : `Question ${vm.group + 1} of ${vm.reviewIndex}; answers not submitted yet.`
                }
              />
            )}
            <h1
              id="intake-heading"
              tabIndex={-1}
              ref={(node) => {
                vm.refs.stepHeading = node;
              }}
            >
              {vm.stepTitle}
            </h1>
            {vm.error && (
              <p
                className="outreach-notice"
                role="alert"
                tabIndex={-1}
                ref={(node) => {
                  vm.refs.error = node;
                }}
              >
                {vm.error}
              </p>
            )}
            {!vm.state.storageAvailable && (
              <p className="outreach-notice" role="status">
                Your progress cannot be stored in this browser. Keep this page open to finish; closing or refreshing may lose your access.
              </p>
            )}
            {vm.continuationUnavailable && primary('Start a new enquiry', 'startNew')}
            <BlurFade
              key={
                vm.interestChangeRequested
                  ? 'recovery'
                  : vm.interestsOpen
                    ? 'interests'
                    : vm.currentAudience
                      ? `${vm.currentAudience}:${vm.group}`
                      : vm.draft
                        ? 'complete'
                        : 'contact'
              }
              duration={0.2}
              offset={4}
              blur="2px"
            >
              {vm.resumeAvailable && (!vm.draft || vm.interestChangeRequested) ? (
                <div className="outreach-resume">
                  <p>Continue the enquiry saved in this browser. Your answers will be shown after we check your access.</p>
                  <PrimaryMetal
                    type="button"
                    label="Reopen saved enquiry"
                    busyLabel="Opening…"
                    busy={vm.busy}
                    onClick={() => act('reopen')}
                  />
                  <button type="button" className="outreach-text-button" disabled={vm.busy} onClick={() => act('startNew')}>
                    Start a new enquiry
                  </button>
                </div>
              ) : !vm.draft && vm.interestsOpen ? (
                interests()
              ) : !vm.draft ? (
                <form key="contact" onSubmit={submit('saveContact')}>
                  <p className="section-description">
                    Your details will be saved so the team can follow up, even if you finish the questions later.
                  </p>
                  <div className="selected-interest-summary">
                    <span>{vm.contact.interests.map(vm.audienceLabel).join(' · ')}</span>
                    <button
                      type="button"
                      className="outreach-text-button"
                      disabled={vm.busy || !vm.storageReady}
                      onClick={() => act('changeInterests')}
                    >
                      Change interests
                    </button>
                  </div>
                  <div className="outreach-grid">
                    <TextField
                      id="outreach-name"
                      label="Your name"
                      name="name"
                      autoComplete="name"
                      placeholder="Full name"
                      maxLength={120}
                      required
                      disabled={vm.busy}
                      value={vm.contact.name}
                      onChange={(event: any) => contactValue('name', event.target.value)}
                      onBlur={(event: any) => contactValue('name', event.target.value.trim())}
                    />
                    <TextField
                      id="outreach-email"
                      label="Email"
                      name="email"
                      type="email"
                      autoComplete="email"
                      placeholder="you@example.com"
                      maxLength={254}
                      required
                      disabled={vm.busy}
                      help="We’ll use this address to reply about your enquiry."
                      value={vm.contact.email}
                      onChange={(event: any) => contactValue('email', event.target.value)}
                      onBlur={(event: any) => contactValue('email', event.target.value.trim())}
                    />
                  </div>
                  <details className="optional-details">
                    <summary>Optional details &amp; preferences</summary>
                    <div className="outreach-grid">
                      <TextField
                        id="organisation"
                        label="Organisation (optional)"
                        name="organization"
                        autoComplete="organization"
                        maxLength={160}
                        disabled={vm.busy}
                        value={vm.contact.organisationName}
                        onChange={(event: any) => contactValue('organisationName', event.target.value)}
                      />
                      <label>
                        Country <small>Optional</small>
                        <select
                          aria-label="Country"
                          autoComplete="country"
                          value={vm.contact.country}
                          disabled={vm.busy}
                          onChange={(event) => contactValue('country', event.target.value)}
                        >
                          <option value="">Prefer not to say</option>
                          {vm.countries.map((item: any) => (
                            <option key={item.code} value={item.code}>
                              {item.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <label className="outreach-consent">
                      <input
                        type="checkbox"
                        checked={vm.contact.marketingOptIn}
                        disabled={vm.busy}
                        onChange={(event) => contactValue('marketingOptIn', event.target.checked)}
                      />
                      <span>Send me INTAFACED news and updates.</span>
                    </label>
                    <p className="outreach-small">Optional marketing permission is separate from replies about this enquiry.</p>
                    <details className="recovery-options">
                      <summary>
                        Draft recovery <span>Optional</span>
                      </summary>
                      <label className="outreach-consent">
                        <input
                          type="checkbox"
                          checked={vm.remember}
                          disabled={vm.busy || !vm.persistentAvailable}
                          onChange={(event) => vm.setRemember(event.target.checked)}
                        />
                        <span>Remember my draft on this device.</span>
                      </label>
                      <p className="outreach-small">
                        {vm.persistentAvailable
                          ? 'An encrypted draft lets you close this tab and return on this device. Leave this off on a shared device.'
                          : 'Device recovery is unavailable in this browser. Keep this tab open to finish.'}
                      </p>
                    </details>
                  </details>
                  <div className="outreach-actions">
                    {back()}
                    {primary('Save details & continue', undefined, !vm.storageReady)}
                  </div>
                  <p className="outreach-small">
                    By continuing, you ask INTAFACED to review and reply to your enquiry.{' '}
                    <button
                      type="button"
                      className="outreach-inline-link"
                      onClick={() => {
                        vm.privacyOpen = true;
                        refresh();
                      }}
                    >
                      Privacy &amp; contact
                    </button>
                  </p>
                </form>
              ) : vm.interestsOpen ? (
                interests(true)
              ) : vm.currentAudience ? (
                <>
                  {vm.isReview ? (
                    <div className="outreach-review">
                      <p className="section-description">
                        Take a moment to check your answers. Once saved, your original responses stay preserved.
                      </p>
                      <dl>
                        {vm.reviewRows.map((row: any) => (
                          <div key={row.label}>
                            <dt>{row.label}</dt>
                            <dd>{row.value}</dd>
                          </div>
                        ))}
                      </dl>
                      <div className="outreach-actions">
                        <button type="button" className="outreach-text-button" disabled={vm.busy} onClick={() => act('goGroup', 0)}>
                          ← Edit answers
                        </button>
                        {primary('Send enquiry', 'saveAnswers')}
                      </div>
                    </div>
                  ) : (
                    question()
                  )}
                  <details className="recovery-options draft-recovery">
                    <summary>Draft and recovery</summary>
                    <p className="outreach-small" role="status">
                      {!vm.state.storageAvailable
                        ? 'Draft in this page'
                        : !vm.state.draftStored
                          ? 'Saving draft…'
                          : vm.remember
                            ? 'Draft kept on this device'
                            : 'Draft kept in this tab'}{' '}
                      · {vm.savedCount} of {vm.draft.contact.interests.length} questionnaires submitted.{' '}
                      <button type="button" className="outreach-inline-link" disabled={vm.busy} onClick={() => act('reopen')}>
                        Check saved progress
                      </button>
                    </p>
                  </details>
                </>
              ) : vm.complete ? (
                <div className="outreach-complete">
                  <div className="completion-mark" aria-hidden="true">
                    ✓
                  </div>
                  <p>
                    {vm.draft.contact.interests.includes('investor')
                      ? 'The team reviews enquiries before arranging calls.'
                      : 'The team will review your enquiry.'}{' '}
                    We’ll use {vm.draft.contact.email} for any follow-up.
                  </p>
                  <ul>
                    {vm.draft.contact.interests.map((key: string) => (
                      <li key={key}>
                        {vm.audienceLabel(key)} <span>Saved ✓</span>
                      </li>
                    ))}
                  </ul>
                  <button type="button" className="outreach-text-button" onClick={() => act('forget')}>
                    Forget this draft on my device
                  </button>
                </div>
              ) : (
                <div>
                  <p>Your answers are saved. Check the latest progress to continue.</p>
                  {primary('Check saved progress', 'reopen')}
                </div>
              )}
            </BlurFade>
            {vm.draft && !vm.interestChangeRequested && (
              <>
                {(vm.complete || vm.isReview) && <p className="outreach-small saved-summary">✓ {vm.savedStageMessage}</p>}
                <details className="saved-contact-details">
                  <summary>View your saved details</summary>
                  <dl>
                    <div>
                      <dt>Name</dt>
                      <dd>{vm.draft.contact.name}</dd>
                    </div>
                    <div>
                      <dt>Email</dt>
                      <dd>{vm.draft.contact.email}</dd>
                    </div>
                    {vm.draft.contact.organisationName && (
                      <div>
                        <dt>Organisation</dt>
                        <dd>{vm.draft.contact.organisationName}</dd>
                      </div>
                    )}
                    {vm.draft.contact.country && (
                      <div>
                        <dt>Country</dt>
                        <dd>{vm.countryLabel(vm.draft.contact.country)}</dd>
                      </div>
                    )}
                  </dl>
                  <p className="outreach-small">
                    These details are already saved.{' '}
                    {vm.publicInfo.contactUrl ? (
                      <>
                        For a correction, <a href={vm.publicInfo.contactUrl}>contact the INTAFACED team</a>.
                      </>
                    ) : (
                      'You can request a correction when the team follows up.'
                    )}
                  </p>
                  <button type="button" className="outreach-text-button" disabled={vm.busy} onClick={() => act('changeInterests')}>
                    Add an interest
                  </button>
                </details>
              </>
            )}
          </div>
        </section>
      )}
      <footer className="privacy-entry">
        <span>© INTAFACED</span>
        <button
          type="button"
          className="outreach-text-button"
          onClick={() => {
            vm.privacyOpen = true;
            refresh();
            requestAnimationFrame(() => vm.refs.privacyHeading?.focus());
          }}
        >
          Privacy &amp; your enquiry ↗
        </button>
      </footer>
      {vm.privacyOpen && (
        <section className="outreach-privacy" aria-labelledby="privacy-heading">
          <button
            type="button"
            className="outreach-text-button"
            onClick={() => {
              vm.privacyOpen = false;
              act('focusHeading');
            }}
          >
            ← Return to your enquiry
          </button>
          <h2
            id="privacy-heading"
            tabIndex={-1}
            ref={(node) => {
              vm.refs.privacyHeading = node;
            }}
          >
            Your enquiry, thoughtfully handled.
          </h2>
          <p>
            We collect your contact details, selected interests and the answers you choose to save so the INTAFACED team can review and
            reply to your enquiry. Optional marketing permission is separate.
          </p>
          <p>
            Your original saved answers stay with the team. A local draft helps you finish; it is not a confirmation that an answer has been
            submitted. Device recovery is optional, encrypted and limited to this browser. It cannot be transferred with a link or recovered
            by matching an email address.
          </p>
          {vm.draft && (
            <p>
              Local access expires {vm.expiryLabel}. You can forget it on this device at any time; this does not delete your saved enquiry.
            </p>
          )}
          <p>
            {vm.publicInfo.contactUrl ? (
              <>
                For questions about your saved enquiry or personal information,{' '}
                <a href={vm.publicInfo.contactUrl}>contact the INTAFACED team</a>.
              </>
            ) : (
              'You can ask about your saved information or request a correction when the team follows up.'
            )}
          </p>
          {vm.publicInfo.retentionNotice && <p>{vm.publicInfo.retentionNotice}</p>}
          {vm.resumeAvailable && primary('Forget local draft', 'forget')}
        </section>
      )}
    </div>
  );
}

const splash = document.getElementById('initLoading');
if (splash) splash.remove();
document.title = 'Join INTAFACED';
const container = document.getElementById('app');
if (!container) throw new Error('intake_root_unavailable');
createRoot(container).render(<App />);
