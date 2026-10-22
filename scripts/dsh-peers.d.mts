/** Declaration for the untyped ESM module `dsh-peers.mjs`. */

/**
 * Every `@deepseek-ai/dsh-*` peer range in a manifest, deduplicated. The
 * certified line moves as one cut, so the set must hold exactly one range.
 */
export declare function dshPeerRanges(manifest: { peerDependencies?: Record<string, string> }): Set<string>
