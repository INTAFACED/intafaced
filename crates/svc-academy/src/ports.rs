//! What svc-academy asks outside itself, one trait each, with the stand-in the TypeScript uses when the owner has not
//! wired the real one (or in tests). The real clients (svc-token's stake, svc-identity's rank perks, approvals and
//! linked wallets, svc-trade's paper flag, svc-ledger's recipes, the payment chain's RPC, the refund signer, the video
//! store, LiveKit and NATS) are a slice's work: each is written against its trait here and wired in `main.rs`.
//!
//! A stand-in refuses or reports itself unusable; none admits, invents a figure or pretends to be wired.

use service_kit::json::Json;
use service_kit::money::Amount;
use service_kit::time::Instant;

use crate::access::ACTION_APPROVAL_UNWIRED;
use crate::errors::{AcademyError, Refusal};

/// `StakeSource`: how much IFC a user has staked at svc-token.
pub trait Stake: Send + Sync {
    fn stake_of(&self, user_id: &str) -> Result<Amount, Refusal>;
}

/// `FixedStake`: the same stake for everyone (tests and a stack without svc-token).
pub struct FixedStake(pub Amount);

impl Stake for FixedStake {
    fn stake_of(&self, _user_id: &str) -> Result<Amount, Refusal> {
        Ok(self.0)
    }
}

/// `HostRightsSource`: a user's rank perks at svc-identity (`RankPerks`, as its JSON).
pub trait HostRights: Send + Sync {
    fn perks_of(&self, user_id: &str) -> Result<Json, Refusal>;
}

/// `BaseHostRights`: rank 0 for everyone, so nobody hosts.
pub struct BaseHostRights;

/// `BASE_PERKS` (`packages/contracts/src/identity.ts`).
pub fn base_perks() -> Json {
    Json::obj([
        ("feeDiscountBps", Json::int(0)),
        ("p2pLimitMultiplier", Json::int(1)),
        ("copyFollowerCap", Json::int(0)),
        ("lobbyHostRights", Json::Bool(false)),
        ("cardTier", Json::str("none")),
        ("otcAccess", Json::Bool(false)),
        ("launchpadTier", Json::int(0)),
    ])
}

impl HostRights for BaseHostRights {
    fn perks_of(&self, _user_id: &str) -> Result<Json, Refusal> {
        Ok(base_perks())
    }
}

/// `StreamCredential`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamCredential {
    pub url: String,
    /// Short-lived, per user, per session. Never logged.
    pub token: String,
    pub expires_at: Instant,
}

/// `StreamProvider`: the live room's SFU.
pub trait Stream: Send + Sync {
    /// Named in `/ready` and on spans.
    fn id(&self) -> &str;
    /// `streamProviderBoardCard`: usable, constructed, probed.
    fn usable(&self) -> bool;
    fn constructed(&self) -> bool;
    fn probed(&self) -> bool;
    fn open_room(&self, session_id: &str) -> Result<String, Refusal>;
    fn credential(
        &self,
        session_id: &str,
        stream_room: &str,
        user_id: &str,
        role: &str,
    ) -> Result<StreamCredential, Refusal>;
    fn close_room(&self, stream_room: &str) -> Result<(), Refusal>;
}

/// `NullStreamProvider`: no SFU is configured; opening a room or a credential refuses, closing is a no-op.
pub struct NullStream;

fn stream_unavailable(message: &str) -> Refusal {
    Refusal::Academy(AcademyError::new(message, "academy.stream_unavailable"))
}

impl Stream for NullStream {
    fn id(&self) -> &str {
        "null"
    }
    fn usable(&self) -> bool {
        false
    }
    fn constructed(&self) -> bool {
        false
    }
    fn probed(&self) -> bool {
        false
    }
    fn open_room(&self, _session_id: &str) -> Result<String, Refusal> {
        Err(stream_unavailable(
            "No streaming provider is configured — set ACADEMY_STREAM_PROVIDER and its URL (SOCKET §13 socket.stream-provider)",
        ))
    }
    fn credential(&self, _: &str, _: &str, _: &str, _: &str) -> Result<StreamCredential, Refusal> {
        Err(stream_unavailable(
            "No streaming provider is configured — this lobby can run as text and presence only (SOCKET §13 socket.stream-provider)",
        ))
    }
    fn close_room(&self, _stream_room: &str) -> Result<(), Refusal> {
        Ok(())
    }
}

