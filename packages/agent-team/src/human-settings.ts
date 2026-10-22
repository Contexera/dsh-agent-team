/**
 * Constants the Human-settings page and the Host must agree on. Dependency-free because the Client bundle imports it.
 * @module @contexera/dsh-agent-team/human-settings
 */

/** Settings namespace of the Human profile: the Team Host row id in `cordis.patch.yml`. Use this constant, not `ctx.fiber.entry`: a Remote call runs under its caller's context, so that names the RPC gateway's row. */
export const HUMAN_PROFILE_SETTINGS_NAMESPACE = 'wowyuarm-agent-team-host'

/** Largest avatar payload the Host stores; the page refuses larger files before upload. */
export const HUMAN_AVATAR_MAX_BYTES = 10 * 1024 * 1024
