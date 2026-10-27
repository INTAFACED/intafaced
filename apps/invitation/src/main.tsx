import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useReducedMotion } from 'motion/react';
import { createJourney } from './journey';
import { HaloInput, HaloTextarea } from './components/halo-input';
import { HaloField, HaloFieldLabel, HaloFieldContent, HaloFieldDescription, HaloFieldError } from './components/halo-field';
import { GradientButtonGroup } from './components/gradient-button-group';
import { HaloProgress } from './components/halo-progress';
import { PrimaryMetal } from './components/primary-metal';
import { HeroMetal } from './components/hero-metal';
import { ArrowLeft, Check } from './components/icons';
import { CheckCard, ChoiceCards } from './components/choice-cards';
import { SearchPicker, SearchPickerMulti, type PickerGroup, type PickerOption } from './components/search-picker';
import { BlurFade } from './components/blur-fade';
import { LivingBackdrop } from './components/living-backdrop';
import { AMOUNT_ERROR, amountAmbiguity, groupAmount, parseAmount, storedAmount } from './lib/amount';
import heroPhone from './vendored/assets/images/outreach/graphite-fins-phone.webp';
// The owner's kit: this app's copy of packages/ui/brand (kept in step by packages/ui/scripts/brand-sync.mjs, checked by
// its test), bundled into /assets/ like any image.
import lockupStacked from '../public/brand/lockup-stacked.svg';
import lockupBar from '../public/brand/lockup-topbar.svg';
import './outreach.css';
import { WaitlistPage } from './waitlist';

/** Our own wording for what the browser would otherwise say in its own language. */
const REQUIRED_ERROR = 'Please answer this to continue.';
const FORMAT_ERROR = 'Check the format of this answer.';
type TextControl = HTMLInputElement | HTMLTextAreaElement;
const isTextControl = (element: Element): element is TextControl =>
  element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;

/**
 * Forms are `noValidate`, so the browser never opens its own bubble (in its own language). This is the one place a
 * submit looks at the controls: it marks ONLY the first invalid text field, with our own copy, and moves focus to it.
 * `checkValidity()` fires the field's `invalid` event; `reportValidity()` is never used because it opens the bubble.
 */
function flagFirstInvalid(form: HTMLFormElement): boolean {
  const first = Array.from(form.elements).find((element) => isTextControl(element) && !element.disabled && !element.validity.valid);
  if (!first || !isTextControl(first)) return false;
  first.checkValidity();
  first.focus();
  return true;
}

/**
 * A text field. Errors are ours, not the browser's. Missing-value errors wait for the first submit; a format error on a
 * field that has something in it shows as soon as the field is left. `missing` and `mismatch` are the field's own copy.
 */
