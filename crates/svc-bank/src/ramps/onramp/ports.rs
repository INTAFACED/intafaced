//! The ports a customer ramp quote reads (`ramps/customer-ports.ts`). Production leaves every one unset: a quote, a fee
//! and a hosted payment URL come from the port or they are not returned.

use service_kit::time::Instant;

use crate::errors::Refusal;

/// `ONRAMP_METHODS`.
pub const ONRAMP_METHODS: [&str; 4] = ["card", "bank_transfer", "pay_by_bank", "wallet_pay"];

/// What a rate source is asked (`OnrampQuoteSource.quote`'s input): the amount canonical, the country upper case.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuoteAsk {
    pub asset_id: String,
    pub amount: String,
    pub method: String,
    pub country: String,
}

/// `OnrampQuoteTerms`: the source's own decimals, checked by the quote before anything is kept. `expires_at` is
/// `None` for an expiry that is no date.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuoteTerms {
    pub pay_amount: String,
    pub fee: String,
    pub rate: String,
    pub pay_currency: Option<String>,
    pub expires_at: Option<Instant>,
    pub delivery_estimate: Option<String>,
}

/// `OnrampQuoteSource`. `now` is the door's clock.
pub trait QuoteSource: Send + Sync {
    fn quote(&self, ask: &QuoteAsk, now: Instant) -> Result<Option<QuoteTerms>, Refusal>;
}

/// What the partner is asked to open (`OnrampPaymentPort.open`'s input).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenAsk {
    pub onramp_id: String,
    pub quote_id: String,
    pub method: String,
    pub user_id: String,
    pub asset_id: String,
    pub amount: String,
    pub wallet_address: Option<String>,
    pub quote_expires_at: Option<Instant>,
}

/// `OnrampBankInstruction`, each field as the partner gave it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct BankInstruction {
    pub reference: Option<String>,
    pub account_name: Option<String>,
    pub account_ref: Option<String>,
}

/// `OnrampPaymentInstruction`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Instruction {
    pub partner_rail: Option<String>,
    pub hosted_url: Option<String>,
    pub bank: Option<BankInstruction>,
}

/// `OnrampPaymentPort`.
pub trait PaymentPort: Send + Sync {
    /// LOCAL TEST: the stand-in serves its page on a loopback http address. Never set by a real partner.
    fn loopback_pages(&self) -> bool {
        false
    }
    fn open(&self, ask: &OpenAsk, now: Instant) -> Result<Option<Instruction>, Refusal>;
}

/// What a fee source is asked (`OfframpFeeSource.quote`'s input).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeeAsk {
    pub asset_id: String,
    pub amount: String,
    pub destination_ref: String,
}

/// `OfframpFeeTerms`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeeTerms {
    pub fee: String,
    pub net_amount: String,
    pub expires_at: Option<Instant>,
}

/// `OfframpFeeSource`.
pub trait FeeSource: Send + Sync {
    fn quote(&self, ask: &FeeAsk, now: Instant) -> Result<Option<FeeTerms>, Refusal>;
}
