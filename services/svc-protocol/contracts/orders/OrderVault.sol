// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Minimal} from "../amm/IERC20Minimal.sol";
import {IPriceOracle} from "../oracle/IPriceOracle.sol";

interface IOrderPool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function swapExactIn(address tokenIn, uint256 amountIn, uint256 minAmountOut, address to) external returns (uint256);
}

interface IERC1271 {
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4);
}

/**
 * ORDER VAULT — D-limit-dca-01 to -04 (ENGINE VLT-1..VLT-10): a person's own price, take-profit, stop, bracket and
 * trailing orders, filled from their own deposit credit.
 *
 * Behaviour reference: the 1inch limit-order-protocol (MIT): an EIP-712 order the maker signs off chain, filled by
 * anyone when its terms hold, with a stored remaining amount that only goes down. No code is copied from it; this is a
 * smaller vault-and-keeper over an AMM pool, not a matching engine and not a second order book.
 *
 *   · Keyless: no owner, no admin, no pause, no upgrade. The oracle and the sweeper are constructor values.
 *   · Each maker has their own credit per token. `deposit` pulls from the maker and credits what actually arrived (a
 *     fee-on-transfer token credits less). A plain transfer to this address is not a deposit and credits nothing.
 *   · Funds leave only to the maker (`withdraw`, a fill's output) or to the pool for a fill that pays the maker at least
 *     the order's minimum output, pro rata (VLT-6). The output of a bracket's parent stays here, as the maker's credit,
 *     so its exit pair can sell it.
 *   · `fill` is callable by anyone holding the maker's signature: the trigger is checked here against the fail-closed
 *     oracle (a stale or disagreeing mark reverts, so nothing fills on a bad price), the expiry is enforced (VLT-4) and
 *     the remaining amount only goes down (VLT-3). Orders that share a link share one remaining amount (one-cancels-
 *     other, VLT-9); a bracket's exit pair can never sell more than its parent bought.
 *   · A trailing order's watermark is kept here and moves only in the holder's favour (VLT-10): `poke` reads the oracle.
 *   · The maker alone cancels an order, raises its version (an edited order's old signature dies) and withdraws.
 *   · `sweeper` may return tokens sent here by mistake, never more than what no maker is credited for. It cannot touch
 *     any credit. Which address sent them is read from the chain's transfer log by the service that calls it.
 */
