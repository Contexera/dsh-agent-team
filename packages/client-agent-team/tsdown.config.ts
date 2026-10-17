import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
// One pointer for every consumer: scripts/harness-dir.mjs owns the checkout
// (the certification env override, the marker sync-paths wrote, then the daily
// sibling default), so a certification run can never build the client against
// a different checkout than the type and test layer. Both imports stay
// dynamic: a static template-literal module path breaks tsdown's config loader.
const { harnessDir } = await import('../../scripts/harness-dir.mjs')
const clientTsdownPath = resolve(harnessDir, 'packages/client/tsdown.client.ts')
const { clientBundle } = await import(pathToFileURL(clientTsdownPath).href)

// `clientBundle`'s first argument changed meaning in 0.2.1: it used to be the
// plugin id (this package's name, stamped into `__ModuleLoader__.load({id})`),
// and it is now the package DIRECTORY, whose `package.json` supplies that same
// id plus the dependency and `dsh.client` declarations the presets read. The
// declaration text is the contract, so probe it instead of pinning a harness
// version: the directory-taking form is the one whose body calls
// `readPackageManifest`.
const bundleTakesPackageDir = /function clientBundle\([\s\S]{0,400}?readPackageManifest\(/.test(
  readFileSync(clientTsdownPath, 'utf8'),
)

// The bundle's manifest lives at the repository root, not in this directory:
// one manifest declares the whole plugin, and this package is one of its three
// build targets. That is also why the argument cannot be `import.meta.dirname`
// — that directory has no manifest. Only the manifest is read from it; the
// entry and `outDir` the presets emit resolve against the process cwd, which
// tsdown sets to this package.
const bundle = clientBundle(
  bundleTakesPackageDir ? resolve(import.meta.dirname, '../..') : '@contexera/dsh-agent-team',
  ['lib/types/index.js'],
)

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
const TYPERT_PROTOCOL_SUBPATH = '@deepseek-ai/dsh-typert-protocol/remote-info'
const TYPERT_PROTOCOL_RUNTIME = 'packages/typert/protocol/lib/types/remote-info.js'
const teamRemoteTarget = resolve(import.meta.dirname, '../agent-team/lib/typert.remote-client.js')
const teamRemote = {
  name: 'dsh-agent-team-remote-entrypoint',
  resolveId(source: string) {
    if (source === '@contexera/dsh-agent-team/remote') return teamRemoteTarget
    // The generated Remote artifact imports `createTypertRemoteInfo` from this
    // protocol subpath, whose `exports` maps `types` before `default`. Rolldown
    // prefers the `.d.ts` of a co-located pair regardless of `conditionNames`
    // or alias, so the declaration file — a signature with no runtime body —
    // becomes the module and the import fails as a missing export. Pin the
    // runtime file directly: the sibling `.js` is the one the manifest's
    // `default` condition names, and it is what an install ships.
    if (source === TYPERT_PROTOCOL_SUBPATH) return resolve(harnessDir, TYPERT_PROTOCOL_RUNTIME)
    return null
  },
}

export default async (options: Parameters<typeof bundle>[0]) => {
  const configs = await bundle(options)
  return configs.map(entry => ({
    ...entry,
    plugins: [...(entry.plugins ?? []), teamRemote],
  }))
}
