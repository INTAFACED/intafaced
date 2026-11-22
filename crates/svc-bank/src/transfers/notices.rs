//! The slice's notices on the bus (`transfers/transfer-notices.ts`, `transfers/request-notices.ts`): each payload is
//! checked against its catalogue schema (`packages/events/src/catalog.ts`) and sent in `buildEnvelope`'s envelope,
//! `{ id, subject, version, occurredAt, producer, idempotencyKey, payload }`, under its business key as the message id.

use service_kit::approvals::random_uuid;
use service_kit::json::Json;
use service_kit::time::{Instant, js_date};
use service_kit::tokens::is_guid;

use super::ports::Bus;

/// `TransferPostedNotice`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransferPosted {
    pub transfer_id: String,
    pub sender_user_id: String,
    pub recipient_user_id: String,
    pub amount: String,
    pub asset_id: String,
    pub ledger_tx_id: Option<String>,
    pub partner_move_id: Option<String>,
    pub posted_at: String,
}

/// `RequestCreatedNotice`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestCreated {
    pub request_id: String,
    pub payer_user_id: String,
    pub payee_handle: String,
    pub amount: String,
    pub asset_id: String,
    pub note: Option<String>,
    pub expires_at: String,
    pub sequence: i64,
}

/// `RequestPaidNotice`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestPaid {
    pub request_id: String,
    pub payee_user_id: String,
    pub payer_handle: String,
    pub amount: String,
    pub asset_id: String,
    pub ledger_tx_id: String,
}

fn units(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `amountSchema`.
fn amount_ok(s: &str) -> bool {
    let (int, frac) = s.split_once('.').map_or((s, None), |(i, f)| (i, Some(f)));
    !int.is_empty()
        && int.bytes().all(|b| b.is_ascii_digit())
        && frac.is_none_or(|f| (1..=18).contains(&f.len()) && f.bytes().all(|b| b.is_ascii_digit()))
}

fn asset_ok(s: &str) -> bool {
    (1..=16).contains(&units(s))
}

fn between(s: &str, max: usize) -> bool {
    (1..=max).contains(&units(s))
}

fn opt(s: Option<&String>) -> Json {
    s.map_or(Json::Null, |v| Json::str(v.clone()))
}

/// Who sends the notices: the bus, and the producer named in each envelope (`SERVICE_NAME`).
pub struct Notices<'a> {
    pub bus: &'a dyn Bus,
    pub producer: &'a str,
    pub now: Instant,
}

