// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * CLAIM LINK ESCROW — D-swap-12: send tokens by a link, with clawback after expiry.
 *
 * The sender makes a one-time link key in their browser and locks tokens here under that key's address, which is the
 * link's id. The key itself travels only in the link (the URL fragment); it is never sent on chain or to a service.
 * Whoever holds the link pays the locked tokens to an address of their choosing by signing (this contract, the chain id,
 * the id, the recipient) with the link key: the recipient is bound by that signature, so a copied claim cannot be
 * redirected. A link pays once. After its expiry nobody can claim it and only its sender can take the tokens back.
 *
 * No owner, no admin, no pause, no upgrade. The expiry bounds are constructor values, public and immutable; a zero or
 * inverted bound refuses at deploy. Tokens sit here only while a link is open:
 * balanceOf(this) for a token >= openAmount[token], the sum of its open links (equal for a plain ERC-20).
 */
contract ClaimLinkEscrow {
    uint8 internal constant OPEN = 1;
    uint8 internal constant CLAIMED = 2;
    uint8 internal constant CLAWED_BACK = 3;

    struct Link {
        address sender;
        address token;
        uint256 amount;
        uint64 expiresAt;
        uint8 state;
    }

    /// secp256k1 n / 2: a signature with a larger s is the malleable twin of another and is refused.
    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    /// The shortest and longest time a sender may give a link, in seconds (owner-published at deploy).
    uint64 public immutable minExpirySeconds;
    uint64 public immutable maxExpirySeconds;

    /// One link per link-key address. A used id is never reused.
    mapping(address => Link) public links;
    /// The sum of the open links' amounts, per token.
    mapping(address => uint256) public openAmount;

    uint256 private _locked = 1;

    event Created(address indexed id, address indexed sender, address indexed token, uint256 amount, uint64 expiresAt);
    event Claimed(address indexed id, address indexed to, uint256 amount);
    event ClawedBack(address indexed id, address indexed sender, uint256 amount);

    error BadConfig();
    error BadLink();
    error LinkExists();
    error BadAmount();
    error ExpiryOutOfBounds();
    error NotOpen();
    error Expired();
    error NotExpired();
    error NotSender();
    error BadRecipient();
    error BadSignature();
    error TransferFailed();
    error Reentered();

    modifier nonReentrant() {
        if (_locked != 1) revert Reentered();
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(uint64 minExpiry, uint64 maxExpiry) {
        if (minExpiry == 0 || maxExpiry < minExpiry) revert BadConfig();
        minExpirySeconds = minExpiry;
        maxExpirySeconds = maxExpiry;
    }

    /**
     * Locks `amount` of `token` from the sender under the link `id` (the link key's address) for `lifetime` seconds from
     * the block that locks it, within the published bounds. The sender approves this contract for `amount` first. A
     * token that delivers less than `amount` (a fee on transfer) is refused, so every open link is fully backed.
     */
    function create(address token, uint256 amount, address id, uint64 lifetime) external nonReentrant {
        if (id == address(0) || token == address(0)) revert BadLink();
        if (links[id].state != 0) revert LinkExists();
        if (amount == 0) revert BadAmount();
        if (lifetime < minExpirySeconds || lifetime > maxExpirySeconds) revert ExpiryOutOfBounds();
        uint64 expiresAt = uint64(block.timestamp) + lifetime;
        links[id] = Link({sender: msg.sender, token: token, amount: amount, expiresAt: expiresAt, state: OPEN});
        openAmount[token] += amount;
        uint256 before = _balance(token);
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(0x23b872dd, msg.sender, address(this), amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
        if (_balance(token) - before != amount) revert TransferFailed();
        emit Created(id, msg.sender, token, amount, expiresAt);
    }

    /// The digest the link key signs to pay `to` (EIP-191 personal message over the 32-byte claim hash).
    function claimDigest(address id, address to) public view returns (bytes32) {
        bytes32 claimHash = keccak256(abi.encode(address(this), block.chainid, id, to));
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", claimHash));
    }

    /// Pays an open, unexpired link to `to`, when `signature` is the link key's over (this, chain, id, to). Once.
    function claim(address id, address to, bytes calldata signature) external nonReentrant {
        Link storage link = links[id];
        if (link.state != OPEN) revert NotOpen();
        if (block.timestamp >= link.expiresAt) revert Expired();
        if (to == address(0) || to == address(this)) revert BadRecipient();
        if (_recover(claimDigest(id, to), signature) != id) revert BadSignature();
        link.state = CLAIMED;
        openAmount[link.token] -= link.amount;
        _send(link.token, to, link.amount);
        emit Claimed(id, to, link.amount);
    }

    /// Returns an open link's tokens to its sender, only after its expiry, only when the sender asks.
    function clawback(address id) external nonReentrant {
        Link storage link = links[id];
        if (link.state != OPEN) revert NotOpen();
        if (msg.sender != link.sender) revert NotSender();
        if (block.timestamp < link.expiresAt) revert NotExpired();
        link.state = CLAWED_BACK;
        openAmount[link.token] -= link.amount;
        _send(link.token, link.sender, link.amount);
        emit ClawedBack(id, link.sender, link.amount);
    }

    function _send(address token, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _balance(address token) private view returns (uint256) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSelector(0x70a08231, address(this)));
        if (!ok || data.length < 32) revert TransferFailed();
        return abi.decode(data, (uint256));
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address signer) {
        if (signature.length != 65) revert BadSignature();
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        // Some signers give the recovery id as 0 or 1 rather than 27 or 28; both name the same signature.
        if (v < 27) v += 27;
        if (uint256(s) > HALF_N || (v != 27 && v != 28)) revert BadSignature();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
    }
}
