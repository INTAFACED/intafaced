import heroImage from '../../../vendor/upstream-exchange/05_Web_Front/src/assets/images/outreach/graphite-fins-desktop.webp';

import { mutate } from '@outreach/transport';
import intake from '@outreach/intake';
import review from '@outreach/review';
const { formatReviewAmount } = review;
import info from '@outreach/info';
const { publicInfo } = info;
import storageModule from '@outreach/storage';
const { createDraftStorage } = storageModule;
import countryModule from '@outreach/countries';
const countries = countryModule.countryOptions('en');
let AUDIENCES = [
  { key: 'investor', path: '/invest', label: 'Investor', description: 'Discuss backing INTAFACED or introduce an investor' },
  { key: 'trader', path: '/trade', label: 'Trader', description: 'Share your markets and trading interests' },
  { key: 'merchant', path: '/merchant', label: 'Merchant', description: 'Explore payment acceptance, settlement or payouts' },
  { key: 'academy', path: '/academy', label: 'Academy', description: 'Tell us what you want to learn' },
  { key: 'partner', path: '/partner', label: 'Partner', description: 'Explore a collaboration or partnership' },
];
function currencyOptions() {
  let codes =
    typeof Intl.supportedValuesOf === 'function'
      ? Intl.supportedValuesOf('currency')
      : ['USD', 'EUR', 'GBP', 'IDR', 'SGD', 'AUD', 'JPY', 'CHF', 'CAD', 'CNY', 'AED'];
  let names = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames(['en'], { type: 'currency' }) : null;
  return codes
    .map(function (code) {
      return { code: code, name: names ? names.of(code) : code };
    })
    .sort(function (a, b) {
      return a.name.localeCompare(b.name);
    });
}
const presentation = {
  name: 'IxOutreach',
  data() {
    let storage;
    try {
      storage = window.sessionStorage;
    } catch (e) {
      storage = null;
    }
    let controller = this.makeController(storage);
    return {
      publicInfo: publicInfo({ contactUrl: process.env.OUTREACH_CONTACT_URL, retentionNotice: process.env.OUTREACH_RETENTION_NOTICE }),
      controller: controller,
      state: controller.state,
      screen: 'welcome',
      busy: false,
      error: '',
      errorCode: '',
      heroDesktop: heroImage,
      audiences: AUDIENCES,
      countries: countries,
      currencies: currencyOptions(),
      timing: intake.timing,
      contact: this.emptyContact(),
      answers: {},
      group: 0,
      interestsOpen: false,
      interestChangeRequested: false,
      selectedInterests: [],
      remember: false,
      persistentAvailable: false,
      privacyOpen: false,
      countrySearch: '',
      currencySearch: '',
      storageReady: false,
      expiredDraft: false,
      forms: {},
      groups: {},
    };
  },
  async mounted() {
    let session;
    try {
      session = window.sessionStorage;
    } catch (e) {
      session = null;
    }
    let storage = await createDraftStorage({
      session: session,
      indexedDB: window.indexedDB,
      crypto: window.crypto,
      now: Date.now,
      storageKey: intake.STORAGE_KEY,
    });
    this.persistentAvailable = storage.persistentAvailable;
    this.expiredDraft = storage.expired;
    // Switch storage before the visitor can submit; restored contact is only displayed on explicit continuation.
    this.controller = this.makeController(storage);
    this.state = this.controller.state;
    let ui = this.state.ui;
    if (ui) {
      this.remember = ui.remember;
      this.forms = ui.forms;
      this.groups = ui.groups;
    }
    this.storageReady = true;
    this.notify();
  },
  computed: {
    investorEntry() {
      return intake.audienceForPath(this.location.path) === 'investor';
    },
    continuationUnavailable() {
      return /continuation_invalid/.test(this.errorCode);
    },
    draft() {
      return this.state.draft;
    },
    resumeAvailable() {
      return !!this.state.local && this.activeAction !== 'saveContact';
    },
    savedCount() {
      return this.draft ? this.draft.questionnaires.length : 0;
    },
    currentAudience() {
      let d = this.draft;
      return (
        d &&
        intake.AUDIENCES.find(function (a) {
          return (
            d.contact.interests.includes(a) &&
            !d.questionnaires.some(function (q) {
              return q.audience === a;
            })
          );
        })
      );
    },
    fields() {
      return intake.QUESTIONS[this.currentAudience] || [];
    },
    questionSteps() {
      let steps = this.fields.map((field) => ({ kind: 'field', field: field }));
      if ((this.currentAudience === 'investor' && this.answers.participation !== 'introduction') || this.currentAudience === 'merchant')
        steps.push({ kind: 'amount' });
      return steps.concat([{ kind: 'timing' }, { kind: 'message' }, { kind: 'review' }]);
    },
    questionStep() {
      return this.questionSteps[this.group];
    },
    reviewIndex() {
      return this.questionSteps.length - 1;
    },
    isReview() {
      return this.group === this.reviewIndex;
    },
    visibleFields() {
      return this.questionStep && this.questionStep.kind === 'field' ? [this.questionStep.field] : [];
    },
    complete() {
      return this.draft && !!this.draft.completedAt && this.savedCount === this.draft.contact.interests.length;
    },
    savedStageMessage() {
      if (this.complete) return 'Your details and answers are saved.';
      if (this.isReview) return 'Your details are saved. Review your answers before sending your enquiry.';
      return 'Your details are saved. Continue with a few questions.';
    },
    progressLabel() {
      if (this.interestChangeRequested) return 'YOUR SAVED PROGRESS';
      if (this.interestsOpen) return 'YOUR INTERESTS';
      if (!this.draft) return this.resumeAvailable ? 'YOUR ENQUIRY' : 'YOUR DETAILS';
      if (this.complete) return 'ENQUIRY SAVED';
      if (this.isReview) return 'READY TO SEND';
      return this.audienceLabel(this.currentAudience).toUpperCase() + ' · ' + (this.group + 1) + ' OF ' + this.reviewIndex;
    },
    stepTitle() {
      if (this.interestChangeRequested) return 'Check your saved progress.';
      if (this.interestsOpen) return 'Where would you like to take part?';
      if (!this.draft) return this.resumeAvailable ? 'Pick up where you left off.' : 'Let’s start with you.';
      if (this.complete) return 'Your enquiry is saved.';
      if (this.isReview) return 'Before you send.';
      let step = this.questionStep;
      if (!step) return 'Your enquiry';
      if (step.kind === 'field') return step.field.key === 'participation' ? 'How would you like to take part?' : step.field.label;
      if (step.kind === 'amount')
        return this.currentAudience === 'investor' ? 'What amount are you considering?' : 'What is your processing volume?';
      if (step.kind === 'timing') return 'When would you consider taking part?';
      return 'Anything you’d like us to know?';
    },
    audienceDescription() {
      let row = AUDIENCES.find((a) => a.key === this.currentAudience);
      return row ? row.description + '.' : '';
    },
    expiryLabel() {
      return this.draft ? new Date(this.draft.continuationExpiresAt).toLocaleString() : '';
    },
    newInterests() {
      return this.selectedInterests.filter((a) => !this.draft.contact.interests.includes(a));
    },
    filteredCountries() {
      return this.countries.filter(
        (c) => c.name.toLowerCase().includes(this.countrySearch.toLowerCase()) || (this.answers.operatingCountries || []).includes(c.code),
      );
    },
    filteredCurrencies() {
      return this.currencies.filter(
        (c) => (c.name + ' ' + c.code).toLowerCase().includes(this.currencySearch.toLowerCase()) || c.code === this.answers.currency,
      );
    },
    reviewRows() {
      let rows = this.fields.map((f) => ({ label: f.label, value: this.reviewValue(f, this.answers[f.key]) }));
      if (this.currentAudience === 'investor' || this.currentAudience === 'merchant')
        rows.push({
          label: this.currentAudience === 'investor' ? 'Amount you’re considering' : 'Processing volume',
          value:
            this.currentAudience === 'investor' && this.answers.participation === 'introduction'
              ? 'Not requested for an introduction'
              : this.answers.amountStatus === 'stated'
                ? formatReviewAmount(this.answers.amount) +
                  ' ' +
                  this.answers.currency +
                  (this.currentAudience === 'merchant' ? ' · ' + this.answers.period : '')
                : 'Not stated',
        });
      rows.push({ label: 'Timing', value: (this.timing.find((o) => o[0] === this.answers.timing) || ['', 'Not selected'])[1] });
      if (this.answers.message) rows.push({ label: 'Your message', value: this.answers.message });
      return rows;
    },
  },
  methods: {
    makeController(storage) {
      return intake.createIntake({
        storage: storage,
        crypto: window.crypto,
        encode: window.btoa.bind(window),
        now: Date.now,
        send: (method, input) => mutate('ops', 'outreach.' + method, input, null),
      });
    },
    emptyContact() {
      return {
        name: '',
        email: '',
        organisationName: '',
        country: '',
        interests: [intake.audienceForPath(this.location.path)].filter(Boolean),
        marketingOptIn: false,
      };
    },
    audienceLabel(a) {
      let row = AUDIENCES.find((v) => v.key === a);
      return row ? row.label : '';
    },
    countryLabel(code) {
      let row = this.countries.find((c) => c.code === code);
      return row ? row.name : code;
    },
    reviewValue(f, value) {
      if (Array.isArray(value))
        return value
          .map((v) => (f.type === 'countries' ? this.countryLabel(v) : (f.options.find((o) => o[0] === v) || ['', v])[1]))
          .join(', ');
      if (f.type === 'select') return (f.options.find((o) => o[0] === value) || ['', value])[1];
      return value || 'Not provided';
    },
    begin() {
      if (!this.state.local && !this.contact.interests.length) this.interestsOpen = true;
      this.screen = 'contact';
      this.focusHeading();
    },
    changeInterests() {
      if (this.busy || !this.storageReady) return;
      this.screen = 'contact';
      if (this.state.local && (!this.draft || this.state.local.answer || this.state.local.extension)) {
        // Unknown writes must be reconciled explicitly before changing the
        // selected draft. Keep their original request UUID and all local input.
        this.interestChangeRequested = true;
      } else if (this.draft) this.openAddInterests();
      else this.interestsOpen = true;
      this.focusHeading();
    },
    closeInterests() {
      this.interestsOpen = false;
      this.focusHeading();
    },
    confirmInterests() {
      if (!this.contact.interests.length) return;
      this.interestsOpen = false;
      this.focusHeading();
    },
    focusHeading() {
      this.afterRender(() => {
        let heading = this.refs.stepHeading || this.refs.welcomeTitle;
        let active = document.activeElement;
        // A visitor may begin typing before the scheduled heading focus runs.
        // Preserve a control they have already focused in the current view.
        if (active && active.closest('form') && active.matches('input, textarea, select, button, [contenteditable="true"]')) return;
        if (heading) heading.focus();
      });
    },
    resetAnswers() {
      if (!this.currentAudience) {
        this.answers = {};
        this.group = 0;
        return;
      }
      let values = {
        timing: '',
        message: '',
        amountStatus: this.currentAudience === 'merchant' ? 'unknown' : 'undecided',
        amount: '',
        currency: '',
        period: '',
      };
      this.fields.forEach((f) => {
        values[f.key] = f.type === 'checks' || f.type === 'countries' ? [] : '';
      });
      let pending = this.state.local && this.state.local.answer;
      if (pending && pending.questionnaire.audience === this.currentAudience) {
        Object.assign(values, pending.questionnaire.answers);
        if (Array.isArray(values.subjects)) values.subjects = values.subjects.join(', ');
        let money = values.indicativeContribution || values.processingVolume;
        if (money)
          Object.assign(values, {
            amountStatus: money.status,
            amount: money.amount || '',
            currency: money.currency || '',
            period: money.period || '',
          });
        delete values.indicativeContribution;
        delete values.processingVolume;
      }
      if (this.forms[this.currentAudience]) Object.assign(values, this.forms[this.currentAudience]);
      this.answers = values;
      this.group = Math.min(this.groups[this.currentAudience] || 0, this.reviewIndex);
      this.countrySearch = '';
      this.currencySearch = '';
    },
    storeUi() {
      if (!this.controller || !this.currentAudience) return;
      this.setMap(this.forms, this.currentAudience, JSON.parse(JSON.stringify(this.answers)));
      this.setMap(this.groups, this.currentAudience, this.group);
      return this.controller.saveUi({ forms: this.forms, groups: this.groups, remember: this.remember }).then(this.notify, this.notify);
    },
    goGroup(index) {
      this.group = index;
      this.storeUi();
      this.focusHeading();
    },
    advance() {
      this.error = '';
      this.errorCode = '';
      if (this.visibleFields.some((f) => (f.type === 'checks' || f.type === 'countries') && !this.answers[f.key].length)) {
        this.error = 'Choose at least one option to continue.';
        return;
      }
      if (this.group === this.reviewIndex - 1) {
        try {
          intake.buildQuestionnaire(this.currentAudience, this.answers);
        } catch (e) {
          this.error = intake.errorCopy(e.code);
          return;
        }
      }
      this.goGroup(this.group + 1);
    },
    async run(action) {
      if (this.busy) return;
      this.busy = true;
      this.error = '';
      this.errorCode = '';
      try {
        await action();
        if (this.draft) {
          this.draft.questionnaires.forEach((q) => {
            this.deleteMap(this.forms, q.audience);
            this.deleteMap(this.groups, q.audience);
          });
          await this.controller.saveUi({ forms: this.forms, groups: this.groups, remember: this.remember });
        }
        this.focusHeading();
      } catch (e) {
        this.errorCode = e.code || 'unreachable';
        this.error = intake.errorCopy(this.errorCode);
        this.afterRender(() => {
          if (this.refs.error) this.refs.error.focus();
        });
      } finally {
        this.busy = false;
      }
    },
    saveContact() {
      if (!this.storageReady) return;
      this.controller.saveUi({ forms: this.forms, groups: this.groups, remember: this.remember });
      return this.run(() =>
        this.controller.capture(this.contact, this.location.query.source).then(() => {
          this.interestsOpen = false;
        }),
      );
    },
    saveAnswers() {
      return this.run(async () => {
        await this.controller.answer(intake.buildQuestionnaire(this.currentAudience, this.answers));
        this.resetAnswers();
      });
    },
    reopen() {
      return this.run(async () => {
        if (this.state.local.receipt) await this.controller.resume();
        else {
          let capture = this.state.local.capture;
          await this.controller.capture(capture.contact, capture.sourceKey);
        }
        this.interestsOpen = false;
        this.resetAnswers();
        if (this.interestChangeRequested) {
          this.interestChangeRequested = false;
          if (this.state.local.answer) {
            this.goGroup(this.reviewIndex);
            let error = new Error('answer_pending');
            error.code = 'answer_pending';
            throw error;
          }
          this.openAddInterests();
        }
      });
    },
    openAddInterests() {
      let pending = this.state.local && this.state.local.extension;
      this.selectedInterests = this.draft.contact.interests
        .concat(pending ? pending.interests : [])
        .filter((value, index, all) => all.indexOf(value) === index);
      this.interestsOpen = true;
    },
    saveInterests() {
      return this.run(async () => {
        await this.controller.addInterests(this.newInterests);
        this.interestsOpen = false;
        this.resetAnswers();
      });
    },
    startNew() {
      if (!window.confirm('Start a new enquiry? Your saved information stays with the team. This browser will forget the previous draft.'))
        return;
      return this.run(async () => {
        await this.controller.clear();
        this.error = '';
        this.errorCode = '';
        this.contact = this.emptyContact();
        this.forms = {};
        this.groups = {};
        this.answers = {};
        this.remember = false;
        this.interestChangeRequested = false;
        this.interestsOpen = !this.contact.interests.length;
      });
    },
    forget() {
      if (!window.confirm('Forget your local draft? Your saved enquiry stays with the team.')) return;
      return this.run(async () => {
        await this.controller.clear();
        this.contact = this.emptyContact();
        this.forms = {};
        this.groups = {};
        this.answers = {};
        this.remember = false;
        this.privacyOpen = false;
        this.interestChangeRequested = false;
        this.screen = 'welcome';
      });
    },
  },
};

