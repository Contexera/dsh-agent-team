import { existsSync, realpathSync } from 'node:fs'
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { continuityDir } from './continuity-dir.mjs'
import { harnessDir } from './harness-dir.mjs'

const projectRoot = resolve(import.meta.dirname, '..')
const harnessRoot = harnessDir
const { WorkspaceAnalyzer } = await import(pathToFileURL(join(harnessRoot, 'packages/typert/generator/src/analyzer.ts')).href)
const { FaceModelEmitter } = await import(pathToFileURL(join(harnessRoot, 'packages/typert/generator/src/emitter.ts')).href)
const { default: ts } = await import(pathToFileURL(join(harnessRoot, 'node_modules/typescript/lib/typescript.js')).href)
const packageRoot = resolve(projectRoot, 'packages/agent-team')
const tempPackage = await mkdtemp(join(harnessRoot, 'packages/external-agent-team-'))
const aggregate = join(tempPackage, 'tsconfig.host.json')

try {
  await cp(join(packageRoot, 'src'), join(tempPackage, 'src'), { recursive: true })
  const manifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
  await writeFile(join(tempPackage, 'package.json'), JSON.stringify({
    name: manifest.name,
    type: manifest.type,
    exports: {
      '.': { types: './lib/types/index.d.ts', default: './lib/index.js' },
      './types': { types: './lib/types/types.d.ts', default: './lib/types/types.js' },
    },
  }))
  await mkdir(join(tempPackage, 'node_modules'), { recursive: true })
  // Resolve zod once through the real node_modules chain and LINK it into the
  // temp analysis package: a symlink on POSIX, a directory junction on Windows,
  // where a real symlink needs a privilege the runner may not have
  // (link-harness-packages.mjs uses junctions for the same reason). Either form
  // leaves zod's real path in this repository's install, OUTSIDE the analysed
  // package, which is what the analyzer's reachable-files walk assumes.
  //
  // A copy is not equivalent, however tempting: zod's declarations then sit
  // under the analysed root, and resolving `index.d.cts`'s own
  // `./v4/classic/external.cjs` inside that copy reaches a declaration file the
  // program never loaded, which the walk queues as undefined and dies on —
  // a TypeError instead of a diagnosable error.
  //
  // The chain is this repository's own root install: the analysis package sits
  // inside the harness checkout, where nothing provides zod, and `zod` is a
  // dependency of the single root manifest. A per-package
  // `packages/agent-team/node_modules` is NOT a resolution path any more — the
  // workspace has one root package, so a clean install never creates it and the
  // stale directory on a long-lived checkout must not be the only reason the
  // build works.
  // LINK one root-install dependency into the temp analysis package: a
  // symlink on POSIX, a directory junction on Windows, where a real symlink
  // needs a privilege the runner may not have (link-harness-packages.mjs uses
  // junctions for the same reason). Either form leaves the package's real path
  // in this repository's install, OUTSIDE the analysed package, which is what
  // the analyzer's reachable-files walk assumes.
  const linkRootDependency = async (name) => {
    const source = join(projectRoot, 'node_modules', name)
    if (!existsSync(source)) {
      throw new Error(
        `Typert analysis resolves the bundle's '${name}' dependency at '${source}', which is not installed.`
        + ' Run `corepack pnpm install` at the repository root (never npm install: it breaks the workspace links).',
      )
    }
    const target = join(tempPackage, 'node_modules', name)
    if (process.platform === 'win32') {
      await symlink(realpathSync(source), target, 'junction')
    } else {
      await symlink(source, target, 'file')
    }
  }
  await linkRootDependency('zod')
  // The Host face's second root-install dependency: the legacy settings
  // document parse rides the same chain, for the same reasons as zod above.
  await linkRootDependency('yaml')
  // The sibling context-continuity engine is the second external package the
  // Host face imports. The temp package sits inside the harness checkout, so
  // only its own manifest and built declarations travel: copying the checkout
  // would drag its node_modules along, and a symlink is the Windows-hostile
  // form the zod comment above already rules out.
  const engineTarget = join(tempPackage, 'node_modules', '@wowyuarm', 'dsh-context-continuity')
  await mkdir(engineTarget, { recursive: true })
  await cp(join(continuityDir, 'package.json'), join(engineTarget, 'package.json'))
  await cp(join(continuityDir, 'lib'), join(engineTarget, 'lib'), { recursive: true })
  // The optional jev peer, for the same reason and in the same form: the Host
  // face names `ctx.jev` as the long-gap gate's judge, and that service's own
  // type augmentation is what types the read. It is a devDependency of this
  // repository, so a clean install always has it; the published manifest keeps
  // it an optional peer, and the empty type-only import that needs it is elided
  // from the emitted declarations, so a consumer without jev is unaffected.
  const jevSource = join(projectRoot, 'node_modules', '@wowyuarm', 'dsh-jev')
  if (!existsSync(jevSource)) {
    throw new Error(
      `Typert analysis resolves the bundle's optional '@wowyuarm/dsh-jev' peer at '${jevSource}', which is not installed.`
      + ' Run `corepack pnpm install` at the repository root (never npm install: it breaks the workspace links).',
    )
  }
  const jevTarget = join(tempPackage, 'node_modules', '@wowyuarm', 'dsh-jev')
  await mkdir(jevTarget, { recursive: true })
  await cp(join(jevSource, 'package.json'), join(jevTarget, 'package.json'))
  await cp(join(jevSource, 'lib'), join(jevTarget, 'lib'), { recursive: true })
  await writeFile(join(tempPackage, 'tsconfig.json'), JSON.stringify({
    extends: '../../tsconfig.base.json',
    include: ['src'],
    compilerOptions: {
      noEmit: true,
      rootDir: 'src',
      noUnusedLocals: false,
      noUnusedParameters: false,
    },
    references: [{ path: '../../packages/typert/protocol' }],
  }))
  const harnessHost = ts.readConfigFile(join(harnessRoot, 'tsconfig.host.json'), ts.sys.readFile)
  if (harnessHost.error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(harnessHost.error.messageText, '\n'))
  const references = (harnessHost.config.references ?? []).map(reference => ({
    path: resolve(harnessRoot, reference.path),
  }))
  references.push({ path: tempPackage })
  await writeFile(aggregate, JSON.stringify({
    extends: join(harnessRoot, 'tsconfig.base.json'),
    files: [],
    compilerOptions: { noEmit: true },
    references,
  }))

  const workspace = new WorkspaceAnalyzer({
    root: harnessRoot,
    hostConfig: aggregate,
    clientConfig: join(tempPackage, 'tsconfig.client-missing.json'),
    faces: ['host'],
    packages: ['@wowyuarm/dsh-agent-team'],
  }).analyze()
  const face = workspace.faces.find(candidate => candidate.face === 'host')
  if (face === undefined) throw new Error('Typert did not analyze the Agent Team Host face')
  const artifact = new FaceModelEmitter(face).emit('@wowyuarm/dsh-agent-team')
  if (artifact.remote === undefined) throw new Error('Typert did not emit the Agent Team Remote contribution')

  const generatedRoot = `packages/${tempPackage.slice(tempPackage.lastIndexOf('/') + 1)}`
  const stable = value => value.replaceAll(generatedRoot, 'packages/agent-team')
  const output = join(packageRoot, 'lib')
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'typert.host.js'), stable(artifact.js))
  await writeFile(join(output, 'typert.host.d.ts'), artifact.dts)
  await writeFile(join(output, 'typert.remote-client.js'), stable(artifact.remote.js))
  await writeFile(join(output, 'typert.remote-client.d.ts'), artifact.remote.dts)
  await writeFile(join(output, 'typert.remote-client.d.ts.map'), artifact.remote.dtsMap)
} finally {
  await rm(tempPackage, { recursive: true, force: true })
}
