/**
 * Every chain the Products platform ships a descriptor for, with its genesis.
 *
 * Run 1 of the probe asked the host for `PASEO_NEXT_V2_ASSET_HUB` — the only
 * Asset Hub `@parity/truapi` names — and got:
 *
 *   Chain 0xbf0488db… is not supported by the current host.
 *
 * The mistake was assuming truapi's two well-known chains are the set the host
 * carries. They are not. `@parity/product-sdk-descriptors` ships **eight**, and
 * a host build carries some subset — `createApp({environment:"devnet"})`
 * succeeded, so this build carries at least devnet-bulletin. Which Asset Hub it
 * carries is the question that decides where Broadside's contracts have to live,
 * and it is answered by asking, not by picking a plausible one.
 *
 * Hashes were extracted from the descriptor packages themselves rather than
 * copied from documentation. Three of them cross-check against values from
 * independent sources — polkadot-asset-hub matches the hash sonde's chain probe
 * used, paseo-asset-hub and paseo-individuality match truapi's two well-known
 * entries — which is what makes the other five credible.
 */

export interface KnownChain {
  /** The `@parity/product-sdk-descriptors` subpath. */
  descriptor: string;
  name: string;
  genesis: `0x${string}`;
  /** Asset Hubs are the only ones that can hold a pallet-revive contract. */
  kind: "asset-hub" | "bulletin" | "individuality";
  env: "devnet" | "paseo" | "kusama" | "polkadot";
}

export const KNOWN_CHAINS: readonly KnownChain[] = [
  {
    descriptor: "devnet-asset-hub",
    name: "Devnet Asset Hub",
    genesis: "0xd6eec26135305a8ad257a20d003357284c8aa03d0bdb2b357ab0a22371e11ef2",
    kind: "asset-hub",
    env: "devnet",
  },
  {
    descriptor: "devnet-bulletin",
    name: "Devnet Bulletin",
    genesis: "0x919b08470811f08edef7c2d15d387182adf5b501c2a2c8486c5b829a2c78018b",
    kind: "bulletin",
    env: "devnet",
  },
  {
    descriptor: "devnet-individuality",
    name: "Devnet Individuality",
    genesis: "0xd66fa089bbdaf6cf9c93ebf09cbdb23cdc254b12c2cf8b286136b87ccd4dec0d",
    kind: "individuality",
    env: "devnet",
  },
  {
    descriptor: "paseo-asset-hub",
    name: "Paseo Next v2 Hub",
    genesis: "0xbf0488dbe9daa1de1c08c5f743e26fdc2a4ecd74cf87dd1b4b1eeb99ae4ef19f",
    kind: "asset-hub",
    env: "paseo",
  },
  {
    descriptor: "paseo-bulletin",
    name: "Paseo Bulletin",
    genesis: "0x8cfe6717dc4becfda2e13c488a1e2061ff2dfee96e7d031157f72d36716c0a22",
    kind: "bulletin",
    env: "paseo",
  },
  {
    descriptor: "paseo-individuality",
    name: "Paseo Next v2 Individuality",
    genesis: "0xc5af1826b31493f08b7e2a823842f98575b806a784126f28da9608c68665afa5",
    kind: "individuality",
    env: "paseo",
  },
  {
    descriptor: "kusama-asset-hub",
    name: "Kusama Asset Hub",
    genesis: "0x48239ef607d7928874027a43a67689209727dfb3d3dc5e5b03a39bdc2eda771a",
    kind: "asset-hub",
    env: "kusama",
  },
  {
    descriptor: "polkadot-asset-hub",
    name: "Polkadot Asset Hub",
    genesis: "0x68d56f15f85d3136970ec16946040bc1752654e906147f7e43e9d539d7c3de2f",
    kind: "asset-hub",
    env: "polkadot",
  },
] as const;

export const ASSET_HUBS = KNOWN_CHAINS.filter((c) => c.kind === "asset-hub");

export function chainByGenesis(genesis: string): KnownChain | undefined {
  const g = genesis.toLowerCase();
  return KNOWN_CHAINS.find((c) => c.genesis.toLowerCase() === g);
}