/// `ActionApprovalConsumeInput`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalConsume {
    pub approval_id: String,
    pub operation_id: String,
    pub payload_hash: String,
    pub target_service: &'static str,
    pub target_id: String,
    pub expected_version: &'static str,
}

/// The consumed approval: who asked and who approved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsumedApproval {
    pub requester_id: String,
    pub approver_id: Option<String>,
}

/// `ActionApprovalConsumer`: consumes an identity-issued approval once.
pub trait Approvals: Send + Sync {
    fn consume(&self, input: &ApprovalConsume) -> Result<ConsumedApproval, Refusal>;
}

/// `unwiredApprovalConsumer`: `IDENTITY_URL` is unpublished, so nothing is approved.
pub struct UnwiredApprovals;

impl Approvals for UnwiredApprovals {
    fn consume(&self, _input: &ApprovalConsume) -> Result<ConsumedApproval, Refusal> {
        Err(Refusal::Approval {
            message: "IDENTITY_URL is unpublished; academy operator mutate does not invent a second person".to_owned(),
            code: ACTION_APPROVAL_UNWIRED.to_owned(),
        })
    }
}

/// `stubApprovalConsumer(approverId)`: tests only; every approval is consumed by `approverId` for `requester`.
pub struct StubApprovals(pub String);

impl Approvals for StubApprovals {
    fn consume(&self, _input: &ApprovalConsume) -> Result<ConsumedApproval, Refusal> {
        Ok(ConsumedApproval {
            requester_id: "requester".to_owned(),
            approver_id: Some(self.0.clone()),
        })
    }
}

/// `LinkedWalletsPort`: the wallets an account linked at svc-identity (as its JSON), or none when identity could not be
/// asked or read.
pub trait LinkedWallets: Send + Sync {
    fn read(&self, user_id: &str) -> Option<Json>;
    /// Whether identity is asked at all: without it nothing is sold (`CoursePurchaseDeps.wallets` null).
    fn wired(&self) -> bool {
        true
    }
}

/// No identity: no wallet is known, so nothing is sold.
pub struct NoLinkedWallets;

impl LinkedWallets for NoLinkedWallets {
    fn wired(&self) -> bool {
        false
    }
    fn read(&self, _user_id: &str) -> Option<Json> {
        None
    }
}

/// `ListedPaperFlag`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaperFlag {
    pub market_id: String,
    pub symbol: String,
    pub paper: bool,
}

/// `PaperMarketFlagPort`: whether svc-trade lists a market as paper.
pub trait PaperFlags: Send + Sync {
    fn lookup(&self, market_id: &str, symbol: &str) -> Result<Option<PaperFlag>, Refusal>;
}

/// No svc-trade: the flag cannot be read, so a paper workbook refuses.
pub struct NoPaperFlags;

impl PaperFlags for NoPaperFlags {
    fn lookup(&self, _market_id: &str, _symbol: &str) -> Result<Option<PaperFlag>, Refusal> {
        Err(Refusal::Academy(AcademyError::new(
            "the paper flag cannot be read: TRADE_URL is unset",
            "academy.paper_flag_unavailable",
        )))
    }
}

/// svc-ledger's `postRecipe`, through `packages/ledger-client`'s recipes only (AGENTS.md floor 1). A slice names the
/// recipe and its business idempotency key; the client never assembles entries.
pub trait Ledger: Send + Sync {
    fn post_recipe(
        &self,
        recipe: &str,
        idempotency_key: &str,
        input: &Json,
    ) -> Result<Json, Refusal>;
}

/// `TransferFact`: one token transfer the chain logged. Amounts in the token's smallest unit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransferFact {
    pub tx_hash: String,
    pub block_number: u64,
    pub from: String,
    pub to: String,
    pub amount: u128,
}