impl Notices<'_> {
    fn publish(
        &self,
        event: &str,
        subject: &str,
        key: &str,
        payload: Json,
        valid: bool,
    ) -> Result<(), String> {
        if !valid {
            return Err(format!("{event} payload from {} is invalid", self.producer));
        }
        let envelope = Json::obj([
            ("id", Json::str(random_uuid()?)),
            ("subject", Json::str(subject)),
            ("version", Json::int(1)),
            ("occurredAt", Json::str(self.now.iso())),
            ("producer", Json::str(self.producer)),
            ("idempotencyKey", Json::str(key)),
            ("payload", payload),
        ]);
        self.bus.publish(subject, key, &envelope)
    }

    /// `PersonalTransferNotices.posted`.
    pub fn transfer_posted(&self, n: &TransferPosted) -> Result<(), String> {
        let valid = between(&n.transfer_id, 128)
            && is_guid(&n.sender_user_id)
            && is_guid(&n.recipient_user_id)
            && amount_ok(&n.amount)
            && asset_ok(&n.asset_id)
            && n.ledger_tx_id.as_deref().is_none_or(|t| between(t, 128))
            && n.partner_move_id.as_deref().is_none_or(|t| between(t, 128))
            && js_date(&n.posted_at).is_some();
        self.publish(
            "personalTransferPosted",
            "intafaced.bank.personal_transfer.posted",
            &format!("pay.transfer_posted:{}", n.transfer_id),
            Json::obj([
                ("transferId", Json::str(n.transfer_id.clone())),
                ("senderUserId", Json::str(n.sender_user_id.clone())),
                ("recipientUserId", Json::str(n.recipient_user_id.clone())),
                ("amount", Json::str(n.amount.clone())),
                ("assetId", Json::str(n.asset_id.clone())),
                ("ledgerTxId", opt(n.ledger_tx_id.as_ref())),
                ("partnerMoveId", opt(n.partner_move_id.as_ref())),
                ("postedAt", Json::str(n.posted_at.clone())),
            ]),
            valid,
        )
    }

    /// `PersonalRequestNotices.created`.
    pub fn request_created(&self, n: &RequestCreated) -> Result<(), String> {
        let valid = is_guid(&n.request_id)
            && is_guid(&n.payer_user_id)
            && between(&n.payee_handle, 32)
            && amount_ok(&n.amount)
            && asset_ok(&n.asset_id)
            && n.note.as_deref().is_none_or(|t| units(t) <= 140)
            && js_date(&n.expires_at).is_some()
            && n.sequence >= 1;
        self.publish(
            "personalRequestCreated",
            "intafaced.bank.personal_request.created",
            &format!("pay.request_created:{}:{}", n.request_id, n.sequence),
            Json::obj([
                ("requestId", Json::str(n.request_id.clone())),
                ("payerUserId", Json::str(n.payer_user_id.clone())),
                ("payeeHandle", Json::str(n.payee_handle.clone())),
                ("amount", Json::str(n.amount.clone())),
                ("assetId", Json::str(n.asset_id.clone())),
                ("note", opt(n.note.as_ref())),
                ("expiresAt", Json::str(n.expires_at.clone())),
                ("sequence", Json::int(n.sequence)),
            ]),
            valid,
        )
    }

    /// `PersonalRequestNotices.paid`.
    pub fn request_paid(&self, n: &RequestPaid) -> Result<(), String> {
        let valid = is_guid(&n.request_id)
            && is_guid(&n.payee_user_id)
            && between(&n.payer_handle, 32)
            && amount_ok(&n.amount)
            && asset_ok(&n.asset_id)
            && between(&n.ledger_tx_id, 128);
        self.publish(
            "personalRequestSettled",
            "intafaced.bank.personal_request.settled",
            &format!("pay.request_paid:{}", n.request_id),
            Json::obj([
                ("requestId", Json::str(n.request_id.clone())),
                ("payeeUserId", Json::str(n.payee_user_id.clone())),
                ("payerHandle", Json::str(n.payer_handle.clone())),
                ("amount", Json::str(n.amount.clone())),
                ("assetId", Json::str(n.asset_id.clone())),
                ("ledgerTxId", Json::str(n.ledger_tx_id.clone())),
            ]),
            valid,
        )
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;
    use crate::transfers::ports::MemoryBus;

    #[test]
    fn a_posted_send_goes_out_once_under_its_business_key() {
        let bus = MemoryBus::default();
        let n = Notices {
            bus: &bus,
            producer: "svc-bank",
            now: js_date("2026-01-01T00:00:00.000Z").unwrap(),
        };
        let posted = TransferPosted {
            transfer_id: "t-00000001".to_owned(),
            sender_user_id: "11111111-1111-4111-8111-111111111111".to_owned(),
            recipient_user_id: "22222222-2222-4222-8222-222222222222".to_owned(),
            amount: "10".to_owned(),
            asset_id: "USDC".to_owned(),
            ledger_tx_id: Some("tx-1".to_owned()),
            partner_move_id: None,
            posted_at: "2026-01-01T00:00:00.000Z".to_owned(),
        };
        n.transfer_posted(&posted).unwrap();
        n.transfer_posted(&posted).unwrap();
        let sent = bus.sent.lock().unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].1, "pay.transfer_posted:t-00000001");
        assert_eq!(sent[0].0, "intafaced.bank.personal_transfer.posted");
        let bad = TransferPosted {
            amount: "-1".to_owned(),
            ..posted
        };
        assert!(n.transfer_posted(&bad).is_err());
    }
}
