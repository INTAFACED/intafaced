//! The owner's destination sanctions list (`ramps/sanctions-list.ts`): `BANK_DESTINATION_SANCTIONS`, a comma-separated
//! list of `<network>:<address>` (`*` for every network). Blank, unset or unreadable refuses every save and send
//! (`bank.destination_sanctions_unset`); nothing here supplies entries. Matched as the fraud list matches.

use crate::errors::Refusal;
use crate::partner::refuse;

use super::refs::{ANY_NETWORK, address_key, js_trim, network_key};

/// `SanctionsCheck`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Check {
    Unset,
    Listed,
    Clear,
}

/// `readSanctionsList`: the entries, or `None` when unset, blank or unreadable.
pub fn read(raw: Option<&str>) -> Option<Vec<(String, String)>> {
    let raw = raw?;
    if js_trim(raw).is_empty() {
        return None;
    }
    let mut out = Vec::new();
    for part in raw.split(',') {
        let (net, r) = part.split_once(':')?;
        let r = js_trim(r);
        if r.is_empty() {
            return None;
        }
        out.push((network_key(net).ok()?, address_key(r)));
    }
    Some(out)
}

fn match_in(list: &[(String, String)], network: Option<&str>, r: &str) -> Check {
    let key = address_key(r);
    let net = network.map(|n| js_trim(n).to_lowercase());
    let hit = list.iter().any(|(n, k)| {
        *k == key && (n == ANY_NETWORK || net.is_none() || net.as_deref() == Some(n.as_str()))
    });
    if hit { Check::Listed } else { Check::Clear }
}

/// `destinationSanctions(...).check`: the list read from `raw` at each check.
pub fn check(raw: Option<&str>, network: Option<&str>, r: &str) -> Check {
    read(raw).map_or(Check::Unset, |list| match_in(&list, network, r))
}

/// `sanctionsRefusal`: the refusal for a save or a send to `r` on `network`, or none while the address is clear.
pub fn refusal(raw: Option<&str>, network: Option<&str>, r: &str) -> Option<Refusal> {
    match check(raw, network, r) {
        Check::Unset => Some(refuse(
            "bank.destination_sanctions_unset",
            "The destination sanctions list is not set, so no address can be screened, saved or sent to. Nothing was saved or sent",
        )),
        Check::Listed => Some(refuse(
            "bank.destination_sanctions_listed",
            "This address is on the sanctions list, so it cannot be saved or sent to. Nothing was saved or sent",
        )),
        Check::Clear => None,
    }
}

/// `assertNotSanctioned`.
pub fn assert_clear(raw: Option<&str>, network: Option<&str>, r: &str) -> Result<(), Refusal> {
    refusal(raw, network, r).map_or(Ok(()), Err)
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "0x00000000000000000000000000000000000000aa";

    #[test]
    fn the_list_reads_and_matches_as_the_typescript_does() {
        assert_eq!(check(None, None, A), Check::Unset);
        assert_eq!(check(Some("  "), None, A), Check::Unset);
        assert_eq!(check(Some("ethereum"), None, A), Check::Unset);
        assert_eq!(check(Some("eth net:0x1"), None, A), Check::Unset);
        let raw = Some("Ethereum:0x00000000000000000000000000000000000000AA, *:TXyz");
        assert_eq!(check(raw, Some("ethereum"), A), Check::Listed);
        assert_eq!(check(raw, None, A), Check::Listed);
        assert_eq!(check(raw, Some("tron"), A), Check::Clear);
        assert_eq!(check(raw, Some("tron"), "TXyz"), Check::Listed);
        assert_eq!(check(raw, Some("tron"), "txyz"), Check::Clear);
    }
}
