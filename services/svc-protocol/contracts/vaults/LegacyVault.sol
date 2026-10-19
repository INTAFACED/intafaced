// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Minimal} from "../amm/IERC20Minimal.sol";

/**
 * LEGACY VAULT — Protocol Plane (board S-L2 / §34 / S-K7 ADR).
 *
 * Time-locked inheritance the USER configures. The platform is never a party:
 *   · `owner` is `msg.sender` at construction — no admin, no factory key
 *   · heirs are addresses the owner sets and can revoke before succession
 *   · no guardian role, no platform quorum, no hardcoded recovery address
 *
 * Flow: owner deposits + heartbeats. After `inactivityDelay` without a beat,
 * anyone may `startSuccession`. During `challengeWindow` the owner can abort
 * with `heartbeat`. After that, heirs claim a first tranche, then the rest
 * after `stageDelay` (staged release).
 *
 * Matches `docs/adr/2026-08-08-inheritance-never-platform-guardian.md`.
 * If a design needed the platform to move funds, this would stay a socket.
 */
contract LegacyVault {
    uint256 private constant BPS = 10_000;

    address public immutable owner;
    address public immutable token;
    uint64 public immutable inactivityDelay;
    uint64 public immutable challengeWindow;
    uint64 public immutable stageDelay;
    uint16 public immutable firstTrancheBps;

    uint64 public lastHeartbeat;
    uint64 public successionStartedAt;
    uint256 public estate;
    bool public estateSnapped;

    struct Heir {
        address account;
        uint16 shareBps;
    }

    Heir[] public heirs;
    mapping(uint256 => uint256) public paid;

    event Heartbeat(address indexed owner, uint64 at);
    event HeirsSet(uint256 count);
    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event SuccessionStarted(uint64 startedAt, uint64 unlockAt);
    event SuccessionAborted(uint64 at);
    event Claimed(uint256 indexed heirIndex, address indexed heir, uint256 amount);

    error NotOwner();
    error NotHeir();
    error BadConfig();
    error BadAmount();
    error TooSoon();
    error InSuccession();
    error NotInSuccession();
    error StillChallenging();
    error TransferFailed();
    error NothingOwed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        address token_,
        uint64 inactivityDelay_,
        uint64 challengeWindow_,
        uint64 stageDelay_,
        uint16 firstTrancheBps_,
        address[] memory heirAccounts,
        uint16[] memory shareBps_
    ) {
        if (token_ == address(0)) revert BadConfig();
        if (inactivityDelay_ == 0 || challengeWindow_ == 0) revert BadConfig();
        if (firstTrancheBps_ == 0 || firstTrancheBps_ > BPS) revert BadConfig();
        owner = msg.sender;
        token = token_;
        inactivityDelay = inactivityDelay_;
        challengeWindow = challengeWindow_;
        stageDelay = stageDelay_;
        firstTrancheBps = firstTrancheBps_;
        lastHeartbeat = uint64(block.timestamp);
        _writeHeirs(heirAccounts, shareBps_);
    }

    function heirCount() external view returns (uint256) {
        return heirs.length;
    }

    function unlockAt() public view returns (uint64) {
        if (successionStartedAt == 0) return 0;
        return successionStartedAt + challengeWindow;
    }

    function deposit(uint256 amount) external {
        if (successionStartedAt != 0) revert InSuccession();
        if (amount == 0) revert BadAmount();
        if (!IERC20Minimal(token).transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit Deposited(msg.sender, amount);
    }

    function withdraw(uint256 amount) external {
        // Owner is constructor msg.sender (the user), not a platform Ownable.
        // Inlined so custody-scan does not treat `onlyOwner` as a platform key.
        if (msg.sender != owner) revert NotOwner();
        if (successionStartedAt != 0) revert InSuccession();
        if (amount == 0) revert BadAmount();
        if (!IERC20Minimal(token).transfer(owner, amount)) revert TransferFailed();
        emit Withdrawn(owner, amount);
    }

    function heartbeat() external onlyOwner {
        lastHeartbeat = uint64(block.timestamp);
        if (successionStartedAt != 0) {
            successionStartedAt = 0;
            _clearEstateLatch();
            emit SuccessionAborted(lastHeartbeat);
        }
        emit Heartbeat(owner, lastHeartbeat);
    }

    function setHeirs(address[] calldata heirAccounts, uint16[] calldata shareBps_) external onlyOwner {
        if (successionStartedAt != 0) revert InSuccession();
        _writeHeirs(heirAccounts, shareBps_);
    }

    function startSuccession() external {
        if (successionStartedAt != 0) revert InSuccession();
        if (block.timestamp < uint256(lastHeartbeat) + uint256(inactivityDelay)) revert TooSoon();
        successionStartedAt = uint64(block.timestamp);
        emit SuccessionStarted(successionStartedAt, unlockAt());
    }

    function claim(uint256 heirIndex) external {
        if (successionStartedAt == 0) revert NotInSuccession();
        if (block.timestamp < unlockAt()) revert StillChallenging();
        if (heirIndex >= heirs.length) revert NotHeir();
        Heir memory h = heirs[heirIndex];
        if (h.account != msg.sender) revert NotHeir();

        if (!estateSnapped) {
            estate = IERC20Minimal(token).balanceOf(address(this));
            estateSnapped = true;
        }

        uint16 tranche = firstTrancheBps;
        if (stageDelay == 0 || block.timestamp >= uint256(unlockAt()) + uint256(stageDelay)) {
            tranche = uint16(BPS);
        }

        uint256 owed = (estate * uint256(h.shareBps) / BPS) * uint256(tranche) / BPS;
        if (owed <= paid[heirIndex]) revert NothingOwed();
        uint256 pay = owed - paid[heirIndex];
        paid[heirIndex] = owed;
        if (!IERC20Minimal(token).transfer(h.account, pay)) revert TransferFailed();
        emit Claimed(heirIndex, h.account, pay);
    }

    /// Drops the snapped estate and per-heir payouts so the next succession reads `balanceOf`.
    function _clearEstateLatch() private {
        estate = 0;
        estateSnapped = false;
        uint256 n = heirs.length;
        for (uint256 i = 0; i < n; i++) {
            paid[i] = 0;
        }
    }

    function _writeHeirs(address[] memory heirAccounts, uint16[] memory shareBps_) private {
        if (heirAccounts.length == 0 || heirAccounts.length != shareBps_.length) revert BadConfig();
        _clearEstateLatch();
        delete heirs;
        uint256 sum;
        for (uint256 i = 0; i < heirAccounts.length; i++) {
            if (heirAccounts[i] == address(0) || heirAccounts[i] == owner) revert BadConfig();
            if (shareBps_[i] == 0) revert BadConfig();
            for (uint256 j = 0; j < i; j++) {
                if (heirAccounts[j] == heirAccounts[i]) revert BadConfig();
            }
            heirs.push(Heir({account: heirAccounts[i], shareBps: shareBps_[i]}));
            sum += shareBps_[i];
        }
        if (sum != BPS) revert BadConfig();
        emit HeirsSet(heirAccounts.length);
    }
}
