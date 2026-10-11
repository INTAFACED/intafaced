<template>
  <div class="outreach-page" :class="{ 'is-welcome': screen === 'welcome' }">
    <p v-if="expiredDraft || state.expired" class="outreach-notice expiry-notice" role="status">
      Your previous draft access expired. You can start a new enquiry.
    </p>
    <section v-if="screen === 'welcome'" class="outreach-welcome" aria-labelledby="welcome-title">
      <picture class="outreach-hero-art" aria-hidden="true">
        <source media="(max-width: 680px)" :srcset="heroPhone" width="840" height="504" />
        <img :src="heroDesktop" alt="" width="1672" height="941" decoding="async" fetchpriority="high" />
      </picture>
      <div class="welcome-content">
        <p class="outreach-eyebrow">
          <span class="status-dot"></span> {{ investorEntry ? 'INTAFACED · INVESTOR ENQUIRY' : 'INTAFACED · PRELAUNCH' }}
        </p>
        <h1 id="welcome-title" ref="welcomeTitle" tabindex="-1">
          {{ investorEntry ? 'Discuss the' : 'One ambition.' }}<br /><span>{{ investorEntry ? 'INTAFACED raise.' : 'Many ways in.' }}</span>
        </h1>
        <p class="welcome-description">
          {{
            investorEntry
              ? 'We’re bringing accounts, payments and trading into one financial platform. Tell us whether you’re considering investing or can introduce an investor.'
              : 'Trading. Payments. Learning. Community. Tell us where you would like to take part in INTAFACED.'
          }}
        </p>
        <button class="outreach-primary welcome-cta" type="button" @click="begin">
          {{ resumeAvailable ? 'Continue your enquiry' : investorEntry ? 'Start enquiry' : 'Start a conversation' }}
          <span aria-hidden="true">↗</span>
        </button>
        <p class="outreach-small">
          {{
            resumeAvailable
              ? 'A previous enquiry is available in this browser.'
              : 'No account needed. Sending an enquiry does not commit you to an investment.'
          }}
        </p>
        <button v-if="investorEntry && !resumeAvailable" class="outreach-text-button" type="button" @click="beginWithInterests">
          Explore another interest <span aria-hidden="true">→</span>
        </button>
      </div>
    </section>

    <section v-else class="outreach-workspace" :aria-busy="busy ? 'true' : 'false'" aria-labelledby="intake-heading">
      <aside class="outreach-rail">
        <p class="outreach-eyebrow">YOUR CONVERSATION</p>
        <h2>{{ investorEntry ? 'Build with us.' : 'Find your way in.' }}</h2>
        <div class="conversation-art" aria-hidden="true"><img :src="heroPhone" alt="" width="840" height="504" /></div>
        <p>Share a little about yourself.<br />We will take it from there.</p>
        <ol class="journey-steps" aria-label="Enquiry progress">
          <li :class="{ active: !draft, done: !!draft }"><span>01</span> Your details <small v-if="draft">Saved</small></li>
          <li :class="{ active: draft && !complete, done: complete }">
            <span>02</span> Your interests <small v-if="draft">{{ savedCount }}/{{ draft.contact.interests.length }} submitted</small>
          </li>
          <li :class="{ active: complete }"><span>03</span> Next steps</li>
        </ol>
        <p class="rail-note">An enquiry starts a conversation. It does not create an investment commitment or grant product access.</p>
        <button type="button" class="outreach-text-button" @click="privacyOpen = true">
          Privacy &amp; your enquiry <span aria-hidden="true">↗</span>
        </button>
      </aside>
      <div class="outreach-form-panel">
        <p class="outreach-eyebrow">{{ progressLabel }}</p>
        <h1 id="intake-heading" ref="stepHeading" tabindex="-1">{{ stepTitle }}</h1>
        <p v-if="error" ref="error" tabindex="-1" class="outreach-notice" role="alert">{{ error }}</p>
        <p v-if="!state.storageAvailable" class="outreach-notice" role="status">
          Your progress cannot be stored in this browser. Keep this page open to finish; closing or refreshing may lose your access.
        </p>
        <button v-if="continuationUnavailable" type="button" class="outreach-secondary" :disabled="busy" @click="startNew">
          Start a new enquiry
        </button>

        <div v-if="resumeAvailable && !draft" class="outreach-resume">
          <p>Continue the enquiry saved in this browser. Your answers will be shown after we check your access.</p>
          <button type="button" class="outreach-primary" :disabled="busy" @click="reopen">
            {{ busy ? 'Opening…' : 'Reopen saved enquiry' }} <span aria-hidden="true">→</span>
          </button>
          <button type="button" class="outreach-text-button" :disabled="busy" @click="startNew">Start a new enquiry</button>
        </div>

        <form v-else-if="!draft" @submit.prevent="saveContact">
          <p class="section-description">Your details will be saved so the team can follow up, even if you finish the questions later.</p>
          <div class="selected-interest-summary">
            <span>{{ contact.interests.length ? contact.interests.map(audienceLabel).join(' · ') : 'Choose your interests' }}</span
            ><button type="button" class="outreach-text-button" @click="interestsOpen = !interestsOpen">
              {{ interestsOpen ? 'Done' : 'Change interests' }}
            </button>
          </div>
          <fieldset v-if="interestsOpen || !contact.interests.length" class="outreach-interests" :disabled="busy">
            <legend>What interests you? <small>Select one or more.</small></legend>
            <label v-for="a in audiences" :key="a.key" class="outreach-interest" :class="{ selected: contact.interests.includes(a.key) }"
              ><input v-model="contact.interests" type="checkbox" :value="a.key" /><span
                ><strong>{{ a.label }}</strong
                ><small>{{ a.description }}</small></span
              ><span class="choice-mark" aria-hidden="true">{{ contact.interests.includes(a.key) ? '✓' : '+' }}</span></label
            >
          </fieldset>
          <div class="outreach-grid">
            <label
              >Your name <span aria-hidden="true">*</span
              ><input
                v-model.trim="contact.name"
                name="name"
                autocomplete="name"
                maxlength="120"
                required
                :disabled="busy"
                placeholder="Full name"
            /></label>
            <label
              >Email <span aria-hidden="true">*</span
              ><input
                aria-describedby="contact-email-help"
                v-model.trim="contact.email"
                name="email"
                autocomplete="email"
                type="email"
                maxlength="254"
                required
                :disabled="busy"
                placeholder="you@example.com"
              /><small id="contact-email-help" class="field-help">We’ll use this address to reply about your enquiry.</small></label
            >
            <label
              >Organisation <small>Optional</small
              ><input
                v-model.trim="contact.organisationName"
                name="organization"
                autocomplete="organization"
                maxlength="160"
                :disabled="busy"
                placeholder="Company or organisation"
            /></label>
            <label
              >Country <small>Optional</small
              ><select v-model="contact.country" name="country" autocomplete="country" :disabled="busy">
                <option value="">Prefer not to say</option>
                <option v-for="country in countries" :key="country.code" :value="country.code">{{ country.name }}</option>
              </select></label
            >
          </div>
          <label class="outreach-consent"
            ><input v-model="contact.marketingOptIn" type="checkbox" :disabled="busy" /><span
              >Send me INTAFACED news and updates.</span
            ></label
          >
          <p class="outreach-small consent-help">Optional marketing permission is separate from replies about this enquiry.</p>
          <details class="recovery-options">
            <summary>Draft recovery <span>Optional</span></summary>
            <label class="outreach-consent"
              ><input v-model="remember" type="checkbox" :disabled="busy || !persistentAvailable" /><span
                >Remember my draft on this device.</span
              ></label
            >
            <p class="outreach-small consent-help">
              {{
                persistentAvailable
                  ? 'An encrypted draft lets you close this tab and return on this device. Leave this off on a shared device.'
                  : 'Device recovery is unavailable in this browser. Keep this tab open to finish.'
              }}
            </p>
          </details>
          <div class="outreach-actions">
            <button type="button" class="outreach-text-button" @click="screen = 'welcome'">← Back</button
            ><button type="submit" class="outreach-primary" :disabled="busy || !storageReady">
              {{ busy ? 'Saving…' : 'Save details & continue' }} <span aria-hidden="true">→</span>
            </button>
          </div>
          <p class="outreach-small">
            By continuing, you ask INTAFACED to review and reply to your enquiry.
            <button type="button" class="outreach-inline-link" @click="privacyOpen = true">Privacy &amp; contact</button>
          </p>
        </form>

        <template v-else>
          <div class="selected-interest-summary saved-summary">
            <span><span class="saved-dot" aria-hidden="true">✓</span> {{ savedStageMessage }}</span>
          </div>
          <details class="saved-contact-details">
            <summary>View your saved details</summary>
            <dl>
              <div>
                <dt>Name</dt>
                <dd>{{ draft.contact.name }}</dd>
              </div>
              <div>
                <dt>Email</dt>
                <dd>{{ draft.contact.email }}</dd>
              </div>
              <div v-if="draft.contact.organisationName">
                <dt>Organisation</dt>
                <dd>{{ draft.contact.organisationName }}</dd>
              </div>
              <div v-if="draft.contact.country">
                <dt>Country</dt>
                <dd>{{ countryLabel(draft.contact.country) }}</dd>
              </div>
            </dl>
            <p class="outreach-small">
              These details are already saved.
              <template v-if="publicInfo.contactUrl"
                >For a correction, <a :href="publicInfo.contactUrl">contact the INTAFACED team</a>.</template
              ><template v-else>You can request a correction when the team follows up.</template>
            </p>
            <button type="button" class="outreach-text-button" :disabled="busy" @click="openAddInterests">Add an interest</button>
          </details>
          <form v-if="interestsOpen" class="interest-extension" @submit.prevent="saveInterests">
            <fieldset :disabled="busy">
              <legend>Explore another conversation</legend>
              <label v-for="a in audiences" :key="a.key" class="outreach-interest" :class="{ selected: selectedInterests.includes(a.key) }"
                ><input
                  v-model="selectedInterests"
                  type="checkbox"
                  :value="a.key"
                  :disabled="draft.contact.interests.includes(a.key)"
                /><span
                  ><strong>{{ a.label }}</strong
                  ><small>{{ a.description }}</small></span
                ><span class="choice-mark" aria-hidden="true">{{ selectedInterests.includes(a.key) ? '✓' : '+' }}</span></label
              >
            </fieldset>
            <p class="outreach-small">Your saved interests and original answers stay preserved.</p>
            <div class="outreach-actions">
              <button type="button" class="outreach-text-button" @click="interestsOpen = false">Cancel</button
              ><button type="submit" class="outreach-primary" :disabled="busy || !newInterests.length">
                {{ busy ? 'Saving…' : 'Add & continue' }}
              </button>
            </div>
          </form>
          <template v-else-if="currentAudience">
            <nav class="question-segments" aria-label="Questionnaire steps">
              <button
                v-for="(label, index) in groupLabels"
                :key="label"
                type="button"
                :class="{ active: group === index, passed: group > index }"
                :aria-current="group === index ? 'step' : null"
                :disabled="index > group || busy"
                @click="goGroup(index)"
              >
                <span>{{ index + 1 }}</span
                >{{ label }}
              </button>
            </nav>
            <form v-if="group < 2" :key="currentAudience + ':' + group" ref="questionForm" @submit.prevent="advance">
              <p v-if="group > 0" class="section-description">A little context helps us make the next conversation useful.</p>
              <div class="outreach-questions">
                <template v-for="f in visibleFields">
                  <fieldset v-if="f.type === 'checks' || (f.type === 'select' && f.options.length <= 3)" :key="f.key" :disabled="busy">
                    <legend>{{ f.label }}</legend>
                    <div class="question-choices">
                      <label
                        v-for="o in f.options"
                        :key="o[0]"
                        class="question-choice"
                        :class="{ selected: f.type === 'checks' ? answers[f.key].includes(o[0]) : answers[f.key] === o[0] }"
                        ><input
                          v-model="answers[f.key]"
                          :type="f.type === 'checks' ? 'checkbox' : 'radio'"
                          :name="f.key"
                          :value="o[0]"
                          :required="f.type === 'select'"
                        /><span>{{ o[1] }}</span
                        ><span aria-hidden="true" class="choice-mark">{{
                          (f.type === 'checks' ? answers[f.key].includes(o[0]) : answers[f.key] === o[0]) ? '✓' : ''
                        }}</span></label
                      >
                    </div>
                  </fieldset>
                  <fieldset v-else-if="f.type === 'countries'" :key="f.key" :disabled="busy">
                    <legend>{{ f.label }}</legend>
                    <input
                      v-model="countrySearch"
                      type="search"
                      placeholder="Find a country"
                      aria-label="Find operating countries"
                    /><select v-model="answers[f.key]" multiple size="5" required :aria-label="f.label">
                      <option v-for="country in filteredCountries" :key="country.code" :value="country.code">{{ country.name }}</option>
                    </select>
                    <p class="outreach-small">Choose one or more. {{ answers[f.key].map(countryLabel).join(', ') }}</p>
                  </fieldset>
                  <label v-else :key="f.key"
                    >{{ f.label
                    }}<select v-if="f.type === 'select'" v-model="answers[f.key]" required :disabled="busy">
                      <option disabled value="">Select an option</option>
                      <option v-for="o in f.options" :key="o[0]" :value="o[0]">{{ o[1] }}</option></select
                    ><textarea
                      v-else-if="f.type === 'textarea'"
                      v-model.trim="answers[f.key]"
                      :maxlength="f.max"
                      :required="f.key !== 'scope'"
                      :disabled="busy"
                      rows="4"
                    ></textarea
                    ><input
                      v-else
                      v-model.trim="answers[f.key]"
                      :type="f.type === 'url' ? 'url' : 'text'"
                      :maxlength="f.max"
                      :required="f.key !== 'website'"
                      :disabled="busy"
                    /><small v-if="f.key === 'investorType'" class="field-help"
                      >Choose your own profile or the organisation you represent.</small
                    ></label
                  >
                </template>
                <fieldset
                  v-if="
                    group === 1 &&
                    ((currentAudience === 'investor' && answers.participation !== 'introduction') || currentAudience === 'merchant')
                  "
                  :disabled="busy"
                >
                  <legend>
                    {{ currentAudience === 'investor' ? 'What amount are you considering?' : 'Processing volume' }} <small>Optional</small>
                  </legend>
                  <p class="outreach-small">
                    An estimate is fine. You can leave this undecided. This is context for discussion, not a payment or commitment.
                  </p>
                  <div class="question-choices">
                    <label class="question-choice" :class="{ selected: answers.amountStatus !== 'stated' }"
                      ><input
                        v-model="answers.amountStatus"
                        type="radio"
                        name="amountStatus"
                        :value="currentAudience === 'investor' ? 'undecided' : 'unknown'"
                      /><span>{{ currentAudience === 'investor' ? 'Not decided yet' : 'Not sure yet' }}</span></label
                    ><label class="question-choice" :class="{ selected: answers.amountStatus === 'stated' }"
                      ><input v-model="answers.amountStatus" type="radio" name="amountStatus" value="stated" /><span
                        >Share an indicative amount</span
                      ></label
                    >
                  </div>
                  <div v-if="answers.amountStatus === 'stated'" class="outreach-grid outreach-amount">
                    <label
                      >Amount<input
                        v-model.trim="answers.amount"
                        type="text"
                        inputmode="decimal"
                        pattern="(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?"
                        maxlength="60"
                        required
                        aria-describedby="amount-help" /></label
                    ><label
                      >Currency<select v-model="answers.currency" required aria-label="Currency">
                        <option disabled value="">Choose currency</option>
                        <option v-for="currency in filteredCurrencies" :key="currency.code" :value="currency.code">
                          {{ currency.name }} · {{ currency.code }}
                        </option>
                      </select></label
                    ><label class="currency-search"
                      >Find a currency<input v-model="currencySearch" type="search" placeholder="Search by name or code" /></label
                    ><label v-if="currentAudience === 'merchant'"
                      >Volume period<select v-model="answers.period" required>
                        <option disabled value="">Choose period</option>
                        <option value="daily">Daily</option>
                        <option value="monthly">Monthly</option>
                        <option value="annual">Annual</option>
                      </select></label
                    >
                    <p id="amount-help" class="outreach-small">Use digits and an optional decimal point. No commas or currency symbols.</p>
                  </div>
                </fieldset>
                <label v-if="group === 1"
                  >When would you consider taking part?<select v-model="answers.timing" required :disabled="busy">
                    <option disabled value="">Select an option</option>
                    <option v-for="o in timing" :key="o[0]" :value="o[0]">{{ o[1] }}</option>
                  </select></label
                >
                <label v-if="group === 1"
                  >What would you like us to know? <small>Optional</small
                  ><textarea
                    v-model.trim="answers.message"
                    maxlength="2000"
                    rows="3"
                    :disabled="busy"
                    placeholder="A question, an introduction, or a little more context."
                  ></textarea>
                </label>
              </div>
              <div class="outreach-actions">
                <button
                  type="button"
                  class="outreach-text-button"
                  :disabled="busy"
                  @click="group ? goGroup(group - 1) : (screen = 'welcome')"
                >
                  ← Back</button
                ><button type="submit" class="outreach-primary" :disabled="busy">
                  {{ group === 1 ? 'Review your answers' : 'Continue' }} <span aria-hidden="true">→</span>
                </button>
              </div>
            </form>
            <div v-else class="outreach-review">
              <p class="section-description">Take a moment to check your answers. Once saved, your original responses stay preserved.</p>
              <dl>
                <div v-for="row in reviewRows" :key="row.label">
                  <dt>{{ row.label }}</dt>
                  <dd>{{ row.value }}</dd>
                </div>
              </dl>
              <div class="outreach-actions">
                <button type="button" class="outreach-text-button" :disabled="busy" @click="goGroup(1)">← Edit answers</button
                ><button type="button" class="outreach-primary" :disabled="busy" @click="saveAnswers">
                  {{ busy ? 'Saving…' : 'Send enquiry' }} <span aria-hidden="true">→</span>
                </button>
              </div>
            </div>
            <details class="recovery-options draft-recovery">
              <summary>Draft and recovery</summary>
              <p class="outreach-small draft-status" role="status">
                {{
                  !state.storageAvailable
                    ? 'Draft in this page'
                    : !state.draftStored
                      ? 'Saving draft…'
                      : remember
                        ? 'Draft kept on this device'
                        : 'Draft kept in this tab'
                }}
                · {{ savedCount }} of {{ draft.contact.interests.length }} questionnaires submitted.
                <button type="button" class="outreach-inline-link" :disabled="busy" @click="reopen">Check saved progress</button>
              </p>
            </details>
          </template>
          <div v-else-if="complete" class="outreach-complete">
            <div class="completion-mark" aria-hidden="true">✓</div>

            <p>
              <template v-if="draft.contact.interests.includes('investor')">The team reviews enquiries before arranging calls.</template
              ><template v-else>The team will review your enquiry.</template> We’ll use {{ draft.contact.email }} for any follow-up.
            </p>
            <ul>
              <li v-for="audience in draft.contact.interests" :key="audience">{{ audienceLabel(audience) }} <span>Saved ✓</span></li>
            </ul>
            <button type="button" class="outreach-text-button" @click="forget">Forget this draft on my device</button>
          </div>
          <div v-else>
            <p>Your answers are saved. Check the latest progress to continue.</p>
            <button type="button" class="outreach-secondary" :disabled="busy" @click="reopen">Check saved progress</button>
          </div>
        </template>
      </div>
    </section>
    <div class="privacy-entry">
      <button type="button" class="outreach-text-button" @click="privacyOpen = true">Privacy &amp; your enquiry ↗</button>
    </div>
    <section v-if="privacyOpen" class="outreach-privacy" aria-labelledby="privacy-heading">
      <button type="button" class="outreach-text-button" @click="privacyOpen = false">← Return to your enquiry</button>
      <h2 id="privacy-heading" ref="privacyHeading" tabindex="-1">Your enquiry, thoughtfully handled.</h2>
      <p>
        We collect your contact details, selected interests and the answers you choose to save so the INTAFACED team can review and reply to
        your enquiry. Optional marketing permission is separate.
      </p>
      <p>
        Your original saved answers stay with the team. A local draft helps you finish; it is not a confirmation that an answer has been
        submitted. Device recovery is optional, encrypted and limited to this browser. It cannot be transferred with a link or recovered by
        matching an email address.
      </p>
      <p v-if="draft">
        Local access expires {{ expiryLabel }}. You can forget it on this device at any time; this does not delete your saved enquiry.
      </p>
      <p v-if="publicInfo.contactUrl">
        For questions about your saved enquiry or personal information, <a :href="publicInfo.contactUrl">contact the INTAFACED team</a>.
      </p>
      <p v-else>You can ask about your saved information or request a correction when the team follows up.</p>
      <p v-if="publicInfo.retentionNotice">{{ publicInfo.retentionNotice }}</p>
      <button v-if="resumeAvailable" type="button" class="outreach-secondary" @click="forget">Forget local draft</button>
    </section>
  </div>
