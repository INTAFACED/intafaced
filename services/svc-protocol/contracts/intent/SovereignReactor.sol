// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IReactorToken {
    function allowance(address owner, address spender) external view returns (uint256);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
}

interface IReactorSigner {
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4);
}

/**
 * SOVEREIGN REACTOR: signed intent orders with a Dutch-auction decay (D-swap-09, ENGINE INT-1..INT-5).
 *
 * A swapper signs an order off chain (no gas): give `amountIn` of `tokenIn`, receive at least the decayed amount of
 * `tokenOut`. The output starts at `startOut` and falls linearly to `endOut` between `decayStart` and `decayEnd`; after
 * that it stays at `endOut` until `deadline`, then the order can no longer fill. A filler calls `fill` and pays the
 * output at that second; the reactor moves the swapper's input straight to the filler (through the swapper's allowance to
 * this contract, or the token's own EIP-2612 permit signed with the order) and the filler's output straight to the
 * swapper, so the reactor holds nothing. Each order's nonce is a bit in the swapper's bitmap, spent on fill or cancel, so
 * a signature is never used twice. A failed or unfilled order costs the swapper nothing.
 *
 * No admin, no pause, no fee. Behaviour follows UniswapX's Dutch orders as a study reference; the code is written here,
 * nothing is copied. TEST deployments only; the audit is external. Exclusive fillers (INT-3's window and override) are
 * not in this contract yet.
 */
contract SovereignReactor {
    struct Order {
        address swapper;
        address tokenIn;
        uint256 amountIn;
        address tokenOut;
        uint256 startOut;
        uint256 endOut;
        uint256 decayStart;
        uint256 decayEnd;
        uint256 deadline;
        uint256 nonce;
    }

    /// The token's own EIP-2612 permit for this contract, signed with the order; `deadline` 0 means none.
    struct Permit {
        uint256 value;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "IntentOrder(address swapper,address tokenIn,uint256 amountIn,address tokenOut,uint256 startOut,uint256 endOut,uint256 decayStart,uint256 decayEnd,uint256 deadline,uint256 nonce)"
    );
    uint256 private constant HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    mapping(address => mapping(uint256 => uint256)) public nonceBitmap;
    uint256 private _locked = 1;

    event Filled(
        bytes32 indexed orderHash,
        address indexed swapper,
        address indexed filler,
        uint256 nonce,
        uint256 amountIn,
        uint256 amountOut,
        uint256 filledAt
    );
    event Cancelled(address indexed swapper, uint256 nonce);

    error Expired();
    error BadDecay();
    error NonceUsed();
    error BadSignature();
    error TransferFailed();
    error Reentrant();

    modifier lock() {
        if (_locked != 1) revert Reentrant();
        _locked = 2;
        _;
        _locked = 1;
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("SovereignReactor"), keccak256("1"), block.chainid, address(this)));
    }

    function orderHash(Order calldata o) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                ORDER_TYPEHASH,
                o.swapper,
                o.tokenIn,
                o.amountIn,
                o.tokenOut,
                o.startOut,
                o.endOut,
                o.decayStart,
                o.decayEnd,
                o.deadline,
                o.nonce
            )
        );
    }

    function digest(Order calldata o) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), orderHash(o)));
    }

    /// The output the order pays at chain time `t`: linear from `startOut` to `endOut`, never outside the two.
    function outAt(Order calldata o, uint256 t) public pure returns (uint256) {
        if (t <= o.decayStart) return o.startOut;
        if (t >= o.decayEnd) return o.endOut;
        return o.startOut - ((o.startOut - o.endOut) * (t - o.decayStart)) / (o.decayEnd - o.decayStart);
    }

    /// Whether the swapper's nonce is spent (filled or cancelled).
    function nonceSpent(address swapper, uint256 nonce) external view returns (bool) {
        return nonceBitmap[swapper][nonce >> 8] & (1 << (nonce & 0xff)) != 0;
    }

    function fill(Order calldata o, bytes calldata signature, Permit calldata permit) external lock returns (uint256 out) {
        if (block.timestamp > o.deadline) revert Expired();
        if (o.endOut > o.startOut || o.decayEnd < o.decayStart || o.deadline < o.decayEnd || o.endOut == 0) revert BadDecay();
        _spend(o.swapper, o.nonce);
        _verify(o.swapper, digest(o), signature);
        if (permit.deadline != 0 && IReactorToken(o.tokenIn).allowance(o.swapper, address(this)) < o.amountIn) {
            IReactorToken(o.tokenIn).permit(
                o.swapper, address(this), permit.value, permit.deadline, permit.v, permit.r, permit.s
            );
        }
        out = outAt(o, block.timestamp);
        _pull(o.tokenIn, o.swapper, msg.sender, o.amountIn);
        _pull(o.tokenOut, msg.sender, o.swapper, out);
        emit Filled(orderHash(o), o.swapper, msg.sender, o.nonce, o.amountIn, out, block.timestamp);
    }

    /// The swapper spends an order's nonce so it can never fill. An on-chain transaction the swapper sends.
    function cancel(uint256 nonce) external {
        _spend(msg.sender, nonce);
        emit Cancelled(msg.sender, nonce);
    }

    function _spend(address swapper, uint256 nonce) private {
        uint256 bit = 1 << (nonce & 0xff);
        uint256 word = nonce >> 8;
        uint256 before = nonceBitmap[swapper][word];
        if (before & bit != 0) revert NonceUsed();
        nonceBitmap[swapper][word] = before | bit;
    }

    function _verify(address swapper, bytes32 hash, bytes calldata signature) private view {
        if (swapper.code.length > 0) {
            (bool ok, bytes memory ret) =
                swapper.staticcall(abi.encodeCall(IReactorSigner.isValidSignature, (hash, signature)));
            if (ok && ret.length >= 32 && abi.decode(ret, (bytes4)) == IReactorSigner.isValidSignature.selector) return;
        }
        if (signature.length != 65) revert BadSignature();
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        if (uint256(s) > HALF_N) revert BadSignature();
        address signer = ecrecover(hash, v, r, s);
        if (signer == address(0) || signer != swapper) revert BadSignature();
    }

    function _pull(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IReactorToken.transferFrom, (from, to, amount)));
        if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