/// `TxFact`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TxFact {
    Unseen,
    Reverted {
        block_number: u64,
    },
    Mined {
        block_number: u64,
        confirmations: u64,
        transfers: Vec<TransferFact>,
    },
}

/// `PaymentChain`: the course payments' chain node.
pub trait Chain: Send + Sync {
    fn block_number(&self) -> Result<u64, Refusal>;
    fn transaction(&self, tx_hash: &str, token: &str) -> Result<TxFact, Refusal>;
    fn transfers(
        &self,
        token: &str,
        from: &str,
        to: &str,
        from_block: u64,
    ) -> Result<Vec<TransferFact>, Refusal>;
}

/// `RefundSend`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefundSend {
    pub key: String,
    pub chain_id: u64,
    pub token: String,
    pub to: String,
    /// In the token's smallest unit.
    pub amount: u128,
}

/// `RefundSender`: the transaction the signer sent for the key, or none when its answer was lost or unclear.
pub trait Refunds: Send + Sync {
    fn send(&self, input: &RefundSend) -> Result<Option<String>, Refusal>;
}

/// The video store's signed URLs (`VideoStorageConfig`).
pub trait ObjectStore: Send + Sync {
    fn signed_url(&self, key: &str, expires_at: Instant) -> Result<String, Refusal>;
    /// `isVideoStorageConfigured`: an endpoint, a bucket and keys are set.
    fn configured(&self) -> bool {
        true
    }
}

/// No video store: `academy.video_storage_unconfigured`.
pub struct NoObjectStore;

impl ObjectStore for NoObjectStore {
    fn configured(&self) -> bool {
        false
    }
    fn signed_url(&self, _key: &str, _expires_at: Instant) -> Result<String, Refusal> {
        Err(Refusal::Academy(AcademyError::new(
            "video storage is not configured",
            "academy.video_storage_unconfigured",
        )))
    }
}

/// The event bus's publish side (`JetStreamEventBus`): the certification XP awards and their reversals.
pub trait Bus: Send + Sync {
    /// Reported on `/ready`: `none` means nothing leaves this process.
    fn id(&self) -> &str;
    fn usable(&self) -> bool;
    /// Publishes one event, deduplicated by `msg_id`; the broker's acknowledgement or why it failed.
    fn publish(&self, subject: &str, msg_id: &str, payload: &Json) -> Result<(), String>;
}

/// `NullCertXpPublisher`: no bus; every publish is reported undelivered.
pub struct NoBus;

impl Bus for NoBus {
    fn id(&self) -> &str {
        "none"
    }
    fn usable(&self) -> bool {
        false
    }
    fn publish(&self, _subject: &str, _msg_id: &str, _payload: &Json) -> Result<(), String> {
        Err("no event bus: NATS was not reached at start-up".to_owned())
    }
}

/// The bus over NATS JetStream (`JetStreamEventBus`): publishes into the Academy's own stream, each event once per
/// idempotency key.
pub struct JetStreamBus(pub service_kit::nats::JetStream);

impl JetStreamBus {
    /// `JetStreamEventBus.connect({ servers, producer, streamPrefix, ownedStreams: ['academy'] })`.
    pub fn connect(url: &str, producer: &str, prefix: &str) -> Result<JetStreamBus, String> {
        let js =
            service_kit::nats::JetStream::connect(url, producer, std::time::Duration::from_secs(5))
                .map_err(|e| e.0)?;
        js.ensure_stream(&service_kit::nats::stream_config("academy", prefix))
            .map_err(|e| e.0)?;
        Ok(JetStreamBus(js))
    }
}

impl Bus for JetStreamBus {
    /// `BusCertXpPublisher.id`: what `/ready` and `certXpPlane` name.
    fn id(&self) -> &str {
        "bus"
    }
    fn usable(&self) -> bool {
        true
    }
    fn publish(&self, subject: &str, msg_id: &str, payload: &Json) -> Result<(), String> {
        self.0
            .publish(subject, msg_id, payload.compact().as_bytes())
            .map(|_| ())
            .map_err(|e| e.0)
    }
}