</template>

<script>
import { mutate } from '../../config/intafaced.js';
let intake = require('../../assets/js/outreach-intake.js');
let formatReviewAmount = require('../../assets/js/outreach-review.js').formatReviewAmount;
let publicInfo = require('../../assets/js/outreach-public-info.js').publicInfo;
let createDraftStorage = require('../../assets/js/outreach-draft-storage.js').createDraftStorage;
let countries = require('../../assets/js/outreach-countries.js').countryOptions('en');
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
export default {
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
      heroDesktop: require('../../assets/images/outreach/graphite-fins-desktop.webp'),
      heroPhone: require('../../assets/images/outreach/graphite-fins-phone.webp'),
      audiences: AUDIENCES,
      countries: countries,
      currencies: currencyOptions(),
      timing: intake.timing,
      contact: this.emptyContact(),
      answers: {},
      group: 0,
      interestsOpen: false,
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
  },
  computed: {
    investorEntry() {
      return intake.audienceForPath(this.$route.path) === 'investor';
    },
    continuationUnavailable() {
      return /continuation_invalid/.test(this.errorCode);
    },
    draft() {
      return this.state.draft;
    },
    resumeAvailable() {
      return !!this.state.local;
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
    visibleFields() {
      return this.group === 0 ? this.fields : [];
    },
    complete() {
      return this.draft && !!this.draft.completedAt && this.savedCount === this.draft.contact.interests.length;
    },
    savedStageMessage() {
      if (this.complete) return 'Your details and answers are saved.';
      if (this.group === 2) return 'Your details are saved. Review your answers before sending your enquiry.';
      return 'Your details are saved. Continue with a few questions.';
    },
    groupLabels() {
      return ['About you', 'Context', 'Review'];
    },
    progressLabel() {
      return !this.draft
        ? '01 / YOUR DETAILS'
        : this.complete
          ? 'ENQUIRY COMPLETE'
          : this.audienceLabel(this.currentAudience).toUpperCase() + ' · ' + (this.group + 1) + ' OF 3';
    },
    stepTitle() {
      return !this.draft
        ? 'Tell us about yourself'
        : this.complete
          ? 'Your enquiry is with the team.'
          : this.group === 2
            ? 'Review your answers'
            : this.group === 1
              ? 'Make it personal.'
              : {
                  investor: 'Investor enquiry',
                  trader: 'Tell us about your trading interests',
                  merchant: 'Tell us about your payment needs',
                  academy: 'What would you like to learn?',
                  partner: 'Tell us about a potential collaboration',
                }[this.currentAudience] || 'Your enquiry';
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
  watch: {
    currentAudience: {
      immediate: true,
      handler() {
        this.resetAnswers();
      },
    },
    answers: {
      deep: true,
      handler() {
        this.storeUi();
      },
    },
    'answers.participation': function (value) {
      if (value === 'introduction') {
        this.answers.amountStatus = 'undecided';
        this.answers.amount = '';
        this.answers.currency = '';
      }
    },
    remember() {
      this.storeUi();
    },
    privacyOpen(value) {
      if (value)
        this.$nextTick(() => {
          this.$refs.privacyHeading.focus();
          this.$refs.privacyHeading.scrollIntoView({ block: 'start' });
        });
      else this.focusHeading();
    },
    '$route.path': function (path) {
      if (!this.draft && !this.state.local) {
        this.contact.interests = [intake.audienceForPath(path)].filter(Boolean);
        this.screen = 'welcome';
      }
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
        interests: [intake.audienceForPath(this.$route.path)].filter(Boolean),
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
      this.screen = 'contact';
      this.focusHeading();
    },
    beginWithInterests() {
      this.interestsOpen = true;
      this.begin();
    },
    focusHeading() {
      this.$nextTick(() => {
        let heading = this.$refs.stepHeading || this.$refs.welcomeTitle;
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
      this.group = this.groups[this.currentAudience] || 0;
      this.countrySearch = '';
      this.currencySearch = '';
    },
    storeUi() {
      if (!this.controller || !this.currentAudience) return;
      this.$set(this.forms, this.currentAudience, JSON.parse(JSON.stringify(this.answers)));
      this.$set(this.groups, this.currentAudience, this.group);
      this.controller.saveUi({ forms: this.forms, groups: this.groups, remember: this.remember });
    },
    goGroup(index) {
      this.group = index;
      this.storeUi();
      this.focusHeading();
    },
    advance() {
      this.error = '';
      this.errorCode = '';
      if (this.group === 0 && this.fields.some((f) => (f.type === 'checks' || f.type === 'countries') && !this.answers[f.key].length)) {
        this.error = 'Choose at least one option for each required selection.';
        return;
      }
      if (this.group === 1) {
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
            this.$delete(this.forms, q.audience);
            this.$delete(this.groups, q.audience);
          });
          await this.controller.saveUi({ forms: this.forms, groups: this.groups, remember: this.remember });
        }
        this.focusHeading();
      } catch (e) {
        this.errorCode = e.code || 'unreachable';
        this.error = intake.errorCopy(this.errorCode);
        this.$nextTick(() => {
          if (this.$refs.error) this.$refs.error.focus();
        });
      } finally {
        this.busy = false;
      }
    },
    saveContact() {
      if (!this.storageReady) return;
      this.controller.saveUi({ forms: this.forms, groups: this.groups, remember: this.remember });
      return this.run(() =>
        this.controller.capture(this.contact, this.$route.query.source).then(() => {
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
      });
    },
    openAddInterests() {
      this.selectedInterests = this.draft.contact.interests.slice();
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
        this.screen = 'welcome';
      });
    },
  },
};
</script>