contract OrderVault {
    struct Order {
        address maker;
        address base;
        address quote;
        /// true: spend quote, receive base. false: spend base, receive quote.
        bool isBuy;
        /// true: fill when the price is at or above the trigger. false: at or below.
        bool above;
        /// What the order spends, in its input token's smallest units.
        uint256 amountIn;
        /// The trigger: one whole base in quote, 1e18-scaled. Ignored (zero) on a trailing order.
        uint256 triggerWad;
        /// Trailing distance in basis points; zero for a plain price order.
        uint256 trailBps;
        /// The least the whole order may return, in its output token's smallest units; each fill pays at least its share.
        uint256 minOut;
        uint256 expiry;
        uint256 nonce;
        uint256 version;
        /// Orders of one maker with the same non-zero link share one remaining amount.
        bytes32 link;
        /// A bracket exit names its parent's order id; it can sell no more than the parent bought.
        bytes32 parent;
        /// The fill's output stays in the vault as the maker's credit (a bracket's parent).
        bool outputToVault;
    }

    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address maker,address base,address quote,bool isBuy,bool above,uint256 amountIn,uint256 triggerWad,uint256 trailBps,uint256 minOut,uint256 expiry,uint256 nonce,uint256 version,bytes32 link,bytes32 parent,bool outputToVault)"
    );
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("INTAFACED Order Vault");
    bytes32 private constant VERSION_HASH = keccak256("1");
    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;
    uint256 private constant WAD = 1e18;
    uint256 private constant BPS = 10_000;

    IPriceOracle public immutable oracle;
    address public immutable sweeper;

    mapping(address maker => mapping(address token => uint256)) public credit;
    mapping(address token => uint256) public totalCredited;
    /// Filled input per order group (the order id, or the maker's link).
    mapping(bytes32 group => uint256) public filled;
    /// What a bracket parent has bought so far, which its exit pair may sell.
    mapping(bytes32 orderId => uint256) public boughtOut;
    mapping(bytes32 orderId => bool) public cancelled;
    mapping(bytes32 orderId => uint256) public minVersion;
    /// A trailing order's watermark: the best price seen since it opened, 1e18-scaled. Keyed by the signed order's own
    /// hash, so a caller who passes a made-up order (the same maker and nonce, another direction) moves only that made-up
    /// order's mark, never the signed one's.
    mapping(bytes32 orderHash => uint256) public watermark;

    uint256 private _locked = 1;

    event Deposited(address indexed maker, address indexed token, uint256 amount);
    event Withdrawn(address indexed maker, address indexed token, uint256 amount);
    event Filled(bytes32 indexed orderId, address indexed maker, uint256 amountIn, uint256 amountOut, uint256 priceWad);
    event Cancelled(bytes32 indexed orderId, address indexed maker);
    event VersionRaised(bytes32 indexed orderId, address indexed maker, uint256 version);
    event Watermark(bytes32 indexed orderHash, uint256 priceWad);
    event Swept(address indexed token, address indexed to, uint256 amount);

    error BadConfig();
    error BadAmount();
    error InsufficientCredit();
    error OrderExpired();
    error OrderCancelled();
    error StaleVersion();
    error BadSignature();
    error Overfill();
    error TriggerNotReached();
    error BelowMinOut();
    error BadPool();
    error NotSweeper();
    error NothingToSweep();
    error NotTrailing();
    error TransferFailed();
    error Reentered();

    modifier nonReentrant() {
        if (_locked != 1) revert Reentered();
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(IPriceOracle oracle_, address sweeper_) {
        if (address(oracle_) == address(0) || sweeper_ == address(0)) revert BadConfig();
        oracle = oracle_;
        sweeper = sweeper_;
    }

    // ── Credit ──────────────────────────────────────────────────────────────────────────────────────────────────

    function deposit(address token, uint256 amount) external nonReentrant {
        if (amount == 0) revert BadAmount();
        uint256 before = IERC20Minimal(token).balanceOf(address(this));
        if (!IERC20Minimal(token).transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        uint256 received = IERC20Minimal(token).balanceOf(address(this)) - before;
        if (received == 0) revert BadAmount();
        credit[msg.sender][token] += received;
        totalCredited[token] += received;
        emit Deposited(msg.sender, token, received);
    }

    function withdraw(address token, uint256 amount) external nonReentrant {
        if (amount == 0) revert BadAmount();
        if (credit[msg.sender][token] < amount) revert InsufficientCredit();
        credit[msg.sender][token] -= amount;
        totalCredited[token] -= amount;
        if (!IERC20Minimal(token).transfer(msg.sender, amount)) revert TransferFailed();
        emit Withdrawn(msg.sender, token, amount);
    }

    /// Tokens here that no maker is credited for.
    function uncredited(address token) public view returns (uint256) {
        uint256 held = IERC20Minimal(token).balanceOf(address(this));
        return held > totalCredited[token] ? held - totalCredited[token] : 0;
    }

    function sweepUncredited(address token, address to, uint256 amount) external nonReentrant {
        if (msg.sender != sweeper) revert NotSweeper();
        if (amount == 0 || amount > uncredited(token)) revert NothingToSweep();
        if (!IERC20Minimal(token).transfer(to, amount)) revert TransferFailed();
        emit Swept(token, to, amount);
    }

    // ── Orders ──────────────────────────────────────────────────────────────────────────────────────────────────

    function orderId(address maker, uint256 nonce) public pure returns (bytes32) {
        return keccak256(abi.encode(maker, nonce));
    }

    function groupOf(Order calldata order) public pure returns (bytes32) {
        return order.link == bytes32(0) ? orderId(order.maker, order.nonce) : keccak256(abi.encode(order.maker, order.link));
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function hashOrder(Order calldata o) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            bytes.concat(
                abi.encode(ORDER_TYPEHASH, o.maker, o.base, o.quote, o.isBuy, o.above, o.amountIn, o.triggerWad),
                abi.encode(o.trailBps, o.minOut, o.expiry, o.nonce, o.version, o.link, o.parent, o.outputToVault)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// The input the order may still spend: what its group has left, and for a bracket exit what its parent bought.
    function remaining(Order calldata order) public view returns (uint256 left) {
        bytes32 id = orderId(order.maker, order.nonce);
        if (cancelled[id]) return 0;
        uint256 used = filled[groupOf(order)];
        left = order.amountIn > used ? order.amountIn - used : 0;
        if (order.parent != bytes32(0)) {
            uint256 bought = boughtOut[order.parent];
            uint256 cover = bought > used ? bought - used : 0;
            if (cover < left) left = cover;
        }
    }

    /// One whole base in quote, 1e18-scaled, from the fail-closed oracle. A stale or disagreeing mark reverts.
    function price(address base, address quote) public view returns (uint256) {
        (uint256 baseMark,) = oracle.getMark(base);
        (uint256 quoteMark,) = oracle.getMark(quote);
        return (baseMark * WAD) / quoteMark;
    }

    /// The trigger the order fills at now: its own, or a trailing order's watermark less its distance.
    function triggerOf(Order calldata order) public view returns (uint256) {
        if (order.trailBps == 0) return order.triggerWad;
        uint256 mark = watermark[hashOrder(order)];
        if (mark == 0) return 0;
        return order.above ? (mark * (BPS + order.trailBps)) / BPS : (mark * (BPS - order.trailBps)) / BPS;
    }

    /**
     * Moves a trailing order's watermark to the oracle's price when that is in the holder's favour: up for a trailing
     * sell (it fills when the price falls back by its distance), down for a trailing buy. Anyone may call it; it can only
     * ever make the trigger better for the maker.
     */
    function poke(Order calldata order) external returns (uint256) {
        if (order.trailBps == 0 || order.trailBps >= BPS) revert NotTrailing();
        bytes32 h = hashOrder(order);
        uint256 now_ = price(order.base, order.quote);
        uint256 mark = watermark[h];
        bool better = mark == 0 || (order.above ? now_ < mark : now_ > mark);
        if (better) {
            watermark[h] = now_;
            emit Watermark(h, now_);
            return now_;
        }
        return mark;
    }

    function cancel(uint256 nonce) external {
        bytes32 id = orderId(msg.sender, nonce);
        cancelled[id] = true;
        emit Cancelled(id, msg.sender);
    }

    function raiseVersion(uint256 nonce, uint256 version) external {
        bytes32 id = orderId(msg.sender, nonce);
        if (version > minVersion[id]) {
            minVersion[id] = version;
            emit VersionRaised(id, msg.sender, version);
        }
    }

    /**
     * Fills `take` of the order's input through `pool`. Reverts unless: the maker signed this version, it is not
     * expired, cancelled or superseded, the oracle price meets the trigger, the group has `take` left, the maker's
     * credit covers it, and the pool pays at least the order's minimum output pro rata.
     */
    function fill(Order calldata order, bytes calldata signature, uint256 take, IOrderPool pool)
        external
        nonReentrant
        returns (uint256 out)
    {
        bytes32 id = orderId(order.maker, order.nonce);
        uint256 p = _checkFillable(order, id, signature, take);
        out = _settle(order, id, take, pool);
        emit Filled(id, order.maker, take, out, p);
    }

    /// Every condition a fill needs, before anything moves. Returns the oracle price the trigger was checked at.
    function _checkFillable(Order calldata order, bytes32 id, bytes calldata signature, uint256 take)
        private
        view
        returns (uint256 p)
    {
        if (take == 0) revert BadAmount();
        if (block.timestamp > order.expiry) revert OrderExpired();
        if (cancelled[id]) revert OrderCancelled();
        if (order.version < minVersion[id]) revert StaleVersion();
        _checkSignature(order.maker, hashOrder(order), signature);
        if (take > remaining(order)) revert Overfill();
        p = price(order.base, order.quote);
        uint256 trigger = triggerOf(order);
        if (trigger == 0 || (order.above ? p < trigger : p > trigger)) revert TriggerNotReached();
        address tokenIn = order.isBuy ? order.quote : order.base;
        if (credit[order.maker][tokenIn] < take) revert InsufficientCredit();
    }

    /// Spends `take` of the maker's credit through the pool; the maker (or, for a bracket parent, their credit) gets the output.
    function _settle(Order calldata order, bytes32 id, uint256 take, IOrderPool pool) private returns (uint256 out) {
        (address tokenIn, address tokenOut) = order.isBuy ? (order.quote, order.base) : (order.base, order.quote);
        _checkPool(pool, tokenIn, tokenOut);
        // Rounded up: the maker's floor is never shaved by rounding.
        uint256 floor = (order.minOut * take + order.amountIn - 1) / order.amountIn;
        if (floor == 0) floor = 1;

        // State first (checks-effects-interactions): the group's remaining only goes down.
        filled[groupOf(order)] += take;
        credit[order.maker][tokenIn] -= take;
        totalCredited[tokenIn] -= take;
        // A fill of a newer version kills every older signature of this order.
        if (minVersion[id] < order.version) minVersion[id] = order.version;

        address to = order.outputToVault ? address(this) : order.maker;
        uint256 before = IERC20Minimal(tokenOut).balanceOf(to);
        if (!IERC20Minimal(tokenIn).approve(address(pool), take)) revert TransferFailed();
        pool.swapExactIn(tokenIn, take, floor, to);
        if (!IERC20Minimal(tokenIn).approve(address(pool), 0)) revert TransferFailed();
        out = IERC20Minimal(tokenOut).balanceOf(to) - before;
        if (out < floor) revert BelowMinOut();
        if (order.outputToVault) {
            credit[order.maker][tokenOut] += out;
            totalCredited[tokenOut] += out;
            boughtOut[id] += out;
        }
    }

    function _checkPool(IOrderPool pool, address tokenIn, address tokenOut) private view {
        address t0 = pool.token0();
        address t1 = pool.token1();
        if (!((t0 == tokenIn && t1 == tokenOut) || (t0 == tokenOut && t1 == tokenIn))) revert BadPool();
    }

    function _checkSignature(address maker, bytes32 digest, bytes calldata signature) private view {
        if (maker.code.length > 0) {
            (bool ok, bytes memory ret) =
                maker.staticcall(abi.encodeWithSelector(IERC1271.isValidSignature.selector, digest, signature));
            if (!ok || ret.length < 32 || abi.decode(ret, (bytes4)) != IERC1271.isValidSignature.selector) revert BadSignature();
            return;
        }
        if (signature.length != 65) revert BadSignature();
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        if (uint256(s) > HALF_N) revert BadSignature();
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0) || signer != maker) revert BadSignature();
    }
}
