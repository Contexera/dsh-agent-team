/**
 * What the Human-settings surface and the Host must agree on.
 *
 * The Client stores no Team fact of its own, but two numbers on this page are
 * only useful if both halves mean the same thing by them: the row section a
 * write lands in, and the size above which an upload is refused. Spelled once
 * here rather than in each half, because a copy that drifts surfaces as a
 * user-visible failure — a write addressed at a section nobody reads, or a file
 * the page accepts and the Host then refuses after the round trip.
 *
 * Dependency-free on purpose: the Client bundle imports this module, so it must
 * not reach the Host's Node-side modules.
 *
 * @module @contexera/dsh-agent-team/human-settings
 */

/**
 * Settings namespace of the Human profile: the Team Host row's id in
 * `cordis.patch.yml`, which is what the settings service addresses a form and a
 * write by AND the id the profile-document write patches. It is addressed by
 * this constant, never by the running Host's `ctx.fiber.entry`: a Remote call
 * runs under its caller's context, so that lookup names the RPC gateway's row.
 * `shipping.spec.ts` pins the constant to the row the composition declares.
 */
export const HUMAN_PROFILE_SETTINGS_NAMESPACE = 'wowyuarm-agent-team-host'

/**
 * Largest avatar payload the Host stores. The page refuses a larger file before
 * the round trip, so the reader learns the limit without uploading it first.
 */
export const HUMAN_AVATAR_MAX_BYTES = 10 * 1024 * 1024