<style scoped>
@font-face {
  font-family: 'Outreach Inter';
  src: url('../../assets/fonts/inter-latin.woff2') format('woff2');
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  unicode-range:
    U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20A0-20AB, U+20AD-20C0,
    U+2113, U+2C60-2C7F, U+A720-A7FF;
}
@font-face {
  font-family: 'Outreach Inter';
  src: url('../../assets/fonts/inter-latin-ext.woff2') format('woff2');
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
}
.outreach-page {
  --o-bg: #090a0b;
  --o-surface: #111416;
  --o-raised: #191c1e;
  --o-border: #2c3335;
  --o-text: #f2f5ef;
  --o-muted: #a3ada5;
  --o-accent: #b9f65a;
  --o-hover: #d0ff87;
  --o-ink: #11170a;
  --o-control-border: #5b6657;
  --ix-orange: var(--o-accent);
  --ix-orange-soft: rgba(185, 246, 90, 0.14);
  --ix-radius-sm: 7px;
  --ix-text: var(--o-text);
  --ix-hairline: var(--o-border);
  background: var(--o-bg);
  color: var(--o-text);
  font-family: 'Outreach Inter', Inter, Arial, sans-serif;
  min-height: calc(100svh - 170px);
}
.outreach-page button,
.outreach-page input,
.outreach-page select,
.outreach-page textarea {
  font: inherit;
}
.outreach-welcome {
  min-height: min(900px, 100svh);
  max-width: 1440px;
  position: relative;
  margin: -94px auto 0;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  padding: 150px 7.2% 105px;
  isolation: isolate;
}
.welcome-content {
  position: relative;
  z-index: 1;
  text-align: left;
  max-width: 550px;
  animation: welcome-arrive 0.35s ease-out both;
}
.outreach-hero-art {
  position: absolute;
  inset: 0;
  z-index: -1;
  pointer-events: none;
}
.outreach-hero-art img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
  object-position: center;
}
.outreach-welcome::after {
  content: '';
  position: absolute;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  background: linear-gradient(90deg, rgba(9, 10, 11, 0.18), transparent 72%), linear-gradient(0deg, #090a0b, transparent 18%);
}
.outreach-eyebrow {
  color: var(--o-muted);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.14em;
  line-height: 1.7;
  margin: 0 0 20px;
}
.status-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--o-accent);
  margin: 0 7px 1px 0;
}
.welcome-content h1 {
  color: var(--o-text);
  font-size: clamp(54px, 5.2vw, 74px);
  font-weight: 600;
  letter-spacing: -0.06em;
  line-height: 1.04;
  margin: 0 0 24px;
  text-wrap: balance;
}
.welcome-content h1 span {
  color: var(--o-text);
}
.welcome-description {
  font-size: 15px;
  line-height: 1.8;
  color: #bec6c4;
  max-width: 43ch;
  margin: 0 0 28px;
  text-wrap: balance;
}
.outreach-workspace {
  max-width: 1120px;
  margin: auto;
  display: grid;
  grid-template-columns: 230px minmax(0, 1fr);
  gap: 88px;
  padding: 48px 32px 72px;
}
.conversation-art {
  height: 116px;
  overflow: hidden;
  border-radius: 10px;
  margin: 24px 0;
  opacity: 0.85;
  border: 1px solid var(--o-border);
}
.conversation-art img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
}
.recovery-options {
  margin: 18px 0;
  border: 1px solid var(--o-border);
  border-radius: 9px;
  padding: 0 14px;
}
.recovery-options summary {
  cursor: pointer;
  min-height: 44px;
  display: list-item;
  align-content: center;
  color: var(--o-muted);
  font-size: 11px;
}
.recovery-options summary span {
  margin-left: 8px;
  opacity: 0.7;
}
.recovery-options summary:focus-visible {
  outline: 2px solid var(--o-accent);
  outline-offset: 4px;
}
.recovery-options[open] {
  padding-bottom: 8px;
}
.recovery-options .outreach-consent {
  margin-top: 6px;
}
.recovery-options .consent-help {
  margin-bottom: 12px;
}
.draft-recovery {
  margin-top: 24px;
  border: 0;
  padding: 0;
}
.outreach-rail h2 {
  font-size: 31px;
  font-weight: 500;
  line-height: 1.18;
  letter-spacing: -0.045em;
  color: var(--o-text);
  margin: 0 0 20px;
}
.outreach-rail > p {
  font-size: 13px;
  color: var(--o-muted);
  line-height: 1.8;
}
.journey-steps {
  list-style: none;
  padding: 0;
  margin: 40px 0 45px;
}
.journey-steps li {
  display: flex;
  align-items: center;
  gap: 14px;
  min-height: 58px;
  color: var(--o-muted);
  font-size: 13px;
  border-top: 1px solid var(--o-border);
}
.journey-steps li:last-child {
  border-bottom: 1px solid var(--o-border);
}
.journey-steps li > span {
  font-size: 10px;
  color: #899581;
}
.journey-steps .active {
  color: var(--o-text);
}
.journey-steps .active > span,
.journey-steps .done > span {
  color: var(--o-accent);
}
.journey-steps small {
  margin-left: auto;
  font-size: 10px;
}
.outreach-rail .rail-note {
  font-size: 11px;
  margin-bottom: 28px;
}
.outreach-form-panel {
  min-width: 0;
}
.outreach-form-panel > h1 {
  font-weight: 500;
  color: var(--o-text);
  font-size: clamp(28px, 3vw, 38px);
  letter-spacing: -0.045em;
  line-height: 1.18;
  margin: 0 0 16px;
  outline: none;
}
.section-description {
  color: var(--o-muted);
  font-size: 14px;
  line-height: 1.8;
  margin-bottom: 20px;
  max-width: 58ch;
}
.outreach-small {
  font-size: 11px;
  line-height: 1.8;
  color: var(--o-muted);
  margin: 12px 0;
}
.outreach-page form {
  margin: 0;
}
.outreach-page fieldset {
  min-width: 0;
  border: 0;
  padding: 0;
  margin: 0 0 24px;
}
.outreach-page legend {
  font-size: 14px;
  font-weight: 500;
  color: var(--o-text);
  margin-bottom: 12px;
}
.outreach-page legend small,
.outreach-grid label small,
.outreach-questions label small {
  color: var(--o-muted);
  font-size: 10px;
  font-weight: 400;
  margin-left: 6px;
}
.outreach-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 22px 18px;
  margin: 26px 0;
}
.outreach-grid label,
.outreach-questions > label,
.outreach-amount label {
  display: block;
  font-size: 14px;
  font-weight: 500;
  color: var(--o-text);
  line-height: 1.7;
}
.outreach-page input:not([type='checkbox']):not([type='radio']),
.outreach-page select,
.outreach-page textarea {
  display: block;
  width: 100%;
  max-width: 100%;
  margin-top: 8px;
  min-height: 46px;
  padding: 11px 13px;
  background: var(--o-surface) !important;
  border: 1px solid var(--o-control-border) !important;
  border-radius: 7px;
  color: var(--o-text) !important;
  font-size: 14px;
  transition:
    border-color 0.15s,
    background 0.15s;
}
.outreach-page input::placeholder,
.outreach-page textarea::placeholder {
  color: #899581 !important;
}
.outreach-page select {
  appearance: auto;
  color-scheme: dark;
}
.outreach-page select[multiple] {
  min-height: 160px;
}
.outreach-page textarea {
  resize: vertical;
}
.outreach-page input:hover,
.outreach-page select:hover,
.outreach-page textarea:hover {
  border-color: #53604c;
}
.outreach-page :is(input, select, textarea, button, a):focus-visible {
  outline: 2px solid var(--o-accent);
  outline-offset: 4px;
}
.outreach-page input[type='checkbox'],
.outreach-page input[type='radio'] {
  width: 16px;
  height: 16px;
  accent-color: var(--o-accent);
  flex: 0 0 auto;
}
.selected-interest-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 0;
  border-block: 1px solid var(--o-border);
  font-size: 12px;
  margin: 22px 0;
}
.selected-interest-summary > span {
  min-width: 0;
}
.saved-summary {
  margin: 16px 0 10px;
  padding-block: 10px;
  font-size: 14px;
  color: var(--o-muted);
}
.saved-dot {
  color: var(--o-accent);
  margin-right: 5px;
}
.outreach-interest {
  display: flex;
  align-items: center;
  gap: 13px;
  border: 1px solid var(--o-control-border);
  background: var(--o-surface);
  padding: 17px;
  margin: 8px 0;
  border-radius: 8px;
  cursor: pointer;
  transition:
    border-color 0.15s,
    background 0.15s;
}
.outreach-interest > span:nth-child(2) {
  flex: 1;
  min-width: 0;
}
.outreach-interest strong {
  display: block;
  font-size: 12px;
  font-weight: 500;
}
.outreach-interest small {
  display: block;
  color: var(--o-muted);
  font-size: 11px;
  margin-top: 4px;
  line-height: 1.7;
}
.outreach-interest.selected,
.question-choice.selected {
  border-color: #94bd56;
  background: #1a2116;
}
.choice-mark {
  color: var(--o-accent);
  font-size: 13px;
  margin-left: auto;
}
.outreach-consent {
  min-height: 44px;
  padding-top: 5px;
  display: flex;
  gap: 11px;
  align-items: flex-start;
  font-size: 11px;
  line-height: 1.8;
  color: #c4ccc2;
  margin: 18px 0 0;
  cursor: pointer;
}
.outreach-consent input {
  margin-top: 3px;
}
.consent-help {
  margin: 5px 0 22px 27px;
}
.outreach-primary,
.outreach-secondary {
  display: inline-flex;
  justify-content: center;
  align-items: center;
  gap: 20px;
  min-height: 46px;
  padding: 13px 20px;
  border-radius: 7px;
  font-size: 12px !important;
  font-weight: 600 !important;
  cursor: pointer;
  transition:
    background 0.15s,
    transform 0.15s;
}
.outreach-primary {
  color: var(--o-ink);
  background: var(--o-accent);
  border: 1px solid var(--o-accent);
}
.outreach-primary:hover:not(:disabled) {
  background: var(--o-hover);
  border-color: var(--o-hover);
  transform: translateY(-1px);
}
.outreach-secondary {
  background: var(--o-raised);
  color: var(--o-text);
  border: 1px solid var(--o-border);
}
.outreach-text-button {
  border: 0;
  background: none;
  color: var(--o-muted);
  padding: 10px 0;
  font-size: 11px !important;
  cursor: pointer;
  min-height: 44px;
  text-align: left;
}
.outreach-text-button:hover {
  color: var(--o-text);
}
.outreach-inline-link {
  background: none;
  border: 0;
  border-bottom: 1px solid #66735b;
  color: var(--o-text);
  font-size: inherit !important;
  padding: 2px 0;
  cursor: pointer;
}
.outreach-page button:disabled {
  opacity: 0.5;
  cursor: default;
  transform: none;
}
.outreach-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding-top: 22px;
  margin-top: 20px;
  border-top: 1px solid var(--o-border);
}
.question-segments {
  display: flex;
  gap: 8px;
  margin: 16px 0 18px;
}
.question-segments button {
  display: flex;
  align-items: center;
  gap: 9px;
  flex: 1;
  background: none;
  border: 0;
  border-top: 2px solid var(--o-border);
  padding: 11px 0;
  color: var(--o-muted);
  text-align: left;
  font-size: 12px !important;
  min-height: 44px;
  cursor: pointer;
}
.question-segments button span {
  font-size: 9px;
}
.question-segments button.active {
  border-color: var(--o-accent);
  color: var(--o-text);
}
.question-segments button.passed {
  border-color: #72874f;
}
.question-segments button:disabled {
  opacity: 1;
  color: #758174;
}
.outreach-questions {
  display: grid;
  gap: 20px;
  animation: question-arrive 0.18s ease-out;
}
.outreach-questions fieldset {
  margin: 0;
}
.question-choices {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.question-choice {
  display: flex;
  align-items: center;
  gap: 9px;
  flex: 1 1 130px;
  min-height: 60px;
  padding: 12px 14px;
  border: 1px solid var(--o-control-border);
  border-radius: 9px;
  background: var(--o-surface);
  font-size: 14px;
  line-height: 1.6;
  cursor: pointer;
}
.question-choice input {
  margin: 0;
}
.currency-search {
  grid-column: 1/-1;
}
#amount-help {
  grid-column: 1/-1;
  margin: 0;
}
.outreach-review dl {
  margin: 24px 0;
}
.outreach-review dl > div {
  padding: 12px 0;
  border-bottom: 1px solid var(--o-border);
}
.outreach-review dt {
  font-size: 10px;
  color: var(--o-muted);
  margin-bottom: 5px;
}
.outreach-review dd {
  margin: 0;
  color: var(--o-text);
  font-size: 13px;
  line-height: 1.7;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.outreach-notice {
  color: #f1dabc;
  background: #271f12;
  border: 1px solid #6c532b;
  border-radius: 8px;
  padding: 14px;
  margin: 20px 0;
  font-size: 12px;
  line-height: 1.8;
}
.outreach-resume {
  font-size: 13px;
  color: var(--o-muted);
  line-height: 1.8;
  padding: 24px 0;
}
.outreach-resume .outreach-text-button {
  display: block;
  margin-top: 12px;
}
.outreach-complete {
  padding: 12px 0;
}
.completion-mark {
  display: flex;
  width: 48px;
  height: 48px;
  border: 1px solid #627c3d;
  border-radius: 50%;
  align-items: center;
  justify-content: center;
  color: var(--o-accent);
  font-size: 19px;
  margin-bottom: 25px;
  background: #172010;
}
.outreach-complete h2 {
  color: var(--o-text);
  font-size: 32px;
  line-height: 1.2;
  letter-spacing: -0.045em;
  font-weight: 500;
  margin-bottom: 22px;
}
.outreach-complete p {
  max-width: 48ch;
  font-size: 14px;
  line-height: 1.8;
  color: var(--o-muted);
}
.outreach-complete ul {
  list-style: none;
  padding: 0;
  margin: 25px 0;
}
.outreach-complete li {
  border-bottom: 1px solid var(--o-border);
  padding: 13px 0;
  font-size: 12px;
  display: flex;
  justify-content: space-between;
}
.outreach-complete li span {
  color: var(--o-accent);
  font-size: 10px;
}
.outreach-privacy {
  max-width: 700px;
  margin: 0 auto;
  border-top: 1px solid var(--o-border);
  padding: 40px 24px 60px;
}
.outreach-privacy h2 {
  color: var(--o-text);
  font-size: 27px;
  line-height: 1.3;
  margin: 20px 0;
  letter-spacing: -0.03em;
}
.outreach-privacy p {
  color: var(--o-muted);
  font-size: 14px;
  line-height: 1.9;
}
.outreach-privacy a {
  color: var(--o-accent);
  text-decoration: underline;
}
.field-help {
  display: block;
  font-size: 10px;
  line-height: 1.7;
  color: var(--o-muted);
  margin: 6px 0 0 !important;
}
.saved-contact-details {
  color: var(--o-muted);
  margin: 0 0 10px;
  font-size: 14px;
}
.saved-contact-details summary {
  cursor: pointer;
  min-height: 32px;
  display: flex;
  align-items: center;
}
.saved-contact-details summary:focus-visible {
  outline: 2px solid var(--o-accent);
  outline-offset: 3px;
}
.saved-contact-details dl > div {
  display: flex;
  gap: 15px;
  padding: 7px 0;
}
.saved-contact-details dt {
  width: 80px;
}
.saved-contact-details dd {
  color: var(--o-text);
  margin: 0;
  overflow-wrap: anywhere;
}
.saved-contact-details a {
  color: var(--o-accent);
  text-decoration: underline;
}
.draft-status {
  margin-top: 26px;
}
.expiry-notice {
  max-width: 700px;
  margin: 20px auto;
}
.privacy-entry {
  max-width: 1160px;
  padding: 0 32px 24px;
  margin: auto;
  text-align: right;
}
.is-welcome .privacy-entry {
  position: relative;
  margin-top: -34px;
  padding-bottom: 12px;
  z-index: 2;
}
@keyframes welcome-arrive {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
@keyframes question-arrive {
  from {
    opacity: 0.5;
    transform: translateY(5px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
@media (max-width: 900px) {
  .outreach-workspace {
    grid-template-columns: 210px minmax(0, 1fr);
    gap: 38px;
    padding: 42px 24px 70px;
  }
}
@media (max-width: 680px) {
  .outreach-welcome {
    min-height: 0;
    padding: 0 22px 68px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    align-items: stretch;
  }
  .outreach-hero-art {
    position: relative;
    inset: auto;
    width: calc(100% + 44px);
    margin: -14px -22px -22px;
    aspect-ratio: 5 / 3;
  }
  .outreach-hero-art img {
    object-fit: contain;
  }
  .outreach-hero-art::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(0deg, #090a0b, transparent 42%), linear-gradient(180deg, #090a0b, transparent 14%);
  }
  .outreach-welcome::after {
    display: none;
  }
  .welcome-content {
    max-width: none;
    padding: 0;
  }
  .welcome-content h1 {
    font-size: clamp(43px, 11.8vw, 54px);
    line-height: 1.07;
    letter-spacing: -0.055em;
    margin-bottom: 20px;
  }
  .welcome-content .outreach-eyebrow {
    font-size: 9px;
    margin-bottom: 16px;
  }
  .welcome-description {
    font-size: 14px;
    max-width: 43ch;
    line-height: 1.8;
    margin-bottom: 24px;
    text-wrap: pretty;
  }
  .welcome-cta {
    min-width: 180px;
  }
  .outreach-workspace {
    display: block;
    padding: 30px 22px 60px;
  }
  .outreach-rail {
    display: none;
  }
  .question-choice {
    flex-basis: 100%;
    min-height: 58px;
  }
  .outreach-rail > h2,
  .outreach-rail > p,
  .outreach-rail > .outreach-eyebrow,
  .outreach-rail > .outreach-text-button {
    display: none;
  }
  .journey-steps {
    display: flex;
    margin: 0 0 33px;
    gap: 12px;
  }
  .journey-steps li {
    flex: 1;
    border: 0;
    min-height: 30px;
    gap: 6px;
    font-size: 9px;
    white-space: nowrap;
  }
  .journey-steps li:last-child {
    border: 0;
  }
  .journey-steps li > span {
    font-size: 8px;
  }
  .journey-steps small {
    display: none;
  }
  .outreach-grid {
    grid-template-columns: 1fr;
    gap: 19px;
  }
  .outreach-form-panel > h1 {
    font-size: 30px;
  }
  .selected-interest-summary {
    font-size: 14px;
  }
  .outreach-primary {
    padding: 13px 16px;
  }
  .question-choice {
    flex-basis: 100%;
  }
  .outreach-page input:not([type='checkbox']):not([type='radio']),
  .outreach-page select,
  .outreach-page textarea {
    font-size: 16px;
  }
  .outreach-actions {
    position: sticky;
    bottom: 0;
    z-index: 2;
    background: var(--o-bg);
    padding: 14px 0 max(14px, env(safe-area-inset-bottom));
    box-shadow: 0 -14px 20px var(--o-bg);
  }
  .outreach-page {
    scroll-padding-bottom: 20px;
  }
}
@media (max-width: 360px) {
  .welcome-content h1 {
    font-size: 49px;
  }
  .outreach-workspace {
    padding-inline: 16px;
  }
  .outreach-primary {
    padding-inline: 13px;
    font-size: 11px !important;
  }
  .outreach-actions {
    gap: 8px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .outreach-page * {
    animation: none !important;
    transition: none !important;
    scroll-behavior: auto !important;
  }
}
</style>
