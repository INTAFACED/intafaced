import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useReducedMotion } from 'motion/react';
import { createJourney } from './journey';
import { HaloInput, HaloTextarea } from './components/halo-input';
import { HaloField, HaloFieldLabel, HaloFieldContent, HaloFieldDescription, HaloFieldError } from './components/halo-field';
import { GradientButtonGroup } from './components/gradient-button-group';
import { HaloToggleGroup } from './components/halo-toggle-group';
import { HaloProgress } from './components/halo-progress';
import { PrimaryMetal } from './components/primary-metal';
import { HeroMetal } from './components/hero-metal';
import { ChoiceCards } from './components/choice-cards';
import { SearchPicker, SearchPickerMulti, type PickerGroup, type PickerOption } from './components/search-picker';
import { BlurFade } from './components/blur-fade';
import { LivingBackdrop } from './components/living-backdrop';
import { AMOUNT_ERROR, groupAmount, parseAmount, storedAmount } from './lib/amount';
import heroPhone from '../../../vendor/upstream-exchange/05_Web_Front/src/assets/images/outreach/graphite-fins-phone.webp';
import logo from '../../../vendor/upstream-exchange/05_Web_Front/src/assets/images/logo.svg';
import './outreach.css';

function TextField({ id, label, help, multiline, hideLabel, inputRef, ...props }: any) {
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
          ref={inputRef}
          id={id}
          invalid={invalid}
          aria-describedby={[help && `${id}-help`, invalid && `${id}-error`].filter(Boolean).join(' ') || undefined}
          onInvalid={(event: React.InvalidEvent<HTMLInputElement | HTMLTextAreaElement>) => {
            setInvalid(true);
            setValidationMessage(event.currentTarget.validationMessage);
          }}
          onBlur={check}
          onChange={(event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
            // The caller may set a custom validity message, so read validity afterwards.
            props.onChange?.(event);
            if (invalid && event.currentTarget.validity.valid) setInvalid(false);
          }}
        />
        {help && <HaloFieldDescription id={`${id}-help`}>{help}</HaloFieldDescription>}
        {invalid && <HaloFieldError id={`${id}-error`}>{validationMessage}</HaloFieldError>}
      </HaloFieldContent>
    </HaloField>
  );
}

const POPULAR_CURRENCIES = ['USD', 'EUR', 'GBP', 'SGD', 'IDR', 'AUD', 'CHF', 'AED', 'JPY'];
const NO_COUNTRY: PickerOption = { value: '', label: 'Prefer not to say' };
// The contract's own email rule (outreach-intake buildContact): something@something.something
const CONTACT_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_ERROR = 'Enter a full email address, for example you@example.com.';
const NAME_ERROR = 'Enter your name.';

/** Accepts "150,000", "150 000" and "150000.50"; shows separators once the field is left; stores the plain string. */
function AmountField({ value, onValue, disabled }: { value: string; onValue: (plain: string) => void; disabled?: boolean }) {
  const [display, setDisplay] = useState(() => groupAmount(value));
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (storedAmount(display) !== value) setDisplay(groupAmount(value));
  }, [value]);
  // A remounted field (Back, forward, a returning visitor) must carry the message too, not only a field that was typed in.
  useEffect(() => {
    input.current?.setCustomValidity(parseAmount(display).kind === 'invalid' ? AMOUNT_ERROR : '');
  }, [display]);
  return (
    <TextField
      id="amount"
      label="Amount"
      value={display}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      maxLength={60}
      required
      disabled={disabled}
      inputRef={input}
      help="An estimate is fine."
      onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
        const typed = event.target.value;
        setDisplay(typed);
        event.target.setCustomValidity(parseAmount(typed).kind === 'invalid' ? AMOUNT_ERROR : '');
        onValue(storedAmount(typed));
      }}
      onBlur={(event: React.FocusEvent<HTMLInputElement>) => {
        const parsed = parseAmount(event.target.value);
        if (parsed.kind === 'valid') setDisplay(groupAmount(parsed.plain));
      }}
    />
  );
}

