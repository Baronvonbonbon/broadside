import { ethers } from "hardhat";

/**
 * Phase 8d-3+ Settlement now routes its inner pipeline (`_processBatch`)
 * to BroadsideSettlementLogicB via DELEGATECALL. Every test that deploys
 * BroadsideSettlement must wire LogicA + LogicB or the settle paths revert
 * with E00 ("logic not wired").
 *
 * Use this helper immediately after `settlement = await Factory.deploy(...)`
 * to keep the wiring boilerplate out of individual test files.
 */
export async function wireSettlementLogic(
  // The minimal shape we need from the deployed Settlement: any object
  // with `setLogic(addressA, addressB)` from the contract ABI. Typed loose
  // on purpose so this helper works with both BroadsideSettlement and
  // Hardhat's ethers Contract wrapper.
  settlement: { setLogic: (a: string, b: string) => Promise<unknown> }
): Promise<{ logicA: string; logicB: string }> {
  const LogicAFactory = await ethers.getContractFactory("BroadsideSettlementLogicA");
  const LogicBFactory = await ethers.getContractFactory("BroadsideSettlementLogicB");
  const logicA = await LogicAFactory.deploy();
  const logicB = await LogicBFactory.deploy();
  const a = await logicA.getAddress();
  const b = await logicB.getAddress();
  await settlement.setLogic(a, b);
  return { logicA: a, logicB: b };
}
