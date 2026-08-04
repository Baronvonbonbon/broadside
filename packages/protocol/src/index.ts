/**
 * @broadside/protocol — constants every other package agrees on.
 *
 * Nothing here reaches the network or imports a chain library. That is the
 * point: contracts, widget, relay, cosigner and indexer all need the same
 * slot names, typehashes and creative sizes, and the way DATUM kept them in
 * sync was four byte-identical copies of registry.mjs plus a format table
 * duplicated between the SDK and the WordPress plugin. Anything shared lands
 * here instead.
 */

export * from "./claims.js";
export * from "./formats.js";
export * from "./registry.js";
