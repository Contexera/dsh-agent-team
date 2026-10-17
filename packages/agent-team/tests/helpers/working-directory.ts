/**
 * Structural stand-in for the harness `workingDirectory` service.
 *
 * From dsh 0.2.1, `@deepseek-ai/dsh-tool-skill` declares `workingDirectory` in
 * its `inject` list and calls `ctx.workingDirectory.ensure(agent, signal)`
 * while resolving a skill directory. A profile gets the real service from the
 * shipped `dsh-base` bundle, but a test harness builds its own Context and
 * therefore has to supply it: without the service the tool stays pending and
 * every Member it composes reports `availability: 'unavailable'`.
 *
 * This is a collaborator double, not a reimplementation: no filesystem checks
 * and no durable writes, so a test observes the directory a Session recorded
 * (or the fallback) and nothing else. The harness ships an equivalent fixture
 * (`provideWorkingDirectoryFixture` in `@deepseek-ai/dsh-agent-loop-testkit`),
 * but only from 0.2.1 — and this repository certifies against 0.2.0 as well,
 * where neither the package nor the `inject` entry exists. A local double keeps
 * one test surface valid across both lines instead of branching on a version.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'

/**
 * Supply fixed directory values without filesystem checks or durable changes.
 * @param ctx - context owning this test collaborator.
 * @param defaultDirectory - fallback for fixtures whose Session records none.
 */
export function provideWorkingDirectoryFixture(ctx: Context, defaultDirectory = process.cwd()): void {
  const directoryOf = (session: Session): string => session.header.cwd ?? defaultDirectory
  ctx.provide('workingDirectory', {
    defaultDirectory,
    get: directoryOf,
    ensure: (agent: Agent): Promise<string> => Promise.resolve(directoryOf(agent.session)),
  })
}