function App() {
  const [, refresh] = useReducer((value) => value + 1, 0);
  const [vm] = useState<any>(() => createJourney(refresh));
  const reduceMotion = useReducedMotion();
  const [completionReveal, setCompletionReveal] = useState<string | null>(null);
  const completionPlayed = useRef(new Set<string>());
  const freshCompletionIntent = useRef(false);
  useEffect(() => {
    if (!completionReveal) return;
    // CSS finishes at 700ms. Leave room for animationend delivery before
    // this defensive cleanup so a timer cannot cancel the final frame.
    const timer = window.setTimeout(() => setCompletionReveal(null), 1000);
    return () => window.clearTimeout(timer);
  }, [completionReveal]);
  const welcomePlayed = useRef(!!vm.resumeAvailable || document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [entryReveal, setEntryReveal] = useState(!welcomePlayed.current);
  // One start signal: every welcome delay in outreach.css is measured from `.entry-started`.
  // It fires when the backdrop's first frame is drawn, or after 800ms at most, so a slow
  // phone never sits on a black screen; a late backdrop then fades in late, never pops.
  const [entryStarted, setEntryStarted] = useState(false);
  useEffect(() => {
    const cap = window.setTimeout(() => setEntryStarted(true), 800);
    return () => window.clearTimeout(cap);
  }, []);
  // Read once: the welcome entrance plays only on a first, motion-allowed visit, and ?bg=photo
  // shows the photographic backdrop instead of the live light ribbons.
  const [backdrop] = useState(() => ({
    variant: new URLSearchParams(window.location.search).get('bg') === 'photo' ? ('photo' as const) : ('ribbons' as const),
    photo: window.matchMedia('(max-width: 699px)').matches ? heroPhone : vm.heroDesktop,
    entrance: !welcomePlayed.current,
  }));
  const [contactStep, setContactStep] = useState<1 | 2>(1);
  const [contactProblem, setContactProblem] = useState(0);
  const [privacyFocus, setPrivacyFocus] = useState(0);
  const currencyGroups = useMemo<PickerGroup[]>(() => {
    const option = (item: any): PickerOption => ({ value: item.code, label: `${item.name} · ${item.code}` });
    const popular = POPULAR_CURRENCIES.map((code) => vm.currencies.find((item: any) => item.code === code)).filter(Boolean);
    return [
      { value: 'popular', label: 'Popular', items: popular.map(option) },
      {
        value: 'all',
        label: 'All currencies',
        items: vm.currencies.filter((item: any) => !POPULAR_CURRENCIES.includes(item.code)).map(option),
      },
    ];
  }, [vm]);
  const countryOptions = useMemo<PickerOption[]>(() => vm.countries.map((item: any) => ({ value: item.code, label: item.name })), [vm]);
  const countryGroups = useMemo<PickerGroup[]>(
    () => [
      { value: 'none', items: [NO_COUNTRY] },
      { value: 'countries', items: countryOptions },
    ],
    [countryOptions],
  );
  const operatingGroups = useMemo<PickerGroup[]>(() => [{ value: 'countries', items: countryOptions }], [countryOptions]);
  const currencyOption = (code: string) => currencyGroups.flatMap((group) => group.items).find((item) => item.value === code) || null;
  const settleEntry = () => {
    welcomePlayed.current = true;
    setEntryReveal(false);
  };
  useEffect(() => {
    let mounted = true;
    // Decoration does not hold up the real storage check or Begin. A slow
    // check settles forward before the text's 220ms entrance, never rewinding.
    const grace = window.setTimeout(() => {
      if (!vm.storageReady) settleEntry();
    }, 100);
    void vm.ready.then(
      () => {
        if (!mounted) return;
        if (
          welcomePlayed.current ||
          vm.resumeAvailable ||
          vm.screen !== 'welcome' ||
          document.hidden ||
          window.matchMedia('(prefers-reduced-motion: reduce)').matches
        )
          settleEntry();
      },
      () => {
        if (mounted) settleEntry();
      },
    );
    const hidden = () => {
      if (document.hidden) settleEntry();
    };
    document.addEventListener('visibilitychange', hidden);
    return () => {
      mounted = false;
      window.clearTimeout(grace);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [vm]);
  useEffect(() => {
    if (reduceMotion) settleEntry();
  }, [reduceMotion]);
  useEffect(() => {
    if (!entryReveal || !entryStarted) return;
    // The final glow pulse's animationend settles a normal entry at ~2200ms.
    // This later cleanup only handles an interrupted animation/event delivery.
    const timer = window.setTimeout(settleEntry, 3000);
    return () => window.clearTimeout(timer);
  }, [entryReveal, entryStarted]);
  useEffect(() => {
    if (!contactProblem) return;
    // After the refreshed screen 1 has mounted (and after the error banner's own focus), land on the field at fault.
    const frame = requestAnimationFrame(() => {
      const nameMissing = !vm.contact.name.trim();
      const field = document.getElementById(nameMissing ? 'outreach-name' : 'outreach-email') as HTMLInputElement | null;
      if (!field) return;
      field.setCustomValidity(nameMissing ? NAME_ERROR : EMAIL_ERROR);
      field.focus();
      field.reportValidity();
    });
    return () => cancelAnimationFrame(frame);
  }, [contactProblem]);
  useEffect(() => {
    if (!privacyFocus) return;
    vm.refs.privacyHeading?.focus();
  }, [privacyFocus]);
  vm.onCompletionConfirmed = () => {
    if (!freshCompletionIntent.current || !vm.complete || vm.error) return;
    const receiptKey = `${vm.draft.submissionId}:${vm.draft.revision}`;
    if (completionPlayed.current.has(receiptKey)) return;
    completionPlayed.current.add(receiptKey);
    if (!reduceMotion) setCompletionReveal(receiptKey);
  };
  const contactValue = (key: string, value: unknown) => {
    vm.contact[key] = value;
    refresh();
  };
  const act = (key: string, ...args: unknown[]) => {
    // A second native click can arrive before React paints the disabled state.
    // Keep the first confirmed submission's presentation intent intact.
    if (key === 'saveAnswers' && vm.busy) return;
    settleEntry();
    const wasComplete = !!vm.complete;
    freshCompletionIntent.current = key === 'saveAnswers' && !wasComplete && !vm.busy && !vm.state.local?.answer;
    if (key !== 'saveAnswers') setCompletionReveal(null);
    void vm.act(key, ...args).then(() => {
      freshCompletionIntent.current = false;
      if (vm.error) setCompletionReveal(null);
      // The details were refused as invalid: the problem is on screen 1 (name or email), so go back and point at it.
      if (key === 'saveContact' && vm.errorCode === 'invalid_input') {
        setContactStep(1);
        setContactProblem((value) => value + 1);
      }
    });
  };
  const begin = () => {
    welcomePlayed.current = true;
    setContactStep(1);
    act('begin');
  };
  const openPrivacy = () => {
    vm.privacyOpen = true;
    refresh();
    setPrivacyFocus((value) => value + 1);
  };
  const goContactStep = (step: 1 | 2) => {
    setContactStep(step);
    requestAnimationFrame(() => vm.refs.stepHeading?.focus());
  };
  const answer = (key: string, value: unknown) => vm.setAnswer(key, value);
  const submit = (key: string) => (event: React.FormEvent) => {
    event.preventDefault();
    if (key === 'advance') {
      const kind = vm.questionStep?.kind;
      const stated = vm.answers.amountStatus === 'stated';
      const amount = kind === 'amount' && stated ? parseAmount(vm.answers.amount).kind : 'valid';
      const message =
        amount === 'invalid'
          ? AMOUNT_ERROR
          : amount === 'empty'
            ? 'Enter an amount, or choose the undecided option.'
            : vm.visibleFields.some((field: any) => field.type === 'select' && !vm.answers[field.key]) ||
                (kind === 'timing' && !vm.answers.timing)
              ? 'Choose an option to continue.'
              : kind === 'amount' && stated && !vm.answers.currency
                ? 'Choose a currency to continue.'
                : kind === 'amount' && stated && vm.currentAudience === 'merchant' && !vm.answers.period
                  ? 'Choose a volume period to continue.'
                  : '';
      if (message) {
        vm.error = message;
        refresh();
        if (amount !== 'valid') requestAnimationFrame(() => document.getElementById('amount')?.focus());
        return;
      }
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
                <SearchPickerMulti
                  id="operating-countries"
                  label={field.label}
                  hideLabel
                  placeholder="Search countries"
                  groups={operatingGroups}
                  value={vm.answers[field.key].map((code: string) => countryOptions.find((item) => item.value === code)).filter(Boolean)}
                  onValueChange={(items) =>
                    answer(
                      field.key,
                      items.map((item) => item.value),
                    )
                  }
                  disabled={vm.busy}
                />
                <p className="outreach-small picker-note">Choose one or more.</p>
              </fieldset>
            ) : field.type === 'select' ? (
              <>
                <ChoiceCards
                  label={field.label}
                  items={field.options.map(([value, label]: string[]) => ({ value, label }))}
                  value={vm.answers[field.key]}
                  onValueChange={(value) => answer(field.key, value)}
                  disabled={vm.busy}
                  describedBy={field.key === 'investorType' ? 'investor-type-help' : undefined}
                />
                {field.key === 'investorType' && (
                  <small id="investor-type-help" className="field-help">
                    Choose your own profile or the organisation you represent.
                  </small>
                )}
              </>
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
            <p className="outreach-small">You can leave this undecided. This is context for discussion, not a payment or commitment.</p>
            <HaloToggleGroup
              className="question-choice-well"
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
              <div className="outreach-grid amount-grid">
                <AmountField value={vm.answers.amount} onValue={(plain) => answer('amount', plain)} disabled={vm.busy} />
                <SearchPicker
                  id="currency"
                  label="Currency"
                  placeholder="e.g. EUR"
                  groups={currencyGroups}
                  value={currencyOption(vm.answers.currency)}
                  onValueChange={(item) => answer('currency', item ? item.value : '')}
                  disabled={vm.busy}
                />
                {vm.currentAudience === 'merchant' && (
                  <div className="amount-period">
                    <span id="volume-period-label" className="picker-label">
                      Volume period
                    </span>
                    <HaloToggleGroup
                      className="question-choice-well"
                      aria-label="Volume period"
                      value={vm.answers.period}
                      items={['daily', 'monthly', 'annual'].map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) }))}
                      onValueChange={(value) => answer('period', value)}
                      disabled={vm.busy}
                    />
                  </div>
                )}
              </div>
            )}
          </fieldset>
        )}
        {vm.questionStep?.kind === 'timing' && (
          <ChoiceCards
            label="When would you consider taking part?"
            items={vm.timing.map(([value, label]: string[]) => ({ value, label }))}
            value={vm.answers.timing}
            onValueChange={(value) => answer('timing', value)}
            disabled={vm.busy}
          />
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
  // The contact form is the two-screen details flow shown before a draft exists.
  const resumePanel = vm.resumeAvailable && (!vm.draft || vm.interestChangeRequested);
  const contactForm = !resumePanel && !vm.draft && !vm.interestsOpen;
  useEffect(() => {
    if (!contactForm && contactStep !== 1) setContactStep(1);
  }, [contactForm, contactStep]);
  const heading = contactForm && contactStep === 2 ? 'A little more, if you like.' : vm.stepTitle;
  const eyebrow = contactForm ? `YOUR DETAILS · ${contactStep} OF 2` : vm.progressLabel;
  const showDraftStatus = !!vm.draft && !!vm.currentAudience && !vm.interestsOpen && !vm.interestChangeRequested && !vm.complete;
  // "Draft", never a bare "Saved": nothing here has been sent. A draft kept only for this tab is said to be.
  const draftStatus = !vm.state.storageAvailable
    ? 'Not saved in this browser'
    : !vm.state.draftStored
      ? 'Saving…'
      : vm.remember
        ? 'Draft saved ✓'
        : 'Draft kept in this tab';
  // The visible text follows every keystroke; the spoken one waits until typing settles and never says "Saving…".
  const [spokenStatus, setSpokenStatus] = useState('');
  useEffect(() => {
    if (!showDraftStatus || draftStatus === 'Saving…') return;
    const timer = window.setTimeout(() => setSpokenStatus(draftStatus), 800);
    return () => window.clearTimeout(timer);
  }, [showDraftStatus, draftStatus]);
  const showDeviceDetails =
    !!vm.draft && !vm.interestChangeRequested && !vm.interestsOpen && (vm.complete || !vm.currentAudience || vm.isReview);
  const logoLink = (width: number, className: string) => (
    <a className={`brand-logo ${className}`} href="/join" aria-label="INTAFACED">
      <img src={logo} alt="INTAFACED" width={width} height={Math.round((width * 35) / 150)} />
    </a>
  );
  // Screen 1 sends nothing and promises nothing: only the way to the notice. The sentence belongs where data is sent.
  const privacyLine = (full: boolean) => (
    <p className="outreach-small">
      {full ? 'By continuing, you ask INTAFACED to review and reply to your enquiry.' : 'How we handle your details:'}{' '}
      <button type="button" className="outreach-inline-link" onClick={openPrivacy}>
        Privacy &amp; contact
      </button>
    </p>
  );
  const contact = () =>
    contactStep === 1 ? (
      <form
        key="contact-1"
        onSubmit={(event) => {
          event.preventDefault();
          // type="email" lets "investor@gmail" through; the contract needs a dot in the domain. Say so here, on the field.
          const problem = !vm.contact.name.trim() ? 'outreach-name' : !CONTACT_EMAIL.test(vm.contact.email.trim()) ? 'outreach-email' : '';
          if (problem) {
            const field = event.currentTarget.querySelector<HTMLInputElement>('#' + problem);
            if (field) {
              field.setCustomValidity(problem === 'outreach-name' ? NAME_ERROR : EMAIL_ERROR);
              field.focus();
              field.reportValidity();
            }
            return;
          }
          goContactStep(2);
        }}
      >
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
            onChange={(event: any) => {
              event.target.setCustomValidity('');
              contactValue('name', event.target.value);
            }}
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
            onChange={(event: any) => {
              event.target.setCustomValidity('');
              contactValue('email', event.target.value);
            }}
            onBlur={(event: any) => contactValue('email', event.target.value.trim())}
          />
        </div>
        <div className="outreach-actions">
          {back()}
          {primary('Continue')}
        </div>
        {privacyLine(false)}
      </form>
    ) : (
      <form key="contact-2" onSubmit={submit('saveContact')}>
        <p className="section-description">Everything on this page is optional. You can leave it blank and continue.</p>
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
          <SearchPicker
            id="country"
            label="Country (optional)"
            placeholder="Prefer not to say"
            groups={countryGroups}
            value={vm.contact.country ? countryOptions.find((item) => item.value === vm.contact.country) || NO_COUNTRY : NO_COUNTRY}
            onValueChange={(item) => contactValue('country', item ? item.value : '')}
            disabled={vm.busy}
            emptyText="No match. Try a country name."
          />
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
        <p className="outreach-small save-note">
          Your details will be saved so the team can follow up, even if you finish the questions later.
        </p>
        <div className="outreach-actions">
          <button type="button" className="outreach-text-button" disabled={vm.busy} onClick={() => goContactStep(1)}>
            ← Back
          </button>
          {primary('Save details & continue', undefined, !vm.storageReady)}
        </div>
        {privacyLine(true)}
      </form>
    );
  const deviceDetails = () => (
    <details className="saved-contact-details">
      <summary>Your details &amp; this device</summary>
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
      <p className="outreach-small device-status">
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
      <button type="button" className="outreach-text-button" disabled={vm.busy} onClick={() => act('forget')}>
        Forget this draft on my device
      </button>
      <p className="outreach-small">
        <button type="button" className="outreach-inline-link" onClick={openPrivacy}>
          Privacy
        </button>
      </p>
    </details>
  );
  return (
    <div
      className={`outreach-page invitation-theme dark ${vm.screen === 'welcome' ? 'is-welcome' : ''} ${entryReveal ? 'entry-reveal' : ''} ${entryStarted ? 'entry-started' : ''}`}
      data-framework="react"
    >
      <a className="skip-link" href={vm.screen === 'welcome' ? '#welcome-title' : '#intake-heading'}>
        Skip to main content
      </a>
      <LivingBackdrop
        variant={backdrop.variant}
        photoSrc={backdrop.photo}
        dim={vm.screen !== 'welcome'}
        entrance={backdrop.entrance}
        onReady={() => setEntryStarted(true)}
      />
      {(vm.expiredDraft || vm.state.expired) && (
        <p className="outreach-notice expiry-notice" role="status">
          Your previous draft access expired. You can start a new enquiry.
        </p>
      )}
      {vm.screen === 'welcome' ? (
        <section role="main" className="outreach-welcome" aria-labelledby="welcome-title">
          <div className="welcome-content">
            {logoLink(112, 'welcome-logo')}
            <h1
              id="welcome-title"
              tabIndex={-1}
              ref={(node) => {
                vm.refs.welcomeTitle = node;
              }}
            >
              <span className="h1-line" style={{ '--line': 0 } as React.CSSProperties}>
                A conversation
              </span>{' '}
              <span className="h1-line" style={{ '--line': 1 } as React.CSSProperties}>
                about INTAFACED.
              </span>
            </h1>
            <p className="welcome-description">Tell us how you’d like to take part.</p>
            <div
              className="welcome-action"
              onAnimationEnd={(event) => {
                if (event.animationName === 'invitation-action-emphasis') settleEntry();
              }}
            >
              <HeroMetal type="button" onClick={begin} label={vm.resumeAvailable ? 'Continue your enquiry' : 'Begin'} />
            </div>
            <p className="outreach-small">
              {/* Each sentence wraps as a unit, so a phone never strands a lone "No" at a line end. */}
              {(vm.resumeAvailable
                ? ['A previous enquiry is available in this browser.']
                : ['No account needed.', 'No investment commitment.']
              ).map((sentence: string) => (
                <React.Fragment key={sentence}>
                  <span className="nowrap">{sentence}</span>{' '}
                </React.Fragment>
              ))}
              <button type="button" className="outreach-inline-link" onClick={openPrivacy}>
                Privacy
              </button>
            </p>
          </div>
        </section>
      ) : (
        <section role="main" className="outreach-workspace" aria-busy={vm.busy} aria-labelledby="intake-heading">
          <div className="outreach-form-panel">
            {logoLink(112, 'form-logo')}
            <div className="outreach-eyebrow-row">
              <p id="question-progress-label" className="outreach-eyebrow">
                {eyebrow}
              </p>
              {showDraftStatus && (
                <>
                  <span className="draft-status" aria-hidden="true" data-state={draftStatus}>
                    {draftStatus}
                  </span>
                  <span className="sr-only draft-status-live" role="status" aria-live="polite">
                    {spokenStatus}
                  </span>
                </>
              )}
            </div>
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
              {heading}
            </h1>
            {!vm.storageReady && (
              <p className="outreach-small" role="status">
                Checking saved progress in this browser. You can enter your details while this finishes.
              </p>
            )}
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
                        : `contact-${contactStep}`
              }
              {...(vm.complete ? { initial: false } : {})}
              duration={vm.complete ? 0 : 0.2}
              offset={vm.complete ? 0 : 4}
              blur={vm.complete ? '0px' : '2px'}
            >
              {resumePanel ? (
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
                contact()
              ) : vm.interestsOpen ? (
                interests(true)
              ) : vm.currentAudience ? (
                vm.isReview ? (
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
                )
              ) : vm.complete ? (
                <div
                  className={`outreach-complete${completionReveal === `${vm.draft.submissionId}:${vm.draft.revision}` ? ' completion-enter' : ''}`}
                  data-completion-state={completionReveal ? 'entering' : 'static'}
                  onAnimationEnd={(event) => {
                    if (event.animationName === 'invitation-completion-copy') setCompletionReveal(null);
                  }}
                >
                  <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
                    Your enquiry is saved.
                  </span>
                  <svg className="completion-mark" viewBox="0 0 48 48" fill="none" aria-hidden="true">
                    <circle className="completion-outline" cx="24" cy="24" r="20" stroke="currentColor" strokeWidth="1" pathLength="1" />
                    <path
                      className="completion-check"
                      d="M15 24.5 21.5 31 33 17.5"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      pathLength="1"
                    />
                  </svg>
                  <div className="completion-receipt-copy">
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
                  </div>
                </div>
              ) : (
                <div>
                  <p>Your answers are saved. Check the latest progress to continue.</p>
                  {primary('Check saved progress', 'reopen')}
                </div>
              )}
            </BlurFade>
            {vm.isReview && vm.draft && !vm.interestChangeRequested && vm.currentAudience && (
              <p className="outreach-small saved-summary">✓ {vm.savedStageMessage}</p>
            )}
            {showDeviceDetails && deviceDetails()}
          </div>
        </section>
      )}
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