function TextField({ id, label, help, below, describedBy, multiline, hideLabel, inputRef, missing, mismatch, ...props }: any) {
  const [validationMessage, setValidationMessage] = useState('');
  const invalid = validationMessage !== '';
  const Control = multiline ? HaloTextarea : HaloInput;
  const messageFor = (control: TextControl) => {
    const state = control.validity;
    if (state.customError) return control.validationMessage;
    if (state.valueMissing) return missing || REQUIRED_ERROR;
    if (state.typeMismatch || state.patternMismatch) return mismatch || FORMAT_ERROR;
    return control.validationMessage || FORMAT_ERROR;
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
          aria-describedby={[help && `${id}-help`, invalid && `${id}-error`, describedBy].filter(Boolean).join(' ') || undefined}
          onInvalid={(event: React.InvalidEvent<TextControl>) => setValidationMessage(messageFor(event.currentTarget))}
          onBlur={(event: React.FocusEvent<TextControl>) => {
            const control = event.currentTarget;
            if (control.validity.valid) setValidationMessage('');
            else if (control.value !== '') setValidationMessage(messageFor(control));
            props.onBlur?.(event);
          }}
          onChange={(event: React.ChangeEvent<TextControl>) => {
            // The caller may set a custom validity message, so read validity afterwards.
            props.onChange?.(event);
            if (invalid && event.currentTarget.validity.valid) setValidationMessage('');
          }}
        />
        {help && <HaloFieldDescription id={`${id}-help`}>{help}</HaloFieldDescription>}
        {invalid && <HaloFieldError id={`${id}-error`}>{validationMessage}</HaloFieldError>}
        {below}
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

const AMOUNT_HELP = 'An estimate is fine. Use a comma or space for thousands.';
const AMOUNT_MISSING = 'Enter an amount, or choose the undecided option.';

/**
 * Accepts "150,000", "150 000" and "150000.50"; shows separators once the field is left; stores the plain string.
 * "150.000", "1.500.000" and "150.000,50" are ASKED about, never guessed: the prompt names both readings, Continue stays
 * blocked until one is chosen, and the choice is remembered by rewriting the field to the amount that was meant (so the
 * stored draft, Back and forward and a reload all carry the answer, and nothing ambiguous is ever sent).
 */
function AmountField({
  value,
  onValue,
  disabled,
  blocked,
}: {
  value: string;
  onValue: (plain: string) => void;
  disabled?: boolean;
  blocked?: boolean;
}) {
  const [display, setDisplay] = useState(() => groupAmount(value));
  const input = useRef<HTMLInputElement>(null);
  const ask = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (storedAmount(display) !== value) setDisplay(groupAmount(value));
  }, [value]);
  // A remounted field (Back, forward, a returning visitor) must carry the message too, not only a field that was typed in.
  useEffect(() => {
    input.current?.setCustomValidity(parseAmount(display).kind === 'invalid' ? AMOUNT_ERROR : '');
  }, [display]);
  // The question waits until typing has paused (or the field is left, or Continue is pressed), so "1.500" on its way to
  // "1.500.000" is never asked about, or announced, half way.
  const [settled, setSettled] = useState(true);
  const pause = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(pause.current), []);
  const found = amountAmbiguity(display);
  const ambiguity = found && (settled || blocked) ? found : null;
  // When the question first appears, bring it fully into view: the sticky action bar's fade must never cover its buttons.
  const asking = !!ambiguity;
  useEffect(() => {
    if (!asking) return;
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    ask.current?.scrollIntoView({ block: 'nearest', behavior: calm ? 'auto' : 'smooth' });
  }, [asking]);
  const choose = (plain: string) => {
    setDisplay(groupAmount(plain));
    onValue(plain);
    requestAnimationFrame(() => input.current?.focus());
  };
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
      missing={AMOUNT_MISSING}
      help={ambiguity ? undefined : AMOUNT_HELP}
      describedBy={ambiguity ? 'amount-ask-text' : undefined}
      below={
        // A standing live region: the prompt is announced when it appears, and again when it is answered by being replaced.
        <div role="status" className="amount-ask-region">
          {ambiguity && (
            <div ref={ask} className="amount-ask" data-blocked={blocked || undefined}>
              <p id="amount-ask-text" tabIndex={-1}>
                Did you mean <strong>{ambiguity.yesText}</strong>
                {ambiguity.words ? ` (${ambiguity.words})` : ''}?
              </p>
              <div className="amount-ask-actions">
                <button type="button" disabled={disabled} onClick={() => choose(ambiguity.yes)}>
                  Yes, {ambiguity.yesText}
                </button>
                {ambiguity.no ? (
                  <button type="button" disabled={disabled} onClick={() => choose(ambiguity.no as string)}>
                    No, I meant {ambiguity.noText}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      input.current?.focus();
                      input.current?.select();
                    }}
                  >
                    No, I’ll change it
                  </button>
                )}
              </div>
              {blocked && <p className="amount-ask-note">Choose one to continue.</p>}
            </div>
          )}
        </div>
      }
      onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
        const typed = event.target.value;
        setDisplay(typed);
        setSettled(false);
        window.clearTimeout(pause.current);
        pause.current = window.setTimeout(() => setSettled(true), 700);
        event.target.setCustomValidity(parseAmount(typed).kind === 'invalid' ? AMOUNT_ERROR : '');
        onValue(storedAmount(typed));
      }}
      onBlur={(event: React.FocusEvent<HTMLInputElement>) => {
        window.clearTimeout(pause.current);
        setSettled(true);
        const parsed = parseAmount(event.target.value);
        if (parsed.kind === 'valid') setDisplay(groupAmount(parsed.plain));
      }}
    />
  );
}

