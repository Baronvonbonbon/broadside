// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;
import "../BroadsideGovernance.sol";
import "../BroadsideParameterGovernance.sol";
import "../BroadsideCouncil.sol";
contract MockGovernanceV2Next is BroadsideGovernance {
    constructor(address c, uint256 q, uint256 s, uint256 tq, uint256 bg, uint256 gpq, uint256 mg, address pr)
        BroadsideGovernance(c, q, s, tq, bg, gpq, mg, pr) {}
    function version() public pure override returns (uint256) { return 3; }
}
contract MockParameterGovernanceNext is BroadsideParameterGovernance {
    constructor(address pr, uint256 vp, uint256 tl, uint256 q, uint256 pb)
        BroadsideParameterGovernance(pr, vp, tl, q, pb) {}
    function version() public pure override returns (uint256) { return 2; }
}
contract MockCouncilNext is BroadsideCouncil {
    constructor(address[] memory m, uint256 t, address g, uint256 vp, uint256 ed, uint256 vw, uint256 mw)
        BroadsideCouncil(m, t, g, vp, ed, vw, mw) {}
    function version() public pure override returns (uint256) { return 2; }
}
