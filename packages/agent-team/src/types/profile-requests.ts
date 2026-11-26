/** Remote contracts for composer attachments, the Human profile and avatar, sidebar order, environment and tool catalog. */
import type { WorkspaceId } from "@deepseek-ai/dsh-workspace"
import type { AgentTeamAttachmentId, AgentTeamRequestId } from "./entities.ts"

/** Upload one composer attachment into the Team attachment cache. */
export interface AgentTeamPutAttachmentRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly name: string
  readonly mediaType?: string | undefined
  readonly bytesBase64: string
}

export interface AgentTeamPutAttachmentResult {
  readonly attachmentId: AgentTeamAttachmentId
  /** Absolute path members read the bytes from; stable for the cache lifetime. */
  readonly path: string
  readonly name: string
  readonly byteSize: number
  readonly mediaType: string
}

/** Read one uploaded attachment back for client-side display. */
export interface AgentTeamGetAttachmentRequest {
  readonly attachmentId: AgentTeamAttachmentId
}

export interface AgentTeamGetAttachmentResult {
  readonly name: string
  readonly mediaType: string
  readonly byteSize: number
  readonly bytesBase64: string
}

/** Native desktop action for one cached attachment; both use the Host's own file associations. */
export type AgentTeamAttachmentAction = 'open' | 'reveal'

/** Open or reveal one cached attachment in the serving desktop's default application or file manager. */
export interface AgentTeamOpenAttachmentRequest {
  readonly attachmentId: AgentTeamAttachmentId
  /** Defaults to `open`; `reveal` shows the file in the file manager instead. */
  readonly action?: AgentTeamAttachmentAction | undefined
  /** A handler id previously returned by `attachmentApplications`; omitted uses the OS default handler. */
  readonly application?: string | undefined
}

export interface AgentTeamOpenAttachmentResult {
  /** False when the Host has no desktop opener (for example a headless Linux server); failed opens reject instead. */
  readonly opened: boolean
}

/** List the OS handlers currently registered for one cached attachment. */
export interface AgentTeamAttachmentApplicationsRequest {
  readonly attachmentId: AgentTeamAttachmentId
}

/** One OS-registered handler for a cached attachment, mirroring the Host file-association metadata. */
export interface AgentTeamAttachmentApplication {
  readonly id: string
  readonly name: string
  readonly default: boolean
  /** PNG or SVG data URL, or null when the desktop supplies no icon. */
  readonly icon: string | null
}

/** Human profile read: name + avatar reference + version footnote facts. */
export interface AgentTeamHumanProfileRequest {
}

export interface AgentTeamHumanProfileResult {
  readonly name: string
  readonly avatarRef?: string | undefined
  /** Opaque Host-instance plus settings-revision fence; return it verbatim on the next profile write. */
  readonly settingsFence?: string | undefined
  /** Bundle version shown in the settings footnote. */
  readonly version: string
  /** Repository home the footnote links to. */
  readonly repoUrl: string
  /** A newer published release, when known. Best-effort and cached Host-side (npm `latest`, 12 h TTL, silent on failure); absent until a background refresh observes one. */
  readonly latestVersion?: string | undefined
}

/**
 * Read of the Human's own sidebar row order: one map from `<workspaceId>|projects`
 * or `<workspaceId>|agents` to the refs in the order the Human dragged them.
 * Presentation only; no Agent tool reads or writes it.
 */
export interface AgentTeamSidebarOrderRequest {
}

export interface AgentTeamSidebarOrderResult {
  readonly lists: Readonly<Record<string, readonly string[]>>
}

/** Replace one list's saved order; the Host judges the key and the refs, then answers with the whole map. */
export interface AgentTeamSidebarOrderWriteRequest {
  readonly key: string
  readonly refs: readonly string[]
}

/** Local environment read: how the running DSH compares to the declared support line. */
export interface AgentTeamEnvironmentRequest {
}

/** `undetermined` answers every fact this Host cannot establish (unreadable runtime version, unstated support range) and is never a guessed verdict; the two causes are indistinguishable to the reader and recorded only in `reason`. */
export type AgentTeamEnvironmentVerdict = 'ok' | 'out-of-range' | 'undetermined'

/** Declared DSH support line, stated in words by the page rather than as a range string. */
export interface AgentTeamEnvironmentSupportRange {
  /** Lower bound of the declared range, which is also the certified baseline. */
  readonly lower: string
  /** Exclusive upper bound of the declared range. */
  readonly upper: string
}

export interface AgentTeamEnvironmentResult {
  readonly verdict: AgentTeamEnvironmentVerdict
  /** Host-side diagnostic behind an `undetermined` verdict; not rendered as user copy. */
  readonly reason?: string | undefined
  readonly bundleVersion?: string | undefined
  /** The running DSH version the page states it is running; distinct from `certifiedDshVersion`, the line this bundle declares. */
  readonly dshVersion?: string | undefined
  /** Lower bound of the declared range: the certified, actually-tested DSH line. */
  readonly certifiedDshVersion?: string | undefined
  readonly supportRange?: AgentTeamEnvironmentSupportRange | undefined
}

/**
 * Discovery read of global and live Member-scoped tool registrations. It names
 * tools the profile could grant; it is not a step-admission snapshot and never
 * claims which plugin registered a name.
 */
export interface AgentTeamToolCatalogRequest {
}

export interface AgentTeamToolCatalogResult {
  /** Exact names only, sorted for stable display, with Team-owned names removed. */
  readonly names: readonly string[]
}

/** Human display-name write against the settings revision the page read. */
export interface AgentTeamSetHumanProfileRequest {
  readonly name: string
  readonly expectedFence: string
}

/** Resolved Human profile after a write. */
export interface AgentTeamSetHumanProfileResult {
  readonly name: string
  readonly avatarRef?: string | undefined
  readonly settingsFence?: string | undefined
}

/** Prepare and commit one replacement avatar as a single settings intent. */
export interface AgentTeamPutHumanAvatarRequest {
  readonly name: string
  readonly mediaType?: string | undefined
  readonly bytesBase64: string
  readonly expectedFence: string
}

export interface AgentTeamPutHumanAvatarResult {
  readonly name: string
  readonly avatarRef?: string | undefined
  readonly settingsFence?: string | undefined
}

/** Read one human avatar back for client-side display. */
export interface AgentTeamGetHumanAvatarRequest {
  readonly avatarRef: string
}

export interface AgentTeamGetHumanAvatarResult {
  readonly name: string
  readonly mediaType: string
  readonly byteSize: number
  readonly bytesBase64: string
}

/** Replace the profile's avatar reference with the explicit no-avatar sentinel. */
export interface AgentTeamRemoveHumanAvatarRequest {
  readonly expectedFence: string
}

export interface AgentTeamRemoveHumanAvatarResult {
  readonly name: string
  readonly avatarRef?: string | undefined
  readonly settingsFence?: string | undefined
}
