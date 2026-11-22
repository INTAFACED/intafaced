//! The wallet's proof for one own move: the words it signs (`ownMoveMessage`) and the address that signed them
//! (`ramps/wallet-ownership.ts` `recoverPersonalSignAddress`: EIP-191 `personal_sign`, a 65-byte `r || s || v`
//! signature, `v` 27/28 or 0/1). The ramps slice's wallet proofs will share [`recover_personal_sign_address`].

use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
use sha3::{Digest, Keccak256};

/// `ownMoveMessage`: what the wallet signs to prove it is the person's and to name the one move it is for.
pub fn own_move_message(move_id: &str, wallet: &str, asset_id: &str, amount: &str) -> String {
    [
        "INTAFACED move to your trading account".to_owned(),
        format!("Move: {}", move_id.to_lowercase()),
        format!("Wallet: {}", wallet.to_lowercase()),
        format!("Amount: {amount} {asset_id}"),
        "Signing this proves you control this wallet, so your partner bank can send this amount to it. It moves no funds and approves nothing else.".to_owned(),
    ]
    .join("\n")
}

/// `personalMessageHash`: the EIP-191 digest a wallet signs for `personal_sign`.
pub fn personal_message_hash(message: &str) -> [u8; 32] {
    let body = message.as_bytes();
    let mut h = Keccak256::new();
    h.update(format!("\x19Ethereum Signed Message:\n{}", body.len()).as_bytes());
    h.update(body);
    h.finalize().into()
}

fn hex_byte(pair: &[u8]) -> Option<u8> {
    let digit = |c: u8| char::from(c).to_digit(16);
    let hi = digit(*pair.first()?)?;
    let lo = digit(*pair.get(1)?)?;
    u8::try_from(hi * 16 + lo).ok()
}

/// `recoverPersonalSignAddress`: the address that signed `message`, lower case, or none when the signature is not one.
pub fn recover_personal_sign_address(message: &str, signature: &str) -> Option<String> {
    let sig = service_kit::money::js_trim(signature);
    // `^0x[0-9a-fA-F]{130}$`.
    let hex = sig.strip_prefix("0x")?;
    if hex.len() != 130 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let bytes: Vec<u8> = hex
        .as_bytes()
        .chunks(2)
        .map(hex_byte)
        .collect::<Option<_>>()?;
    let v = *bytes.get(64)?;
    let bit = if v >= 27 { v - 27 } else { v };
    if bit > 1 {
        return None;
    }
    let mut signature = Signature::from_slice(bytes.get(..64)?).ok()?;
    let mut y_odd = bit == 1;
    // The TypeScript recovers from a high `s` as it is; k256 checks the recovered key against a low `s`. The same key
    // signs (r, n - s) with the other parity of R, so the high form is turned to the low one first.
    let low = signature.normalize_s();
    if low != signature {
        signature = low;
        y_odd = !y_odd;
    }
    let id = RecoveryId::new(y_odd, false);
    let key =
        VerifyingKey::recover_from_prehash(&personal_message_hash(message), &signature, id).ok()?;
    let point = key.to_sec1_point(false);
    let full = point.as_bytes();
    let hash = Keccak256::digest(full.get(1..)?);
    let tail = hash.get(12..)?;
    Some(format!(
        "0x{}",
        tail.iter().map(|b| format!("{b:02x}")).collect::<String>()
    ))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;
    use k256::ecdsa::SigningKey;

    /// The first well-known public development key of local EVM chains (holds nothing; TEST only) and its address.
    const KEY: &str = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    const WALLET: &str = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

    fn sign(message: &str, v_base: u8) -> (String, [u8; 64], u8) {
        let bytes: Vec<u8> = KEY
            .as_bytes()
            .chunks(2)
            .map(|p| hex_byte(p).unwrap())
            .collect();
        let key = SigningKey::from_slice(&bytes).unwrap();
        let (sig, id) = key.sign_prehash_recoverable(&personal_message_hash(message));
        let rs: [u8; 64] = sig.to_bytes().into();
        let hex: String = rs.iter().map(|b| format!("{b:02x}")).collect();
        let v = id.to_byte() + v_base;
        (format!("0x{hex}{v:02x}"), rs, id.to_byte())
    }

    #[test]
    fn the_well_known_key_signs_for_its_own_address_with_v_27_28_or_0_1() {
        let m = own_move_message(
            "AAAAAAAA-0000-4000-8000-000000000000",
            WALLET,
            "USDC",
            "600",
        );
        assert!(m.starts_with("INTAFACED move to your trading account\nMove: aaaaaaaa-"));
        for base in [27, 0] {
            let (sig, ..) = sign(&m, base);
            assert_eq!(
                recover_personal_sign_address(&m, &sig).as_deref(),
                Some(WALLET)
            );
        }
        let (sig, ..) = sign(&m, 27);
        // Another message is another signer, never this wallet.
        assert_ne!(
            recover_personal_sign_address(&format!("{m} "), &sig).as_deref(),
            Some(WALLET)
        );
    }

    #[test]
    fn a_high_s_signature_recovers_the_same_address_as_the_typescript_does() {
        let m = "a message";
        let (_, rs, bit) = sign(m, 0);
        // n - s, with the other recovery bit: the same signer.
        let n: [u8; 32] = [
            0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
            0xff, 0xfe, 0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c,
            0xd0, 0x36, 0x41, 0x41,
        ];
        let mut high = [0u8; 32];
        let mut borrow = 0i16;
        for i in (0..32).rev() {
            let d = i16::from(n[i]) - i16::from(rs[32 + i]) - borrow;
            borrow = i16::from(d < 0);
            high[i] = u8::try_from((d + 256) % 256).unwrap();
        }
        let hex: String = rs[..32]
            .iter()
            .chain(high.iter())
            .map(|b| format!("{b:02x}"))
            .collect();
        let sig = format!("0x{hex}{:02x}", (bit ^ 1) + 27);
        assert_eq!(
            recover_personal_sign_address(m, &sig).as_deref(),
            Some(WALLET)
        );
    }

    #[test]
    fn what_is_not_a_signature_recovers_nobody() {
        let m = "a message";
        let (sig, ..) = sign(m, 27);
        assert_eq!(recover_personal_sign_address(m, "0x12"), None);
        assert_eq!(
            recover_personal_sign_address(m, &sig.replace("0x", "")),
            None
        );
        let bad_v = format!("{}1d", &sig[..sig.len() - 2]);
        assert_eq!(recover_personal_sign_address(m, &bad_v), None);
        let zero = format!("0x{}1b", "0".repeat(128));
        assert_eq!(recover_personal_sign_address(m, &zero), None);
    }
}