/// `PaymentSettings`: the owner's course-payment values. All set, or none.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaymentSettings {
    pub chain_id: i64,
    pub token: String,
    pub decimals: i64,
    pub asset: String,
    pub receiver: String,
    pub confirmations: i64,
}

/// Everything the service asks outside itself.
pub struct Ports {
    pub stake: Box<dyn Stake>,
    pub host_rights: Box<dyn HostRights>,
    pub stream: Box<dyn Stream>,
    /// `ACADEMY_STREAM_PROVIDER` as set, for `/ready`.
    pub stream_configured: Option<String>,
    pub approvals: Box<dyn Approvals>,
    pub wallets: Box<dyn LinkedWallets>,
    pub paper_flags: Box<dyn PaperFlags>,
    pub payment_settings: Option<PaymentSettings>,
    pub ledger: Option<Box<dyn Ledger>>,
    pub chain: Option<Box<dyn Chain>>,
    pub refunds: Option<Box<dyn Refunds>>,
    pub objects: Box<dyn ObjectStore>,
    /// The bytes of an assignment file sent to and read from a signed store address (`putOverHttp`, `getOverHttp`).
    pub object_bytes: Box<dyn crate::assessment::storage::ObjectBytes>,
    pub bus: Box<dyn Bus>,
    /// How a service's call to the S2S door (`/internal/curriculum`) is judged: inbound, but an outside caller.
    pub services: crate::curriculum::internal::ServiceAuth,
}

impl Ports {
    /// Every stand-in: a stack with nothing wired. Nothing is sold, streamed, approved or published.
    pub fn unwired() -> Ports {
        Ports {
            stake: Box::new(FixedStake(0)),
            host_rights: Box::new(BaseHostRights),
            stream: Box::new(NullStream),
            stream_configured: None,
            approvals: Box::new(UnwiredApprovals),
            wallets: Box::new(NoLinkedWallets),
            paper_flags: Box::new(NoPaperFlags),
            payment_settings: None,
            ledger: None,
            chain: None,
            refunds: None,
            objects: Box::new(NoObjectStore),
            // The TypeScript's default is the real wire; it is reached only once the store is configured.
            object_bytes: Box::new(crate::assessment::storage::HttpObjectBytes::default()),
            bus: Box::new(NoBus),
            services: crate::curriculum::internal::ServiceAuth::unwired(),
        }
    }

    /// `GET /ready`'s body (`index.ts`): up, and how far the stream, the XP bus and course payments are wired. No URL
    /// is echoed: `NATS_URL` may carry credentials.
    pub fn ready(&self) -> Json {
        let mut stream = vec![
            ("id".to_owned(), Json::str(self.stream.id())),
            ("usable".to_owned(), Json::Bool(self.stream.usable())),
            (
                "constructed".to_owned(),
                Json::Bool(self.stream.constructed()),
            ),
        ];
        // `configured: undefined` is left out by JSON.stringify.
        if let Some(c) = &self.stream_configured {
            stream.push(("configured".to_owned(), Json::str(c.clone())));
        }
        stream.push(("probed".to_owned(), Json::Bool(self.stream.probed())));
        Json::obj([
            ("ready", Json::Bool(true)),
            ("stream", Json::Object(stream)),
            (
                "xp",
                Json::obj([
                    ("id", Json::str(self.bus.id())),
                    ("usable", Json::Bool(self.bus.usable())),
                    ("publishes", Json::str("intafaced.identity.xp.earned")),
                ]),
            ),
            (
                "payments",
                Json::obj([
                    (
                        "sells",
                        Json::Bool(
                            self.payment_settings.is_some()
                                && self.chain.is_some()
                                && self.ledger.is_some(),
                        ),
                    ),
                    ("refunds", Json::Bool(self.refunds.is_some())),
                ]),
            ),
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unwired_stack_reports_nothing_usable() {
        assert_eq!(
            Ports::unwired().ready().compact(),
            r#"{"ready":true,"stream":{"id":"null","usable":false,"constructed":false,"probed":false},"xp":{"id":"none","usable":false,"publishes":"intafaced.identity.xp.earned"},"payments":{"sells":false,"refunds":false}}"#
        );
    }
}
