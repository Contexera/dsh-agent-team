import { projectRefOf, service, workspaceParam } from './host-access.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { teamWorkerOutput } from './worker-output.ts'
import { blankToAbsent, OPTIONAL_ADDRESS_KEYS, requestId } from './tool-input.ts'

const WORKER_BLANK_KEYS = [...OPTIONAL_ADDRESS_KEYS, 'task', 'stop', 'inspect', 'steer', 'instruction', 'cwd', 'requestId'] as const

/** A control call may carry the first enum value as a neutral fill, but no other engine. */
function namesAnotherEngine(args: { readonly engine?: string | undefined }): boolean {
  return args.engine !== undefined && args.engine !== 'codex'
}

export const teamWorker = defineTool({
  name: 'team_worker',
  description: `Delegate one self-contained piece of work to a local Worker engine (Codex or Claude Code) that runs with its own tools, login, and settings, or steer, stop, or inspect a Worker this session delegated. Use it for work you can hand over completely: investigation, a scoped change in a prepared working directory, or a check that needs another engine. The Worker does not see this conversation, holds no Team identity, and cannot claim, accept, or answer for you, so the task text must carry the goal, the background, the scope, and what evidence to bring back. Name the Thread or Task the work belongs to and everything about the run is published there: the Thread shows when it started and how it ended, and its answer arrives in your Inbox — the other participants never see the raw output. Name only a Project and the result comes back to this session alone, published nowhere. The call returns as soon as the execution is accepted; keep working and do not poll. A Worker affects Project responsibility in no way: if you delegate work on a Task, the Claim stays yours and you still verify the result yourself, and a finished run never accepts a Task. Delegation needs the Team setting "allow Project owners to delegate Workers", your ownership of the Project the target belongs to, and an enabled engine; a refusal names which condition failed. To add one instruction, pass the original worker ref as steer with the instruction. A running Codex or Claude execution takes it into the same native session, possibly in its current turn or its next turn. If that execution has ended cleanly, steer resumes the same native conversation as one new linked execution; the receipt returns its new worker ref and says that a continuation started. A stopping execution, an unconfirmed ending, an archived or no-longer-owned Project, a disabled Member or engine setting, or a missing native record is refused instead of being revived. The receipt says submitted or continuation started, never that the model has read the instruction. To stop one execution, pass only its worker ref as stop; the call returns once the engine confirmed its cleanup, and a run that ended first answers with the state it really ended in. Another Member's run cannot be stopped this way. To read one execution's diagnostic, pass only its worker ref as inspect: the call answers with the same summary the Thread carries, the native identities the Host recorded, and whatever the engine's own record still answers after its process exited. The native record itself is never copied into the Team, and only the Member who delegated the run or the Human may read it.`,
  parameters: {
    threadRef: { type: 'string', description: 'The Thread this work reports into, as a thread: ref. The run\'s start, ending, and Inbox wake all point at it. Its Project authorizes the delegation.' },
    taskRef: { type: 'string', description: 'The Task this work is for, as a task: ref. It fixes the Thread as well; naming a Thread and a Task together is accepted only when the Task is in that Thread.' },
    projectRef: { type: 'string', description: 'The Project to delegate into, as a project: ref from team_view. Omit whenever threadRef or taskRef already names it; with none of the three there is no target to authorize.' },
    task: { type: 'string', description: 'The complete task for the Worker: goal, background it needs, working scope, and the evidence to return. It cannot ask you follow-up questions. Required unless stop names a run to end.' },
    stop: { type: 'string', description: 'A worker: ref this session delegated. With this the call stops that execution instead of starting one: pass it alone, with no task, target, engine, directory, or request id.' },
    inspect: { type: 'string', description: 'A worker: ref this session delegated. With this the call reads that execution\'s diagnostic instead of starting or stopping one: pass it alone, with no task, target, engine, directory, or request id. A run that has not ended answers with the summary alone.' },
    steer: { type: 'string', description: 'A worker: ref this session delegated. With this the call adds one instruction in that Worker\'s same native session: pass it with instruction, and with no task, target, engine, directory, stop, or inspect. A running execution may take it in the current turn or its next turn. An ended execution that ended cleanly is resumed as a new linked execution and the receipt returns its new worker ref.' },
    instruction: { type: 'string', description: 'The one instruction to submit with steer. It is deduplicated per execution while it is pending, submitted, or has an unknown delivery outcome. An explicit native refusal did not deliver it, so the same text may be retried under a fresh request id, and a later linked execution may receive it under a fresh id.' },
    engine: { type: 'string', enum: ['codex', 'claude'], description: 'Engine to run. Omit for the Project default the Host settings name.' },
    cwd: { type: 'string', description: 'Absolute working directory the Worker runs in. Omit to use this session\'s own directory.' },
    requestId: { type: 'string', description: 'Optional idempotency key for a start or steer: resending the same value with the same request returns the execution or receipt the first call produced, even when both calls arrive at once. A changed instruction, or a resend from another Member, is refused rather than applied to a run it did not ask for.' },
    workspace: workspaceParam,
  },
  output: teamWorkerOutput,
  async execute(rawArgs, exec) {
    const args = blankToAbsent(rawArgs, WORKER_BLANK_KEYS)
    const agent = exec.agent
    if (agent === undefined) throw new Error('team_worker requires an Agent session')
    const host = service(agent)
    if (args.stop !== undefined && args.inspect !== undefined) {
      throw new Error('team_worker takes one worker ref at a time: pass stop or inspect, not both.')
    }
    if (args.steer !== undefined && (args.stop !== undefined || args.inspect !== undefined)) {
      throw new Error('team_worker takes one worker ref at a time: pass steer, stop, or inspect — never two of them.')
    }
    if (args.inspect !== undefined) {
      // Reading a diagnostic is its own call: it names one run and nothing else,
      // so a half-filled start can never be read as a look-up.
      if (args.task !== undefined || args.threadRef !== undefined || args.taskRef !== undefined
        || args.projectRef !== undefined || namesAnotherEngine(args) || args.cwd !== undefined
        || args.requestId !== undefined || args.steer !== undefined || args.instruction !== undefined) {
        throw new Error('team_worker takes either a task to start or an inspect ref, not both: pass inspect alone.')
      }
      const inspection = await host.workerInspectForAgent(agent, { workerRef: args.inspect as Parameters<typeof host.workerInspectForAgent>[1]['workerRef'] })
      return {
        mode: 'inspect', workerRef: inspection.workerRef, state: inspection.state, engine: inspection.engine,
        projectRef: inspection.projectRef,
        ...(inspection.threadRef === undefined ? {} : { threadRef: inspection.threadRef }),
        ...(inspection.startedAt === undefined ? {} : { startedAt: inspection.startedAt }),
        ...(inspection.settledAt === undefined ? {} : { settledAt: inspection.settledAt }),
        summary: inspection.summary,
        ...(inspection.stage === undefined ? {} : { stage: inspection.stage }),
        ...(inspection.native.threadId === undefined ? {} : { nativeThreadId: inspection.native.threadId }),
        ...(inspection.native.turnId === undefined ? {} : { nativeTurnId: inspection.native.turnId }),
        ...(inspection.native.turnIds === undefined ? {} : { nativeTurnIds: [...inspection.native.turnIds] }),
        ...(inspection.native.inputIds === undefined ? {} : { nativeInputIds: [...inspection.native.inputIds] }),
        ...(inspection.native.storage === undefined ? {} : { nativeStorage: inspection.native.storage }),
        nativeRecord: inspection.history.kind,
        ...inspection.history.kind !== 'read' ? { nativeReason: inspection.history.reason } : {
          ...(inspection.history.fragments.length === 0 ? {} : {
            nativeFragments: inspection.history.fragments.map(fragment => ({ kind: fragment.kind, text: fragment.text })) }),
          ...(inspection.history.withheld === 0 ? {} : { nativeWithheld: inspection.history.withheld }),
          ...(inspection.history.truncated ? { nativeTruncated: true } : {}),
        },
      }
    }
    if (args.steer !== undefined) {
      // A steer names one run and one instruction, and nothing else: a
      // half-filled start must never be read as a steer to a live native session.
      if (args.task !== undefined || args.threadRef !== undefined || args.taskRef !== undefined
        || args.projectRef !== undefined || namesAnotherEngine(args) || args.cwd !== undefined
        || args.stop !== undefined || args.inspect !== undefined) {
        throw new Error('team_worker takes either a task to start, a stop ref, an inspect ref, or a steer ref with its instruction: pass steer alone with instruction.')
      }
      if (args.instruction === undefined || args.instruction.trim() === '') {
        throw new Error('team_worker needs the instruction to add when steer names a run: pass steer with instruction.')
      }
      const steered = await host.workerSteerForAgent(agent, {
        workerRef: args.steer as Parameters<typeof host.workerSteerForAgent>[1]['workerRef'],
        instruction: args.instruction,
        requestId: (args.requestId ?? requestId(agent.id, exec.callId)) as Parameters<typeof host.workerSteerForAgent>[1]['requestId'],
      })
      return {
        mode: 'steer', workerRef: steered.workerRef, state: steered.state, engine: steered.engine,
        ...(steered.continuedFrom === undefined ? {} : { continuedFrom: steered.continuedFrom }),
        ...(steered.landed === undefined ? {} : { landed: steered.landed }),
        ...(steered.turnId === undefined ? {} : { turnId: steered.turnId }),
        runState: steered.runState,
      }
    }
    if (args.instruction !== undefined && args.steer === undefined) {
      throw new Error('team_worker takes instruction only with steer: name the Worker execution whose native session should take it.')
    }
    if (args.stop !== undefined) {
      // Starting and stopping are different calls: a stop names one run and
      // nothing else, so a half-filled start can never be read as a stop.
      if (args.task !== undefined || args.threadRef !== undefined || args.taskRef !== undefined
        || args.projectRef !== undefined || namesAnotherEngine(args) || args.cwd !== undefined
        || args.requestId !== undefined || args.steer !== undefined || args.instruction !== undefined) {
        throw new Error('team_worker takes either a task to start or a stop ref, not both: pass stop alone.')
      }
      const stopped = await host.workerStopForAgent(agent, { workerRef: args.stop as Parameters<typeof host.workerStopForAgent>[1]['workerRef'] })
      return {
        workerRef: stopped.workerRef, state: stopped.state, engine: stopped.engine,
        ...(stopped.settledAt === undefined ? {} : { settledAt: stopped.settledAt }),
        // The Host's own sentence about a failure rides the receipt: a state
        // alone would drop the cleanup warning the model has to act on.
        ...(stopped.diagnostic === undefined ? {} : { diagnostic: stopped.diagnostic }),
      }
    }
    if (args.task === undefined || args.task.trim() === '') {
      throw new Error('team_worker needs a task to start a Worker, or a stop ref to end one.')
    }
    const request = {
      requestId: (args.requestId ?? requestId(agent.id, exec.callId)) as Parameters<typeof host.workerStartForAgent>[1]['requestId'],
      task: args.task,
      ...(args.projectRef === undefined ? {} : { projectRef: projectRefOf(args.projectRef) as Parameters<typeof host.workerStartForAgent>[1]['projectRef'] }),
      ...(args.threadRef === undefined ? {} : { threadRef: args.threadRef as NonNullable<Parameters<typeof host.workerStartForAgent>[1]['threadRef']> }),
      ...(args.taskRef === undefined ? {} : { taskRef: args.taskRef as NonNullable<Parameters<typeof host.workerStartForAgent>[1]['taskRef']> }),
      ...(args.engine === undefined ? {} : { engine: args.engine as 'codex' | 'claude' }),
      ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
    }
    const run = await host.workerStartForAgent(agent, request)
    return {
      workerRef: run.workerRef, projectRef: run.projectRef, engine: run.engine,
      state: run.state, cwd: run.cwd, startedAt: run.startedAt,
      ...(run.threadRef === undefined ? {} : { threadRef: run.threadRef }),
    }
  },
})
