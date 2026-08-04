import "@nomicfoundation/hardhat-toolbox";
import type { HardhatUserConfig } from "hardhat/config";

/**
 * Hardhat exists here for the **test suite**, not for deployment.
 *
 * Deployment goes through `scripts/build.mjs` (solc + resolc) and
 * `scripts/deploy.mjs`, because what ships is a PolkaVM blob and hardhat has no
 * opinion about those. What hardhat gives us is DATUM's ~2,080 test cases
 * running against an EVM simulator, which is where contract *logic* is checked.
 *
 * That distinction is worth being explicit about rather than blurring: these
 * tests prove the settlement pipeline is correct, not that it behaves
 * identically once lowered to PolkaVM. The seam probe covers the second
 * question — a native PolkaVM blob accepting an off-chain EIP-712 signature —
 * and the two together are the argument. Neither is sufficient alone.
 */
const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      // Identical to DATUM's, so a ported test that passes there and fails
      // here is a porting fault rather than a compiler-settings difference.
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      evmVersion: "cancun",
      // test/settlement-layout.test.ts asserts Settlement, LogicA and LogicB
      // share identical slot assignments. That invariant is what makes the
      // DELEGATECALL split safe, and the split survived the port — the merge
      // was measured at 138.7% of the blob limit and rejected — so the
      // invariant, and this option, are still load-bearing.
      outputSelection: { "*": { "*": ["storageLayout"] } },
    },
  },
  paths: {
    sources: "./src",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  networks: {
    hardhat: {
      // Several ported contracts exceed EIP-170 as EVM bytecode — Campaigns is
      // 24,883 bytes, 101.2% of it. They are deployable as PolkaVM blobs at
      // 77% of *that* ceiling, which is the entire point of the migration, but
      // the EVM simulator would refuse them without this.
      allowUnlimitedContractSize: true,
      blockGasLimit: 1_000_000_000,
    },
  },
  mocha: {
    // ZK proving and the larger fixtures are slow; DATUM uses the same budget.
    timeout: 300_000,
  },
};

export default config;
