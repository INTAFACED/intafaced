// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPriceOracle} from "../oracle/IPriceOracle.sol";

interface IFeeRelayToken {
    function decimals() external view returns (uint8);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
}

interface IFeeRelayPool {
    function swapExactIn(address tokenIn, uint256 amountIn, uint256 minAmountOut, address to)
        external
        returns (uint256 amountOut);
}

/**
 * FEE TOKEN RELAY — RC-dex-protocol-02: a swap whose network fee is paid in a token the person holds.
 *
 * The person signs, never sends: an EIP-2612 permit (or several) letting this contract pull their tokens, and one
 * EIP-712 `FeeSwap` order naming the pool, the amount, the least they accept, the fee token, the gas they pay for
 * (`gasWei`, native) and the most fee token they agree to pay (`maxCharge`). Anyone may submit the order and pay its gas
 * in native currency; the submitter is paid the fee in the person's token, priced here and nowhere else:
 *
 *   charge = ceil(gasWei × 10^decimals × (10000 + markupBps) / (markWad × 10000))
 *
 * `markWad` is the fail-closed oracle's mark for the fee token: native wei per whole token. The oracle reverts on a
 * stale, missing or disputed mark, so a stale oracle refuses the order; there is no fallback price. A token the operator
 * has not allowlisted refuses (`NotAllowlisted`). `markupBps` is published here, immutable, readable by anyone.
 *
 * The contract holds nothing between calls: the input goes straight to the pool and the output straight to the person.
 * The operator can only change the allowlist. It has no path to a person's tokens beyond what that person signed.
 */
contract FeeTokenRelay {
    struct Order {
        address owner;
        address pool;
        address tokenIn;
        uint256 amountIn;
        uint256 minAmountOut;
        address feeToken;
        uint256 gasWei;
        uint256 maxCharge;
        uint256 nonce;
        uint256 deadline;
    }

    struct Permit {
        address token;
        uint256 value;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "FeeSwap(address owner,address pool,address tokenIn,uint256 amountIn,uint256 minAmountOut,address feeToken,uint256 gasWei,uint256 maxCharge,uint256 nonce,uint256 deadline)"
    );
    /// secp256k1n / 2: a signature with a higher `s` is the malleable twin of a lower one and is refused.
    uint256 private constant HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    IPriceOracle public immutable oracle;
    address public immutable operator;
    uint16 public immutable markupBps;

    mapping(address token => bool) public allowlisted;
    mapping(address owner => uint256) public nonces;
    address[] private _feeTokens;
    uint256 private _locked = 1;

    event FeeTokenSet(address indexed token, bool allowed);
    event FeeCharged(
        address indexed owner,
        address indexed relayer,
        address indexed feeToken,
        uint256 gasWei,
        uint256 markWad,
        uint16 markupBps,
        uint256 charge
    );
    event RelayedSwap(address indexed owner, address indexed pool, address tokenIn, uint256 amountIn, uint256 amountOut);

    error BadConfig();
    error NotOperator();
    error NotAllowlisted(address token);
    error OrderExpired();
    error BadNonce();
    error BadSignature();
    error ChargeAboveMax(uint256 charge, uint256 maxCharge);
    error TransferFailed();
    error Reentered();

    constructor(address oracle_, address operator_, uint16 markupBps_) {
        if (oracle_ == address(0) || operator_ == address(0) || markupBps_ > 10_000) revert BadConfig();
        oracle = IPriceOracle(oracle_);
        operator = operator_;
        markupBps = markupBps_;
    }

    /// Every token the operator has ever listed, allowed or not; `allowlisted` says which pay today.
    function feeTokens() external view returns (address[] memory) {
        return _feeTokens;
    }

    function setFeeToken(address token, bool allowed) external {
        if (msg.sender != operator) revert NotOperator();
        if (token == address(0)) revert BadConfig();
        bool known = false;
        for (uint256 i = 0; i < _feeTokens.length; i++) {
            if (_feeTokens[i] == token) known = true;
        }
        if (!known) _feeTokens.push(token);
        allowlisted[token] = allowed;
        emit FeeTokenSet(token, allowed);
    }

    /// What `gasWei` of native gas costs in `token`, at the oracle's mark plus the published markup, rounded up.
    function quoteCharge(address token, uint256 gasWei) public view returns (uint256 charge, uint256 markWad, uint64 updatedAt) {
        if (!allowlisted[token]) revert NotAllowlisted(token);
        (markWad, updatedAt) = oracle.getMark(token);
        uint256 numerator = gasWei * (10 ** IFeeRelayToken(token).decimals()) * (10_000 + uint256(markupBps));
        uint256 denominator = markWad * 10_000;
        charge = (numerator + denominator - 1) / denominator;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("FeeTokenRelay"), keccak256("1"), block.chainid, address(this)));
    }

    function orderDigest(Order calldata order) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                ORDER_TYPEHASH,
                order.owner,
                order.pool,
                order.tokenIn,
                order.amountIn,
                order.minAmountOut,
                order.feeToken,
                order.gasWei,
                order.maxCharge,
                order.nonce,
                order.deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /**
     * Runs one signed order: the permits first (one already used by a front-runner is skipped, the pull below then
     * decides), then the fee to the submitter, then the swap with its output to the person.
     */
    function swap(Order calldata order, bytes calldata signature, Permit[] calldata permits)
        external
        returns (uint256 amountOut, uint256 charge)
    {
        if (_locked != 1) revert Reentered();
        _locked = 2;
        if (block.timestamp > order.deadline) revert OrderExpired();
        if (order.nonce != nonces[order.owner]) revert BadNonce();
        if (_recover(orderDigest(order), signature) != order.owner) revert BadSignature();
        nonces[order.owner] = order.nonce + 1;

        for (uint256 i = 0; i < permits.length; i++) {
            Permit calldata p = permits[i];
            try IFeeRelayToken(p.token).permit(order.owner, address(this), p.value, p.deadline, p.v, p.r, p.s) {} catch {}
        }

        uint256 markWad;
        (charge, markWad,) = quoteCharge(order.feeToken, order.gasWei);
        if (charge > order.maxCharge) revert ChargeAboveMax(charge, order.maxCharge);
        _pull(order.feeToken, order.owner, msg.sender, charge);
        emit FeeCharged(order.owner, msg.sender, order.feeToken, order.gasWei, markWad, markupBps, charge);

        _pull(order.tokenIn, order.owner, address(this), order.amountIn);
        if (!IFeeRelayToken(order.tokenIn).approve(order.pool, order.amountIn)) revert TransferFailed();
        amountOut = IFeeRelayPool(order.pool).swapExactIn(order.tokenIn, order.amountIn, order.minAmountOut, order.owner);
        emit RelayedSwap(order.owner, order.pool, order.tokenIn, order.amountIn, amountOut);
        _locked = 1;
    }

    function _pull(address token, address from, address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(IFeeRelayToken.transferFrom.selector, from, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address signer) {
        if (signature.length != 65) revert BadSignature();
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        if (uint256(s) > HALF_N || (v != 27 && v != 28)) revert BadSignature();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
    }
}
