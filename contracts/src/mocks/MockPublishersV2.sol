// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;
import "../BroadsidePublishers.sol";
/// @dev Test-only successor exercising the BroadsidePublishers migrate() flow.
contract MockPublishersV2 is BroadsidePublishers {
    constructor(uint256 d, address p) BroadsidePublishers(d, p) {}
    function version() public pure override returns (uint256) { return 2; }
}
