/**
 * Constants the Human-settings page and the Host must agree on. Dependency-free because the Client bundle imports it.
 * @module @contexera/dsh-agent-team/human-settings
 */

/** Settings namespace of the Human profile: the Team Host row id in `cordis.patch.yml`. Use this constant, not `ctx.fiber.entry`: a Remote call runs under its caller's context, so that names the RPC gateway's row. */
export const HUMAN_PROFILE_SETTINGS_NAMESPACE = 'contexera-agent-team-host'

/**
 * The namespace this row carried before the published identity moved from
 * `@wowyuarm` to `@contexera`. A profile that has been in use since then still
 * holds its Human name and avatar under this key — the row rename means no
 * loader entry answers to it any more, so only an explicit migration can carry
 * the values across. Read-only: nothing writes it.
 */
export const LEGACY_HUMAN_PROFILE_SETTINGS_NAMESPACE = 'wowyuarm-agent-team-host'

/** Largest avatar payload the Host stores; the page refuses larger files before upload. */
export const HUMAN_AVATAR_MAX_BYTES = 10 * 1024 * 1024

/** Stored in the Host row's user layer to suppress an avatar supplied by inheritance. */
export const HUMAN_AVATAR_NONE = null
