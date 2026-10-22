import { existsSync, realpathSync } from 'node:fs'
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
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
  // LINK root-install dependencies into the temp analysis package (symlink on POSIX, directory junction on
  // Windows, where a real symlink needs a privilege the runner may not have; link-harness-packages.mjs does
  // the same). The real path must stay in this repository's install, OUTSIDE the analysed package, as the
  // analyzer's reachable-files walk assumes: a copy puts zod's declarations under the analysed root, where
  // resolving `index.d.cts`'s `./v4/classic/external.cjs` reaches a declaration file the program never
  // loaded and the walk dies with a TypeError.
  // The source is the root install because the analysis package sits inside the harness checkout, where
  // nothing provides zod; there is no per-package `packages/agent-team/node_modules` resolution path.
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
  // The legacy settings document parse resolves `yaml` through the same chain as zod.
  await linkRootDependency('yaml')
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
    packages: ['@contexera/dsh-agent-team'],
  }).analyze()
  const face = workspace.faces.find(candidate => candidate.face === 'host')
  if (face === undefined) throw new Error('Typert did not analyze the Agent Team Host face')
  const artifact = new FaceModelEmitter(face).emit('@contexera/dsh-agent-team')
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
