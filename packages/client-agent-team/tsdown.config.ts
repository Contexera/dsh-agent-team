import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
// One pointer for every consumer: scripts/harness-dir.mjs owns the checkout
// (the certification env override, the marker sync-paths wrote, then the daily
// sibling default), so a certification run can never build the client against
// a different checkout than the type and test layer. Both imports stay
// dynamic: a static template-literal module path breaks tsdown's config loader.
const { harnessDir } = await import('../../scripts/harness-dir.mjs')
const { clientBundle } = await import(pathToFileURL(resolve(harnessDir, 'packages/client/tsdown.client.ts')).href)

const bundle = clientBundle('@contexera/dsh-agent-team', [
  'lib/types/index.js',
])

// The Team Remote resolves through its own plugin rather than `resolve.alias`.
// tsdown reads the client's tsconfig `paths`, whose `/remote` entry points at
// the generated `.d.ts` for the type facets, and that mapping is what resolves
// this specifier; the generated runtime artifact is the one the package's own
// `./remote` export declares as `default`. The plugin therefore pins the
// specifier explicitly instead of leaving it to a mapping that targets types.
//
// The target is anchored to this config file, never to the process cwd. The
// earlier `resolve('../../../packages/...')` form was relative to whatever
// directory the config ran from — tsdown runs from `packages/client-agent-team`,
// one level deeper than the repository root the string was written for, so it
// silently pointed outside the repository.
const teamRemoteTarget = resolve(import.meta.dirname, '../agent-team/lib/typert.remote-client.js')
const teamRemote = {
  name: 'dsh-agent-team-remote-entrypoint',
  resolveId(source: string) {
    return source === '@contexera/dsh-agent-team/remote' ? teamRemoteTarget : null
  },
}

export default async (options: Parameters<typeof bundle>[0]) => {
  const configs = await bundle(options)
  return configs.map(entry => ({
    ...entry,
    plugins: [...(entry.plugins ?? []), teamRemote],
  }))
}
