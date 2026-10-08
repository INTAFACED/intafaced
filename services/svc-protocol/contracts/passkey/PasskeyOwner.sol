// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC1271} from "../interfaces/IAccount.sol";
import {P256} from "./P256.sol";

/**
 * PASSKEY OWNER — a P-256 public key that answers ERC-1271 for a SmartAccount.
 *
 * SmartAccount already routes contract owners through ERC-1271. This contract is
 * the missing half: until it exists, "passkey smart accounts" is true of the
 * service and false of the chain (`socket.p256-verifier` / board S-A9).
 *
 * ── What this verifies ──────────────────────────────────────────────────────
 * WebAuthn assertion bytes the same way `svc-identity` does off-chain:
 *   messageHash = sha256( authenticatorData || sha256(clientDataJSON) )
 * then P-256 ECDSA over that hash (RIP-7212), with low-s enforced.
 *
 * authenticatorData must be exactly 37 bytes, and flags bit 0 (User Present)
 * must be set. UV is not required here. A miss returns ERC-1271 failure.
 *
 * The `hash` argument to `isValidSignature` is the user-op / authorisation
 * digest the account is checking. It MUST appear as the WebAuthn `challenge`
 * (base64url of the 32 bytes) inside `clientDataJSON`, or the signature is
 * refused — otherwise any assertion for any challenge could authorise any op.
 *
 * ── What this is not ────────────────────────────────────────────────────────
 * · Not a guardian / recovery path (doctrine: platform never a guardian).
 * · Not a paymaster (S-A10) or bundler (S-A11).
 * · Not upgradeable — key is immutable; lose the passkey, lose this owner.
 */
contract PasskeyOwner is IERC1271 {
    bytes4 private constant ERC1271_MAGIC = 0x1626ba7e;
    bytes4 private constant ERC1271_FAIL = 0xffffffff;

    bytes32 public immutable qx;
    bytes32 public immutable qy;

    error EmptyPublicKey();
    error BadSignatureEncoding();

    constructor(bytes32 qx_, bytes32 qy_) {
        if (uint256(qx_) == 0 || uint256(qy_) == 0) revert EmptyPublicKey();
        qx = qx_;
        qy = qy_;
    }

    /**
     * @param hash Digest the SmartAccount is validating (typically userOpHash).
     * @param signature abi.encode(authenticatorData, clientDataJSON, r, s)
     *        where r,s are ieee-p1363 halves (32 bytes each), matching Node
     *        `dsaEncoding: 'ieee-p1363'` used by `svc-identity` WebAuthn.
     */
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (bytes memory authenticatorData, bytes memory clientDataJSON, bytes32 r, bytes32 s) = _decode(signature);

        if (!_clientDataOk(clientDataJSON, hash)) return ERC1271_FAIL;

        // rpIdHash (32) || flags (1) || signCount (4). User Present is flags bit 0,
        // the same bit svc-identity checks. Wrong length or UP clear is a failure
        // magic, including when P-256 would accept the assertion. UV is not required.
        if (authenticatorData.length != 37 || (uint8(authenticatorData[32]) & 0x01) == 0) {
            return ERC1271_FAIL;
        }

        bytes32 clientDataHash = sha256(clientDataJSON);
        bytes32 messageHash = sha256(bytes.concat(authenticatorData, bytes32ToBytes(clientDataHash)));

        // P256.verify reverts if the precompile is missing or s is malleable —
        // surface that as failure magic rather than bubbling, so ERC-1271 callers
        // that treat revert as "invalid" and those that expect a return agree.
        try this.verifyP256(messageHash, r, s) returns (bool ok) {
            return ok ? ERC1271_MAGIC : ERC1271_FAIL;
        } catch {
            return ERC1271_FAIL;
        }
    }

    /** External so `try/catch` can trap precompile-missing without bricking staticcall. */
    function verifyP256(bytes32 messageHash, bytes32 r, bytes32 s) external view returns (bool) {
        return P256.verify(messageHash, r, s, qx, qy);
    }

    function precompilePresent() external view returns (bool) {
        return P256.precompilePresent();
    }

    function _decode(
        bytes calldata signature
    ) private pure returns (bytes memory authenticatorData, bytes memory clientDataJSON, bytes32 r, bytes32 s) {
        if (signature.length < 128) revert BadSignatureEncoding();
        (authenticatorData, clientDataJSON, r, s) = abi.decode(signature, (bytes, bytes, bytes32, bytes32));
    }

    /**
     * Minimal WebAuthn clientData checks:
     *   · type is webauthn.get
     *   · challenge is base64url(hash) (no padding)
     *
     * Origin / rpId binding stay off-chain at enrolment (identity) for this P0 —
     * named residual: expanding on-chain origin allowlists is a follow-up, not a
     * silent claim that origin is enforced here.
     */
    function _clientDataOk(bytes memory clientDataJSON, bytes32 hash) private pure returns (bool) {
        // {"type":"webauthn.get","challenge":"<b64url>","origin":"...
        bytes memory prefix = '{"type":"webauthn.get","challenge":"';
        if (clientDataJSON.length < prefix.length + 43) return false;
        for (uint256 i = 0; i < prefix.length; i++) {
            if (clientDataJSON[i] != prefix[i]) return false;
        }
        bytes memory expected = bytes(base64UrlEncode32(hash));
        uint256 start = prefix.length;
        for (uint256 i = 0; i < expected.length; i++) {
            if (clientDataJSON[start + i] != expected[i]) return false;
        }
        if (clientDataJSON[start + expected.length] != '"') return false;
        return true;
    }

    function bytes32ToBytes(bytes32 data) private pure returns (bytes memory out) {
        out = new bytes(32);
        assembly {
            mstore(add(out, 32), data)
        }
    }

    /// @dev Unpadded base64url of 32 bytes (43 characters).
    function base64UrlEncode32(bytes32 data) internal pure returns (string memory) {
        bytes memory table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        bytes memory src = new bytes(32);
        assembly {
            mstore(add(src, 32), data)
        }
        bytes memory out = new bytes(43);
        uint256 i;
        uint256 j;
        for (; i + 2 < 32; i += 3) {
            uint256 n = (uint256(uint8(src[i])) << 16) | (uint256(uint8(src[i + 1])) << 8) | uint256(uint8(src[i + 2]));
            out[j++] = table[(n >> 18) & 63];
            out[j++] = table[(n >> 12) & 63];
            out[j++] = table[(n >> 6) & 63];
            out[j++] = table[n & 63];
        }
        // 32 = 10*3 + 2 → three more chars, no pad.
        uint256 n2 = (uint256(uint8(src[i])) << 16) | (uint256(uint8(src[i + 1])) << 8);
        out[j++] = table[(n2 >> 18) & 63];
        out[j++] = table[(n2 >> 12) & 63];
        out[j++] = table[(n2 >> 6) & 63];
        return string(out);
    }
}
