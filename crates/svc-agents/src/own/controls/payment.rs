//! The payment method a person chooses for their own agent's runs (`own/payment-method.ts`, J-agents-02 #4; OWNER 226:
//! people pay from their own wallets, and INTAFACED holds no customer money). A method is one wallet the person linked
//! by their own signature: identity holds the links; this service keeps only the chosen address and asks identity again
//! when the person chooses and before every run (`crate::runtime::funds::PersonFunds`). Nothing here moves value or
//! holds a balance.

use service_kit::json::Json;
use service_kit::pg::Pool;
use service_kit::time::Instant;

use super::super::store::is_uuid;
use super::super::{OwnError, OwnRefusal};
use crate::db;
use crate::navigator::onchain::ports::{Linked, LinkedWallets};
use crate::runtime::ms;

/// `assertOwnAgent`: another person's agent reads as not found.
fn assert_own_agent(pool: &Pool, owner_id: &str, agent_id: &str) -> Result<(), OwnError> {
    if !is_uuid(agent_id) {
        return Err(OwnRefusal::new("agents.own.not_found").into());
    }
    let found = db::with_client(pool, |c| {
        Ok(!c
            .query(
                "SELECT 1::int FROM agents.own_agents WHERE owner_id = $1::text AND id = $2::text::uuid",
                &[&owner_id, &agent_id],
            )?
            .is_empty())
    })?;
    if !found {
        return Err(OwnRefusal::new("agents.own.not_found").into());
    }
    Ok(())
}

/// `linkedView`: identity's answer, or `unread` when it could not be asked or read.
fn linked_view(linked: Option<Linked>) -> Json {
    match linked {
        None => Json::obj([("state", Json::str("unread"))]),
        Some(Linked::AccountInactive) => Json::obj([("state", Json::str("account_inactive"))]),
        Some(Linked::Usable(wallets)) => Json::obj([
            ("state", Json::str("usable")),
            (
                "wallets",
                Json::Array(
                    wallets
                        .into_iter()
                        .map(|w| {
                            Json::obj([
                                ("address", Json::str(w.address)),
                                ("linkedAt", Json::str(w.linked_at)),
                            ])
                        })
                        .collect(),
                ),
            ),
        ]),
    }
}

/// `OwnPaymentMethodStore.get`: the chosen wallet, if any, and the person's linked wallets to choose from.
pub fn get(
    pool: &Pool,
    wallets: Option<&dyn LinkedWallets>,
    owner_id: &str,
    agent_id: &str,
) -> Result<Json, OwnError> {
    assert_own_agent(pool, owner_id, agent_id)?;
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            &format!(
                "SELECT address, {} FROM agents.own_agent_payment_methods
                  WHERE owner_id = $1::text AND agent_id = $2::text::uuid",
                ms("chosen_at")
            ),
            &[&owner_id, &agent_id],
        )?)
    })?;
    let method = match rows.first() {
        Some(r) => Json::obj([
            ("kind", Json::str("wallet")),
            ("address", Json::str(r.try_get::<_, String>(0)?)),
            ("chosenAt", Json::str(Instant(r.try_get(1)?).iso())),
        ]),
        None => Json::Null,
    };
    let linked = wallets.and_then(|w| w.read(owner_id));
    Ok(Json::obj([
        ("method", method),
        ("linked", linked_view(linked)),
    ]))
}

/// `OwnPaymentMethodStore.set`: one of the person's linked wallets, checked through identity now, or none to clear the
/// choice. A refusal stores nothing and leaves the earlier choice as it was.
pub fn set(
    pool: &Pool,
    wallets: Option<&dyn LinkedWallets>,
    owner_id: &str,
    agent_id: &str,
    address: Option<&str>,
) -> Result<Json, OwnError> {
    assert_own_agent(pool, owner_id, agent_id)?;
    let Some(address) = address else {
        db::with_client(pool, |c| {
            c.execute(
                "DELETE FROM agents.own_agent_payment_methods WHERE owner_id = $1::text AND agent_id = $2::text::uuid",
                &[&owner_id, &agent_id],
            )?;
            Ok(())
        })?;
        return get(pool, wallets, owner_id, agent_id);
    };
    let wanted = address.to_lowercase();
    match wallets.and_then(|w| w.read(owner_id)) {
        None => return Err(OwnRefusal::new("agents.payment_method.wallets_unread").into()),
        Some(Linked::AccountInactive) => {
            return Err(OwnRefusal::new("agents.payment_method.account_inactive").into());
        }
        Some(Linked::Usable(linked)) if !linked.iter().any(|w| w.address == wanted) => {
            return Err(OwnRefusal::with(
                "agents.payment_method.wallet_not_linked",
                [("address", wanted)],
            )
            .into());
        }
        Some(Linked::Usable(_)) => {}
    }
    db::with_client(pool, |c| {
        c.execute(
            "INSERT INTO agents.own_agent_payment_methods (agent_id, owner_id, kind, address)
             VALUES ($1::text::uuid, $2::text, 'wallet', $3::text)
             ON CONFLICT (agent_id) DO UPDATE
                SET kind = EXCLUDED.kind, address = EXCLUDED.address, chosen_at = now()
              WHERE agents.own_agent_payment_methods.owner_id = EXCLUDED.owner_id",
            &[&agent_id, &owner_id, &wanted],
        )?;
        Ok(())
    })?;
    get(pool, wallets, owner_id, agent_id)
}

/// The refusal `own.paymentMethod.set` answers SERVICE_UNAVAILABLE.
pub fn wallets_unread(code: &str) -> Option<&'static str> {
    (code == "agents.payment_method.wallets_unread").then_some("SERVICE_UNAVAILABLE")
}
