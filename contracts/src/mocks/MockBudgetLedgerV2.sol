// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "../BroadsideBudgetLedger.sol";

/// @dev Test-only successor exercising the BroadsideUpgradable migrate() flow
///      against BroadsideBudgetLedger: bumps version() and inherits the enumerable
///      `_migrate` + `migrateFundsTo`, so the migration test can verify budget
///      accounting + refunds + native DOT are copied from a frozen predecessor.
contract MockBudgetLedgerV2 is BroadsideBudgetLedger {
    // version 3 (> BroadsideBudgetLedger's 2) so it remains a valid migrate target.
    function version() public pure override returns (uint256) { return 3; }
}
