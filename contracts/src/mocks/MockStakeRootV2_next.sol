// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;
import "../BroadsideStakeRoot.sol";
import "../BroadsideStakeRootV2.sol";
import "../BroadsideBondedIdentityReporter.sol";
/// @dev Test-only successors for the StakeRoot cluster migration.
contract MockStakeRootNext is BroadsideStakeRoot {
    function version() public pure override returns (uint256) { return 2; }
}
contract MockStakeRootV2Next is BroadsideStakeRootV2 {
    constructor(address t, uint256 ms, uint64 ed, uint16 at, uint64 cw, uint256 pb, uint256 cb, uint16 stc, uint16 sa, uint256 cmb, address tok)
        BroadsideStakeRootV2(t, ms, ed, at, cw, pb, cb, stc, sa, cmb, tok) {}
    function version() public pure override returns (uint256) { return 2; }
}
contract MockBondedIdentityReporterNext is BroadsideBondedIdentityReporter {
    constructor(address t, uint256 ms, uint64 ed, uint16 at, uint64 cw, uint256 pb, uint256 cb, uint16 stc, uint16 sa)
        BroadsideBondedIdentityReporter(t, ms, ed, at, cw, pb, cb, stc, sa) {}
    function version() public pure override returns (uint256) { return 2; }
}
