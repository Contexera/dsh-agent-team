/**
 * The continuity compaction engine, mounted under this bundle's own name.
 *
 * The preset row that mounts the compaction engine is resolved by the Loader
 * from the *profile*, not from this bundle's `node_modules`: a row name is a
 * bare specifier imported against the profile's own base, so it sees the
 * packages the profile links (this bundle among them) and the host closure —
 * and never a package nested inside this bundle's dependency tree. Naming
 * `@wowyuarm/dsh-context-continuity/compaction-engine` directly therefore
 * resolves in a working tree and fails in a real profile, where the row is
 * reported as `never started` and every Member is left unavailable.
 *
 * Re-exporting it here is what gives the row a name the profile can resolve.
 * The module is a pure re-export: it adds no behavior, and the engine keeps
 * owning its own selection, retention, and summarization.
 * @module @contexera/dsh-agent-team/compaction-engine
 */

export { default } from '@wowyuarm/dsh-context-continuity/compaction-engine'