// React owns rendering; this model owns only presentation state and delegates all durable actions.
export function createJourney(notify) {
  const model = {
    location: { path: window.location.pathname, query: { source: new URLSearchParams(window.location.search).get('source') || undefined } },
    refs: {},
    notify,
    setMap: (map, key, value) => {
      map[key] = value;
    },
    deleteMap: (map, key) => {
      delete map[key];
    },
    afterRender: (callback) => {
      notify();
      requestAnimationFrame(callback);
    },
  };
  Object.entries(presentation.methods).forEach(([key, method]) => {
    model[key] = method.bind(model);
  });
  Object.assign(model, presentation.data.call(model));
  Object.entries(presentation.computed).forEach(([key, get]) => Object.defineProperty(model, key, { get: get.bind(model) }));
  let previousAudience = null;
  model.reconcile = () => {
    const audience = model.currentAudience;
    if (audience !== previousAudience) {
      previousAudience = audience;
      model.resetAnswers();
    }
    notify();
  };
  model.ready = presentation.mounted.call(model).then(model.reconcile);
  model.act = (key, ...args) => {
    if (key === 'saveContact') model.activeAction = key;
    const result = model[key](...args);
    model.reconcile();
    return Promise.resolve(result).finally(() => {
      if (key === 'saveContact') model.activeAction = null;
      model.reconcile();
    });
  };
  model.setAnswer = (key, value) => {
    model.answers[key] = value;
    if (key === 'participation' && value === 'introduction')
      Object.assign(model.answers, { amountStatus: 'undecided', amount: '', currency: '' });
    model.storeUi();
    notify();
  };
  model.setRemember = (value) => {
    model.remember = value;
    model.storeUi();
    notify();
  };
  return model;
}