// "You sent an enquiry from this browser": a display-only hint for the welcome screen, never sent anywhere. It holds only
// a SHA-256 digest of the receipt's id (an equality check is all it needs, so the id itself is never kept in the clear),
// lives exactly where the draft lives (this tab; this device too if the visitor chose to remember it), and is cleared
// whenever the draft is forgotten or an enquiry is reopened for more answers.
const SENT_MARKER = 'intafaced.outreach.sent.v1';
async function sentDigest(id: string): Promise<string | null> {
  try {
    const bytes = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(id));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return null; // no SubtleCrypto (an insecure page): no hint
  }
}
function readSentMarker(): string | null {
  for (const area of ['sessionStorage', 'localStorage'] as const) {
    try {
      const value = window[area].getItem(SENT_MARKER);
      if (value) return value;
    } catch {
      /* storage unavailable: no hint */
    }
  }
  return null;
}
function writeSentMarker(digest: string, device: boolean) {
  try {
    window.sessionStorage.setItem(SENT_MARKER, digest);
  } catch {
    /* storage unavailable: no hint */
  }
  try {
    if (device) window.localStorage.setItem(SENT_MARKER, digest);
    else window.localStorage.removeItem(SENT_MARKER);
  } catch {
    /* storage unavailable: no hint */
  }
}
function clearSentMarker() {
  for (const area of ['sessionStorage', 'localStorage'] as const) {
    try {
      window[area].removeItem(SENT_MARKER);
    } catch {
      /* storage unavailable: nothing to clear */
    }
  }
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
  const welcomePlayed = useRef(document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches);
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
  // A question the visitor tried to leave unanswered. It belongs to one step, sits under the answers as an alert, and goes
  // as soon as anything on the step is answered (so "Choose an option to continue." never outlives the choice).
  const [stepError, setStepError] = useState<{ step: string; message: string } | null>(null);
  const [amountBlocked, setAmountBlocked] = useState(false);
  const currencyGroups = useMemo<PickerGroup[]>(() => {
    const option = (item: any): PickerOption => ({ value: item.code, label: `${item.code} · ${item.name}` });
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
    // The entrance is never cancelled because the storage check is slow: decoration does not wait for storage, and
    // storage does not interrupt decoration. Only two things end it early: reduced motion and a hidden tab (decided before
    // the first frame, or settled here). Every other visitor, a returning one included, sees the whole entrance: the storage
    // check is asynchronous, so a saved enquiry is never known at the first render. A saved enquiry found LATE changes the
    // hero button's label with a crossfade (HeroMetal) and leaves the entrance running.
    void vm.ready.then(
      () => {
        if (!mounted) return;
        if (
          welcomePlayed.current ||
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
      field.checkValidity(); // fires the field's own `invalid` event: our copy, shown on the field, never the browser's bubble
      field.focus();
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
    const returning = vm.resumeAvailable;
    act('begin');
    // A returning visitor's first click reopens the saved enquiry directly (after the storage check, which it never races).
    if (returning)
      void vm.ready.then(() => {
        if (vm.resumeAvailable && !vm.draft && !vm.busy) act('reopen');
      });
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
  const stepKey = `${vm.currentAudience}:${vm.group}`;
  const answer = (key: string, value: unknown) => {
    setStepError(null);
    setAmountBlocked(false);
    // A message the journey raised itself (not a failed save, which has an error code) is about the answers that just changed.
    if (vm.error && !vm.errorCode) vm.error = '';
    vm.setAnswer(key, value);
  };
  // What is still missing on a question step, as copy and the control to land on. Nothing here is the browser's.
  const missingAnswer = (): { message: string; focus: string } | null => {
    const kind = vm.questionStep?.kind;
    const stated = vm.answers.amountStatus === 'stated';
    if (
      vm.visibleFields.some((field: any) => field.type === 'select' && !vm.answers[field.key]) ||
      (kind === 'timing' && !vm.answers.timing)
    )
      return { message: 'Choose an option to continue.', focus: '.choice-cards input' };
    if (vm.visibleFields.some((field: any) => (field.type === 'checks' || field.type === 'countries') && !vm.answers[field.key].length))
      return { message: 'Choose at least one option to continue.', focus: '.check-card input, #operating-countries' };
    if (kind === 'amount' && stated && !vm.answers.currency) return { message: 'Choose a currency to continue.', focus: '#currency' };
    if (kind === 'amount' && stated && vm.currentAudience === 'merchant' && !vm.answers.period)
      return { message: 'Choose a volume period to continue.', focus: '.amount-period input' };
    return null;
  };
  const submit = (key: string) => (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (key === 'advance') {
      // 1. A text field that is empty or malformed: the first one only, with our copy.
      if (flagFirstInvalid(event.currentTarget)) return;
      // 2. An amount that could be read two ways: ask, never guess. Focus goes to the question, never to a button, so a
      // second stray Enter cannot answer it.
      if (vm.questionStep?.kind === 'amount' && vm.amountUnresolved()) {
        setAmountBlocked(true);
        requestAnimationFrame(() => document.getElementById('amount-ask-text')?.focus());
        return;
      }
      // 3. An answer that was not given.
      const missing = missingAnswer();
      if (missing) {
        setStepError({ step: stepKey, message: missing.message });
        requestAnimationFrame(() => document.querySelector<HTMLElement>(missing.focus)?.focus());
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
      className="outreach-text-button with-icon"
      disabled={vm.busy}
      onClick={() => {
        if (method) act(method, ...args);
        else {
          vm.screen = 'welcome';
          refresh();
        }
      }}
    >
      <ArrowLeft />
      Back
    </button>
  );
  const interests = (captured = false) => (
    <form
      key={captured ? 'append-interest' : 'initial-interest'}
      noValidate
      onSubmit={submit(captured ? 'saveInterests' : 'confirmInterests')}
    >
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
  const question = () => {
    const errorHere = stepError && stepError.step === stepKey ? stepError.message : '';
    const helper = vm.stepHelper;
    const errorId = errorHere ? 'step-error' : undefined;
    const describe = (...ids: Array<string | undefined>) => ids.filter(Boolean).join(' ') || undefined;
    return (
      <form key={stepKey} noValidate onSubmit={submit('advance')}>
        <div className="outreach-questions">
          {helper && (
            <p id="step-helper" className="step-helper">
              {helper}
            </p>
          )}
          {vm.visibleFields.map((field: any) => (
            <React.Fragment key={field.key}>
              {field.type === 'checks' ? (
                <fieldset
                  disabled={vm.busy}
                  className="check-cards"
                  aria-labelledby="intake-heading"
                  aria-describedby={describe(helper && 'step-helper', errorId)}
                >
                  {field.options.map(([value, label]: string[]) => (
                    <CheckCard
                      key={value}
                      value={value}
                      label={label}
                      checked={vm.answers[field.key].includes(value)}
                      onCheckedChange={() => toggle(field.key, value)}
                    />
                  ))}
                </fieldset>
              ) : field.type === 'countries' ? (
                <fieldset disabled={vm.busy} aria-labelledby="intake-heading">
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
                </fieldset>
              ) : field.type === 'select' ? (
                <>
                  <ChoiceCards
                    label={field.label}
                    items={field.options.map(([value, label]: string[]) => ({ value, label }))}
                    labelledBy="intake-heading"
                    value={vm.answers[field.key]}
                    onValueChange={(value) => answer(field.key, value)}
                    disabled={vm.busy}
                    describedBy={describe(field.key === 'investorType' ? 'investor-type-help' : undefined, errorId)}
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
                  pattern={field.type === 'url' ? 'https?://\\S+' : undefined}
                  mismatch={field.type === 'url' ? 'Start with https://, for example https://example.com.' : undefined}
                  describedBy={helper ? 'step-helper' : undefined}
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
              <ChoiceCards
                label="Amount preference"
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
                  <AmountField
                    value={vm.answers.amount}
                    onValue={(plain) => answer('amount', plain)}
                    disabled={vm.busy}
                    blocked={amountBlocked}
                  />
                  <SearchPicker
                    id="currency"
                    label="Currency"
                    placeholder="e.g. EUR"
                    groups={currencyGroups}
                    value={currencyOption(vm.answers.currency)}
                    onValueChange={(item) => answer('currency', item ? item.value : '')}
                    disabled={vm.busy}
                    align="end"
                  />
                  {vm.currentAudience === 'merchant' && (
                    <div className="amount-period">
                      <span className="picker-label">Volume period</span>
                      <ChoiceCards
                        label="Volume period"
                        variant="compact"
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
              describedBy={errorId}
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
          {errorHere && (
            <p id="step-error" className="step-error" role="alert">
              {errorHere}
            </p>
          )}
        </div>
        <div className="outreach-actions">
          {vm.group ? back('goGroup', vm.group - 1) : back()}
          {primary(vm.group === vm.reviewIndex - 1 ? 'Review your answers' : 'Continue')}
        </div>
      </form>
    );
  };
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
        ? 'Draft saved'
        : 'Draft kept in this tab';
  // The visible text follows every keystroke; the spoken one waits until typing settles and never says "Saving…".
  const [spokenStatus, setSpokenStatus] = useState('');
  useEffect(() => {
    if (!showDraftStatus || draftStatus === 'Saving…') return;
    const timer = window.setTimeout(() => setSpokenStatus(draftStatus), 800);
    return () => window.clearTimeout(timer);
  }, [showDraftStatus, draftStatus]);
  const savedReceiptId: string | undefined = vm.state.local?.receipt?.submissionId;
  const lastMarker = useRef('');
  useEffect(() => {
    if (!vm.storageReady) return;
    const next = !savedReceiptId ? 'none' : !vm.draft ? lastMarker.current : vm.complete ? `${savedReceiptId}:${vm.remember}` : 'none';
    if (next === lastMarker.current) return;
    lastMarker.current = next;
    if (next === 'none') {
      clearSentMarker();
      return;
    }
    const device = vm.remember;
    void sentDigest(savedReceiptId as string).then((digest) => {
      // Skip it if the draft was forgotten or changed while the digest was being made.
      if (!digest || lastMarker.current !== next) return;
      writeSentMarker(digest, device);
      setReceiptDigest({ id: savedReceiptId as string, digest });
    });
  });
  // The digest of the receipt on this page, to compare with the marker. Until it is known the welcome line and button keep
  // what they showed, so a sent enquiry never flashes "Continue your enquiry" on its way to "View your enquiry".
  const [receiptDigest, setReceiptDigest] = useState<{ id: string; digest: string | null } | null>(null);
  useEffect(() => {
    if (!savedReceiptId) return;
    let live = true;
    void sentDigest(savedReceiptId).then((digest) => {
      if (live) setReceiptDigest({ id: savedReceiptId, digest });
    });
    return () => {
      live = false;
    };
  }, [savedReceiptId]);
  const digestPending = !!savedReceiptId && receiptDigest?.id !== savedReceiptId;
  const shown = useRef({ sent: false, resume: false });
  const sentHere = digestPending
    ? shown.current.sent
    : vm.screen === 'welcome' && !!savedReceiptId && !!receiptDigest?.digest && readSentMarker() === receiptDigest.digest;
  const welcomeResume: boolean = digestPending ? shown.current.resume : !!vm.resumeAvailable;
  useEffect(() => {
    shown.current = { sent: sentHere, resume: welcomeResume };
  });
  const noteKey = sentHere ? 'sent' : welcomeResume ? 'resume' : 'new';
  const firstNoteKey = useRef(noteKey);
  const [noteFade, setNoteFade] = useState(false);
  useEffect(() => {
    if (noteKey === firstNoteKey.current) return;
    firstNoteKey.current = noteKey;
    // Fade the new line in only once the entrance is over; during it the line is still arriving on its own.
    if (!entryReveal) setNoteFade(true);
  }, [noteKey]);
  const showDeviceDetails =
    !!vm.draft && !vm.interestChangeRequested && !vm.interestsOpen && (vm.complete || !vm.currentAudience || vm.isReview);
  // The stacked lockup on the welcome hero (a full-screen brand moment), the horizontal top-bar lockup above a form.
  const logoLink = (layout: 'stacked' | 'horizontal', className: string) => (
    <a className={`brand-logo ${className}`} href="/join" aria-label="INTAFACED">
      {layout === 'stacked' ? (
        <img src={lockupStacked} alt="INTAFACED" width={218} height={96} />
      ) : (
        <img src={lockupBar} alt="INTAFACED" width={151} height={24} />
      )}
    </a>
  );
  // The confirmation puts its check mark ABOVE the heading, so there the heading lives inside the receipt (one h1 either way).
  const completeView = !resumePanel && !!vm.draft && !vm.interestsOpen && !vm.currentAudience && !!vm.complete;
  const headingElement = (
    <h1
      id="intake-heading"
      tabIndex={-1}
      ref={(node) => {
        // The confirmation moves this h1 into the receipt, so React unmounts the focused node and remounts a new one. Carry
        // focus across that swap; otherwise a heading focus that ran just before the commit leaves focus on <body>.
        if (!node) vm.headingHadFocus = document.activeElement === vm.refs.stepHeading;
        else if (vm.headingHadFocus) {
          vm.headingHadFocus = false;
          if (document.activeElement !== node) node.focus();
        }
        vm.refs.stepHeading = node;
      }}
    >
      {heading}
    </h1>
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
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          // type="email" lets "investor@gmail" through; the contract needs a dot in the domain. Say so, on the field, in our words.
          const form = event.currentTarget;
          const name = form.querySelector<HTMLInputElement>('#outreach-name');
          const email = form.querySelector<HTMLInputElement>('#outreach-email');
          name?.setCustomValidity(vm.contact.name.trim() ? '' : NAME_ERROR);
          email?.setCustomValidity(CONTACT_EMAIL.test(vm.contact.email.trim()) ? '' : EMAIL_ERROR);
          if (flagFirstInvalid(form)) return;
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
            missing={NAME_ERROR}
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
            missing={EMAIL_ERROR}
            mismatch={EMAIL_ERROR}
            required
            disabled={vm.busy}
            help="We’ll use this address to reply about your enquiry."
            value={vm.contact.email}
            onChange={(event: any) => {
              // The contract wants a dot in the domain, which type="email" does not: the field is invalid until it has one.
              const typed = event.target.value.trim();
              event.target.setCustomValidity(!typed || CONTACT_EMAIL.test(typed) ? '' : EMAIL_ERROR);
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
      <form key="contact-2" noValidate onSubmit={submit('saveContact')}>
        <p className="section-description">Everything on this page is optional. You can leave it blank and continue.</p>
        <div className="outreach-grid">
          <TextField
            id="organisation"
            label="Organisation"
            name="organization"
            autoComplete="organization"
            maxLength={160}
            disabled={vm.busy}
            value={vm.contact.organisationName}
            onChange={(event: any) => contactValue('organisationName', event.target.value)}
          />
          <SearchPicker
            id="country"
            label="Country"
            placeholder="Prefer not to say"
            groups={countryGroups}
            value={vm.contact.country ? countryOptions.find((item) => item.value === vm.contact.country) || NO_COUNTRY : NO_COUNTRY}
            onValueChange={(item) => contactValue('country', item ? item.value : '')}
            disabled={vm.busy}
            emptyText="No match. Try a country name."
          />
        </div>
        <div className="check-cards">
          <CheckCard
            label="Send me INTAFACED news and updates."
            description="Separate from replies about your enquiry."
            checked={vm.contact.marketingOptIn}
            disabled={vm.busy}
            onCheckedChange={(checked) => contactValue('marketingOptIn', checked)}
          />
          <CheckCard
            label="Remember my draft on this device."
            description={
              vm.persistentAvailable
                ? 'An encrypted draft lets you close this tab and return on this device. Leave this off on a shared device.'
                : 'Device recovery is unavailable in this browser. Keep this tab open to finish.'
            }
            checked={vm.remember}
            disabled={vm.busy || !vm.persistentAvailable}
            onCheckedChange={(checked) => vm.setRemember(checked)}
          />
        </div>
        <p className="outreach-small save-note">
          Your details will be saved so the team can follow up, even if you finish the questions later.
        </p>
        <div className="outreach-actions">
          <button type="button" className="outreach-text-button with-icon" disabled={vm.busy} onClick={() => goContactStep(1)}>
            <ArrowLeft />
            Back
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
          ? 'Held in this page only.'
          : !vm.state.draftStored
            ? 'Saving…'
            : vm.remember
              ? 'Kept on this device.'
              : 'Kept in this tab only.'}{' '}
        {vm.savedCount} of {vm.draft.contact.interests.length} questionnaires submitted.{' '}
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
            {logoLink('stacked', 'welcome-logo')}
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
              <HeroMetal
                type="button"
                onClick={begin}
                label={sentHere ? 'View your enquiry' : welcomeResume ? 'Continue your enquiry' : 'Begin'}
              />
            </div>
            <p className="outreach-small">
              {/* Each sentence wraps as a unit, so a phone never strands a lone "No" at a line end. */}
              <span className={noteFade ? 'note-fade' : undefined} key={noteKey}>
                {(sentHere
                  ? ['You sent an enquiry from this browser.']
                  : welcomeResume
                    ? ['A previous enquiry is available in this browser.']
                    : ['No account needed.', 'No investment commitment.']
                ).map((sentence: string) => (
                  <React.Fragment key={sentence}>
                    <span className="nowrap">{sentence}</span>{' '}
                  </React.Fragment>
                ))}
              </span>{' '}
              <button type="button" className="outreach-inline-link" onClick={openPrivacy}>
                Privacy
              </button>{' '}
              <a className="outreach-inline-link" href="/waitlist">
                Join the waitlist
              </a>
            </p>
          </div>
        </section>
      ) : (
        <section role="main" className="outreach-workspace" aria-busy={vm.busy} aria-labelledby="intake-heading">
          <div className="outreach-form-panel">
            {logoLink('horizontal', 'form-logo')}
            <div className="outreach-eyebrow-row">
              <p id="question-progress-label" className="outreach-eyebrow">
                {eyebrow}
              </p>
              {showDraftStatus && (
                <>
                  <span className="draft-status" aria-hidden="true" data-state={draftStatus}>
                    {draftStatus}
                    {draftStatus === 'Draft saved' && <Check />}
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
                value={vm.group + 1}
                max={vm.reviewIndex + 1}
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
            {!completeView && headingElement}
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
                      <button type="button" className="outreach-text-button with-icon" disabled={vm.busy} onClick={() => act('goGroup', 0)}>
                        <ArrowLeft />
                        Edit answers
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
                    Your enquiry has been received.
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
                  {headingElement}
                  <div className="completion-receipt-copy">
                    <p>
                      {vm.draft.contact.interests.includes('investor')
                        ? 'We review every enquiry personally before arranging a call.'
                        : 'The team will review your enquiry.'}{' '}
                      We’ll reply to <span className="receipt-email">{vm.draft.contact.email}</span>.
                    </p>
                    <ul>
                      {vm.draft.contact.interests.map((key: string) => (
                        <li key={key}>
                          {vm.audienceLabel(key)}{' '}
                          <span className="received-status">
                            Received
                            <Check />
                          </span>
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
              <p className="outreach-small saved-summary">
                <Check />
                {vm.savedStageMessage}
              </p>
            )}
            {showDeviceDetails && deviceDetails()}
          </div>
        </section>
      )}
      {vm.privacyOpen && (
        <section className="outreach-privacy" aria-labelledby="privacy-heading">
          <button
            type="button"
            className="outreach-text-button with-icon"
            onClick={() => {
              vm.privacyOpen = false;
              act('focusHeading');
            }}
          >
            <ArrowLeft />
            Return to your enquiry
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
          {vm.resumeAvailable && (
            <button type="button" className="outreach-text-button" disabled={vm.busy} onClick={() => act('forget')}>
              Forget this draft on my device
            </button>
          )}
        </section>
      )}
    </div>
  );
}

const splash = document.getElementById('initLoading');
if (splash) splash.remove();
const waitlist = window.location.pathname === '/waitlist';
document.title = waitlist ? 'INTAFACED waitlist' : 'Join INTAFACED';
const container = document.getElementById('app');
if (!container) throw new Error('intake_root_unavailable');
createRoot(container).render(waitlist ? <WaitlistPage /> : <App />);
