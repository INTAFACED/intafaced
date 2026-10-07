// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Minimal} from "../amm/IERC20Minimal.sol";
import {IPriceOracle} from "../oracle/IPriceOracle.sol";

/**
 * ISOLATED LENDING MARKET — Protocol Plane (board S-A4 / `protocol.lending`).
 *
 * Over-collateralised only. One collateral token, one borrow token.
 * Collateral is never rehypothecated. LTV / liquidation use FailClosedOracle marks —
 * borrow and liquidate revert when the oracle refuses (stale / disagreement).
 *
 * Interest: immutable utilisation kink curve; index accrues on interaction.
 * Rates are construction params, not invented mid-flight.
 *
 * Permissionless keepers. Partial liquidation via closeFactorBps.
 * Engineering done-bar (cascade + flash/reentrancy adversarial) lives in
 * `src/lending/lending-cascade-flash.onchain.test.ts` + `lending-honesty.test.ts`.
 * Persistent public testnet deploy remains Nitro RPC residual — not this file.
 */
contract IsolatedLendingMarket {
    uint256 private constant WAD = 1e18;
    uint256 private constant BPS = 10_000;
    uint256 private constant SECONDS_PER_YEAR = 365 days;

    struct MarketConfig {
        address collateralToken;
        address borrowToken;
        address oracle;
        address collateralAssetForOracle;
        address borrowAssetForOracle;
        uint16 maxLtvBps;
        uint16 liquidationThresholdBps;
        uint16 liquidationBonusBps;
        uint16 closeFactorBps;
        uint16 reserveFactorBps;
        uint16 baseRateBps;
        uint16 slope1Bps;
        uint16 slope2Bps;
        uint16 kinkBps;
    }

    address public immutable collateralToken;
    address public immutable borrowToken;
    IPriceOracle public immutable oracle;
    address public immutable collateralAssetForOracle;
    address public immutable borrowAssetForOracle;

    uint16 public immutable maxLtvBps;
    uint16 public immutable liquidationThresholdBps;
    uint16 public immutable liquidationBonusBps;
    uint16 public immutable closeFactorBps;
    uint16 public immutable reserveFactorBps;

    uint16 public immutable baseRateBps;
    uint16 public immutable slope1Bps;
    uint16 public immutable slope2Bps;
    uint16 public immutable kinkBps;

    /// Raw units in one whole token. Marks price that whole token, not one raw unit.
    uint256 private immutable collateralUnit;
    uint256 private immutable borrowUnit;

    uint256 public totalCollateral;
    uint256 public totalDebtShares;
    uint256 public totalCash;
    uint256 public borrowIndex = WAD;
    uint64 public lastAccrual;

    uint256 public reserveBalance;

    mapping(address => uint256) public collateralOf;
    mapping(address => uint256) public debtSharesOf;

    event Supply(address indexed user, uint256 amount);
    event WithdrawCollateral(address indexed user, uint256 amount);
    event Borrow(address indexed user, uint256 amount, uint256 shares);
    event Repay(address indexed user, uint256 amount, uint256 shares);
    event Liquidate(
        address indexed keeper, address indexed borrower, uint256 repayAmount, uint256 seizedCollateral
    );
    event Accrued(uint256 borrowIndex, uint256 reserveAdded);

    error BadConfig();
    error BadAmount();
    error TransferFailed();
    error Unhealthy();
    error Healthy();
    error InsufficientLiquidity();
    error NothingToRepay();

    constructor(MarketConfig memory c) {
        if (c.collateralToken == address(0) || c.borrowToken == address(0) || c.oracle == address(0)) revert BadConfig();
        if (c.collateralToken == c.borrowToken) revert BadConfig();
        if (c.maxLtvBps == 0 || c.maxLtvBps >= c.liquidationThresholdBps) revert BadConfig();
        if (c.liquidationThresholdBps > BPS) revert BadConfig();
        if (c.liquidationBonusBps > 2_000 || c.closeFactorBps == 0 || c.closeFactorBps > BPS) revert BadConfig();
        if (c.reserveFactorBps > BPS || c.kinkBps == 0 || c.kinkBps > BPS) revert BadConfig();

        collateralToken = c.collateralToken;
        borrowToken = c.borrowToken;
        oracle = IPriceOracle(c.oracle);
        collateralAssetForOracle = c.collateralAssetForOracle;
        borrowAssetForOracle = c.borrowAssetForOracle;
        maxLtvBps = c.maxLtvBps;
        liquidationThresholdBps = c.liquidationThresholdBps;
        liquidationBonusBps = c.liquidationBonusBps;
        closeFactorBps = c.closeFactorBps;
        reserveFactorBps = c.reserveFactorBps;
        baseRateBps = c.baseRateBps;
        slope1Bps = c.slope1Bps;
        slope2Bps = c.slope2Bps;
        kinkBps = c.kinkBps;
        collateralUnit = 10 ** uint256(IERC20Minimal(c.collateralToken).decimals());
        borrowUnit = 10 ** uint256(IERC20Minimal(c.borrowToken).decimals());
        lastAccrual = uint64(block.timestamp);
    }

    function supplyLiquidity(uint256 amount) external {
        if (amount == 0) revert BadAmount();
        accrue();
        if (!IERC20Minimal(borrowToken).transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        totalCash += amount;
        emit Supply(msg.sender, amount);
    }

    function depositCollateral(uint256 amount) external {
        if (amount == 0) revert BadAmount();
        accrue();
        if (!IERC20Minimal(collateralToken).transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        collateralOf[msg.sender] += amount;
        totalCollateral += amount;
    }

    function withdrawCollateral(uint256 amount) external {
        if (amount == 0) revert BadAmount();
        accrue();
        if (collateralOf[msg.sender] < amount) revert BadAmount();
        collateralOf[msg.sender] -= amount;
        totalCollateral -= amount;
        if (!_isHealthy(msg.sender, maxLtvBps)) revert Unhealthy();
        if (!IERC20Minimal(collateralToken).transfer(msg.sender, amount)) revert TransferFailed();
        emit WithdrawCollateral(msg.sender, amount);
    }

    function borrow(uint256 amount) external {
        if (amount == 0) revert BadAmount();
        accrue();
        if (totalCash < amount) revert InsufficientLiquidity();
        // Ceil shares so rounding never lets a borrower owe less than they took.
        uint256 shares = _debtToShares(amount);
        if (_sharesToDebt(shares) < amount) shares += 1;
        debtSharesOf[msg.sender] += shares;
        totalDebtShares += shares;
        totalCash -= amount;
        if (!_isHealthy(msg.sender, maxLtvBps)) revert Unhealthy();
        if (!IERC20Minimal(borrowToken).transfer(msg.sender, amount)) revert TransferFailed();
        emit Borrow(msg.sender, amount, shares);
    }

    function repay(uint256 amount) external {
        if (amount == 0) revert BadAmount();
        accrue();
        uint256 debt = _sharesToDebt(debtSharesOf[msg.sender]);
        if (debt == 0) revert NothingToRepay();
        uint256 pay = amount > debt ? debt : amount;
        // Full repay clears shares exactly — `_debtToShares(debt)` can round down and leave dust.
        uint256 shares = pay == debt ? debtSharesOf[msg.sender] : _debtToShares(pay);
        if (shares > debtSharesOf[msg.sender]) shares = debtSharesOf[msg.sender];
        debtSharesOf[msg.sender] -= shares;
        totalDebtShares -= shares;
        if (!IERC20Minimal(borrowToken).transferFrom(msg.sender, address(this), pay)) revert TransferFailed();
        totalCash += pay;
        emit Repay(msg.sender, pay, shares);
    }

    function liquidate(address borrower, uint256 repayAmount) external {
        if (repayAmount == 0) revert BadAmount();
        accrue();
        if (_isHealthy(borrower, liquidationThresholdBps)) revert Healthy();

        uint256 debt = _sharesToDebt(debtSharesOf[borrower]);
        uint256 maxRepay = (debt * closeFactorBps) / BPS;
        if (repayAmount > maxRepay) repayAmount = maxRepay;

        (uint256 colPrice,) = oracle.getMark(collateralAssetForOracle);
        (uint256 borPrice,) = oracle.getMark(borrowAssetForOracle);

        uint256 seize = (repayAmount * borPrice * (BPS + liquidationBonusBps) * collateralUnit)
            / (borrowUnit * colPrice * BPS);
        if (seize > collateralOf[borrower]) seize = collateralOf[borrower];

        uint256 shares = _debtToShares(repayAmount);
        if (shares > debtSharesOf[borrower]) {
            shares = debtSharesOf[borrower];
            repayAmount = _sharesToDebt(shares);
        }
        debtSharesOf[borrower] -= shares;
        totalDebtShares -= shares;
        collateralOf[borrower] -= seize;
        totalCollateral -= seize;

        if (!IERC20Minimal(borrowToken).transferFrom(msg.sender, address(this), repayAmount)) revert TransferFailed();
        totalCash += repayAmount;
        if (!IERC20Minimal(collateralToken).transfer(msg.sender, seize)) revert TransferFailed();
        emit Liquidate(msg.sender, borrower, repayAmount, seize);
    }

    function accrue() public {
        uint64 nowTs = uint64(block.timestamp);
        uint64 last = lastAccrual;
        if (nowTs == last) return;
        lastAccrual = nowTs;
        uint256 debt = totalDebt();
        if (debt == 0) {
            emit Accrued(borrowIndex, 0);
            return;
        }
        uint256 rateBps = _borrowAprBps(debt);
        uint256 interest = (debt * rateBps * uint256(nowTs - last)) / (BPS * SECONDS_PER_YEAR);
        if (interest == 0) {
            emit Accrued(borrowIndex, 0);
            return;
        }
        uint256 reserveAdd = (interest * reserveFactorBps) / BPS;
        reserveBalance += reserveAdd;
        borrowIndex = borrowIndex + (borrowIndex * interest) / debt;
        emit Accrued(borrowIndex, reserveAdd);
    }

    function totalDebt() public view returns (uint256) {
        return _sharesToDebt(totalDebtShares);
    }

    function debtOf(address user) public view returns (uint256) {
        return _sharesToDebt(debtSharesOf[user]);
    }

    function _borrowAprBps(uint256 debt) private view returns (uint256) {
        uint256 utilBps = (debt * BPS) / (debt + totalCash);
        if (utilBps <= kinkBps) {
            return uint256(baseRateBps) + (utilBps * uint256(slope1Bps)) / kinkBps;
        }
        uint256 excess = utilBps - kinkBps;
        return uint256(baseRateBps) + uint256(slope1Bps) + (excess * uint256(slope2Bps)) / (BPS - kinkBps);
    }

    function _isHealthy(address user, uint16 thresholdBps) private view returns (bool) {
        uint256 debt = _sharesToDebt(debtSharesOf[user]);
        if (debt == 0) return true;
        (uint256 colPrice,) = oracle.getMark(collateralAssetForOracle);
        (uint256 borPrice,) = oracle.getMark(borrowAssetForOracle);
        uint256 colValue = (collateralOf[user] * colPrice) / collateralUnit;
        uint256 debtValue = (debt * borPrice) / borrowUnit;
        return colValue * thresholdBps >= debtValue * BPS;
    }

    function _debtToShares(uint256 debt) private view returns (uint256) {
        if (totalDebtShares == 0 || borrowIndex == WAD) return debt;
        return (debt * WAD) / borrowIndex;
    }

    function _sharesToDebt(uint256 shares) private view returns (uint256) {
        return (shares * borrowIndex) / WAD;
    }
}
