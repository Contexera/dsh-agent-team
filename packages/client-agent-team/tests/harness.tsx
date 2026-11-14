import { expect, onTestFinished } from 'vitest'
import { cleanup } from '@testing-library/react'
import type { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type {
  AgentTeamSubscriptionListEntry,
  AgentTeamSubscriptionLogEntry,
  AgentTeamTask,
  AgentTeamWorkerStateView,
} from '@contexera/dsh-agent-team/types'
import { apply, inject } from '../src/client/index.ts'
import { drainSlotCrashes } from './bench/jsdom-polyfills.ts'
import { createBenchRuntime } from './bench/runtime-assembly.tsx'
import { createProjectsAndMembersDouble } from './bench/projects-and-members.ts'
import { createInboxAndStreamDouble, type MainStreamSeedEntry } from './bench/inbox-and-stream.ts'
import {
  buildInitialSeedState,
  createThreadsAndTasksDouble,
  type SeededMessage,
} from './bench/threads-and-tasks.ts'
import {
  createSettingsAndSubscriptionsDouble,
  type EnvironmentSeed,
  type HumanProfileSeed,
} from './bench/settings-and-subscriptions.ts'

export { failNext, holdNext } from './bench/faults.ts'
export {
  openProject,
  openTask,
  openTeam,
  pressStartTask,
  pressStartThread,
} from './bench/navigation.ts'
export type { MainStreamSeedEntry } from './bench/inbox-and-stream.ts'

export interface ClientTestBenchOptions {
  readonly mode?: 'team'
  readonly mainPanelId?: string
  readonly workspaceId?: string
  readonly initialProjects?: boolean
  readonly remainingUnreadCounts?: readonly number[]
  readonly seededMessages?: readonly SeededMessage[]
  readonly seedTaskRef?: string
  readonly seedThreadRef?: string
  readonly seedTaskless?: boolean
  readonly seedsAsMainMessages?: boolean
  readonly seedTaskStatus?: AgentTeamTask['status']
  readonly seedFollowers?: readonly string[]
  readonly humanProfile?: HumanProfileSeed
  readonly humanProfileFailure?: string
  readonly mainStreamEntries?: readonly MainStreamSeedEntry[]
  readonly mainStreamUnread?: number
  readonly environment?: EnvironmentSeed
  readonly environmentFailure?: string
  readonly subscriptions?: readonly AgentTeamSubscriptionListEntry[]
  readonly subscriptionFailure?: string
  readonly subscriptionRuns?: Readonly<Record<string, readonly AgentTeamSubscriptionLogEntry[]>>
  readonly subscriptionDraftFailure?: string
  readonly seededWorkerActivities?: readonly Record<string, unknown>[]
  readonly seededWorkerStates?: readonly AgentTeamWorkerStateView[]
}

export async function createClientBench(options?: ClientTestBenchOptions) {
  let runtime: SlotTestRuntime | undefined
  let disposed = false

  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    const errors: unknown[] = []
    try {
      cleanup()
    } catch (error) {
      errors.push(error)
    }
    try {
      if (runtime !== undefined) await runtime.dispose()
    } catch (error) {
      errors.push(error)
    }
    try {
      localStorage.clear()
    } catch (error) {
      errors.push(error)
    }
    try {
      const crashes = drainSlotCrashes()
      expect(crashes, `slot entries crashed:\n${crashes.join('\n')}`).toEqual([])
    } catch (error) {
      errors.push(error)
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'ClientTestBench cleanup failed')
  }

  onTestFinished(dispose)

  try {
    if (options?.mode !== undefined) {
      localStorage.setItem(
        'dsh.agent-team.navigation',
        JSON.stringify({ mode: options.mode, ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }) }),
      )
    }

    const shell = await createBenchRuntime((created) => {
      runtime = created
    })

    const { viewItems, initialMainEntries } = buildInitialSeedState(options)
    const projectsAndMembers = createProjectsAndMembersDouble({ initialProjects: options?.initialProjects })
    const inboxAndStream = createInboxAndStreamDouble({
      initialEntries: initialMainEntries,
      mainStreamUnread: options?.mainStreamUnread,
    })
    const threadsAndTasks = createThreadsAndTasksDouble({
      initialViewItems: viewItems,
      seededWorkerActivities: options?.seededWorkerActivities,
      seededWorkerStates: options?.seededWorkerStates,
      remainingUnreadCounts: options?.remainingUnreadCounts,
      seedFollowers: options?.seedFollowers,
      getProjects: projectsAndMembers.getProjects,
      getMemberships: projectsAndMembers.getMemberships,
      getOwners: projectsAndMembers.getOwners,
      getMainEntries: inboxAndStream.getMainEntries,
      setMainEntries: inboxAndStream.setMainEntries,
      clearInboxForThread: inboxAndStream.clearInboxForThread,
      wakeAll: inboxAndStream.wakeAll,
    })
    const settingsAndSubscriptions = createSettingsAndSubscriptionsDouble(options)

    shell.runtime.remote.provideNamespaces({
      session: { modelCatalog: projectsAndMembers.modelCatalog },
      settings: {
        describe: settingsAndSubscriptions.settingsDescribe,
        mutate: settingsAndSubscriptions.settingsMutate,
      },
      agentTeam: {
        members: projectsAndMembers.members,
        joinWorkspace: projectsAndMembers.joinWorkspace,
        leaveWorkspace: projectsAndMembers.leaveWorkspace,
        addMember: projectsAndMembers.addMember,
        toolCatalog: settingsAndSubscriptions.toolCatalog,
        view: threadsAndTasks.viewProjects,
        inbox: inboxAndStream.inbox,
        taskBoard: threadsAndTasks.loadTaskBoard,
        readThread: threadsAndTasks.readThread,
        threadHistory: threadsAndTasks.loadThreadHistory,
        threadObservations: threadsAndTasks.threadObservations,
        putAttachment: projectsAndMembers.putAttachment,
        getAttachment: projectsAndMembers.getAttachment,
        createProject: projectsAndMembers.createProject,
        updateProject: projectsAndMembers.updateProject,
        archiveProject: projectsAndMembers.archiveProject,
        addProjectOwner: projectsAndMembers.addProjectOwner,
        removeProjectOwner: projectsAndMembers.removeProjectOwner,
        updateMember: projectsAndMembers.updateMember,
        recoverMember: projectsAndMembers.recoverMember,
        archiveMember: projectsAndMembers.archiveMember,
        postMainMessage: inboxAndStream.postMainMessage,
        startThread: threadsAndTasks.startThread,
        readMainStream: inboxAndStream.readMainStream,
        mainStreamHistory: inboxAndStream.mainStreamHistory,
        reply: threadsAndTasks.reply,
        changeTask: threadsAndTasks.changeTask,
        promoteThread: threadsAndTasks.promoteThread,
        changeAttention: threadsAndTasks.changeAttention,
        transferTask: threadsAndTasks.transferTask,
        resolveTaskRefs: threadsAndTasks.resolveTaskRefs,
        resolveThreadRefs: threadsAndTasks.resolveThreadRefs,
        resolveMessageRefs: threadsAndTasks.resolveMessageRefs,
        changes: inboxAndStream.changes,
        environment: settingsAndSubscriptions.environment,
        humanProfile: settingsAndSubscriptions.humanProfile,
        setHumanProfile: settingsAndSubscriptions.setHumanProfile,
        putHumanAvatar: settingsAndSubscriptions.putHumanAvatar,
        getHumanAvatar: settingsAndSubscriptions.getHumanAvatar,
        removeHumanAvatar: settingsAndSubscriptions.removeHumanAvatar,
        subscriptions: settingsAndSubscriptions.loadSubscriptions,
        subscriptionLogs: settingsAndSubscriptions.loadSubscriptionLogs,
        testSubscriptionDraft: settingsAndSubscriptions.testSubscriptionDraft,
        createSubscription: settingsAndSubscriptions.unwiredSubscriptionWrite,
        updateSubscription: settingsAndSubscriptions.unwiredSubscriptionWrite,
        pauseSubscription: settingsAndSubscriptions.unwiredSubscriptionWrite,
        resumeSubscription: settingsAndSubscriptions.unwiredSubscriptionWrite,
        deleteSubscription: settingsAndSubscriptions.unwiredSubscriptionWrite,
      },
    })

    const mounted = await shell.mountShell(
      inboxAndStream.connection,
      options?.mainPanelId,
      () => shell.runtime.mount({ inject: [...inject], apply }),
    )

    return {
      runtime: shell.runtime,
      team: mounted.team,
      view: mounted.view,
      dispose,
      panelInfo: shell.runtime.panelInfo,
      selectPanel: shell.selectPanel,
      openSession: shell.openSession,
      disposeWorkspace: mounted.disposeWorkspace,
      disposeSettings: mounted.disposeSettings,
      ...projectsAndMembers,
      ...inboxAndStream,
      ...threadsAndTasks,
      ...settingsAndSubscriptions,
    }
  } catch (error) {
    await dispose()
    throw error
  }
}

export type ClientTestBench = Awaited<ReturnType<typeof createClientBench>>

/** Backward-compatible wrapper delegating to `createClientBench`. */
export async function runtimeWithTeam(options?: ClientTestBenchOptions) {
  return createClientBench(options)
}
