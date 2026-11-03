// Generate lib/typert.host.{js,d.ts} and lib/typert.remote-client.{js,d.ts,map}
// from src/host with @deepseek-ai/dsh-typert-generator.
//
// The generator is workspace-shaped: it discovers packages from a root
// aggregate tsconfig (tsconfig.host.json) whose project references must live
// under <root>/packages, it realPaths each referenced package (a junction back
// into this directory fails the containment check), and it treats every type
// declaration a Remote surface touches as in-face only when the declaring file
// sits inside a workspace registration of the same face. npm-installed
// @deepseek-ai/dsh-* packages are never registrations, so this script stages a
// throwaway workspace under .typert-work/: a real copy of src/host plus a copy
// of every @deepseek-ai/dsh-* devDependency, each with src/ stubs that mirror
// its export map, generates there, then copies the emitted artifacts back.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { WorkspaceTypertGenerator, writePackageArtifacts } from '@deepseek-ai/dsh-typert-generator'

const TYPERT_FILES = [
  'typert.host.js',
  'typert.host.d.ts',
  'typert.remote-client.js',
  'typert.remote-client.d.ts',
  'typert.remote-client.d.ts.map',
]

// Map one export target onto the src/ stub path the analyzer derives through
// sourcePathForExport (lib/types/x.d.ts -> src/x.ts, lib/x.js -> src/x.ts),
// plus the stub's re-export specifier back at the real file. Returns null for
// targets the analyzer ignores (json, wildcards are filtered by the caller).
function stubForExportTarget(target) {
  if (typeof target !== 'string' || !target.startsWith('./lib/')) return null
  const rel = target.slice('./lib/'.length)
  let srcRel
  if (rel.startsWith('types/') && rel.endsWith('.d.ts')) srcRel = `${rel.slice('types/'.length, -'.d.ts'.length)}.ts`
  else if (rel.endsWith('.d.ts')) srcRel = `${rel.slice(0, -'.d.ts'.length)}.ts`
  else if (rel.endsWith('.js')) srcRel = `${rel.slice(0, -'.js'.length)}.ts`
  else return null
  const depth = srcRel.split('/').length - 1
  const jsRel = rel.endsWith('.d.ts') ? `${rel.slice(0, -'.d.ts'.length)}.js` : rel
  return { srcRel, specifier: `${'../'.repeat(depth + 1)}lib/${jsRel}` }
}

// Stage every @deepseek-ai/dsh-* package present in node_modules (the full
// transitive closure, not just direct devDeps) as a workspace package so the
// analyzer's in-face checks (isTypeMetaSymbol, merged-interface declarations,
// packageExportName) see registration-owned files. Each staged package keeps
// its npm manifest and gains src/ re-export stubs, one per export subpath,
// because collectExports requires every export to map onto an existing source
// and packageExportName looks that source up in the face program.
function stageDependencyPackages(root, workRoot) {
  const require = createRequire(join(root, 'package.json'))
  const scopeDir = join(root, 'node_modules', '@deepseek-ai')
  const names = readdirSync(scopeDir)
    .filter((entry) => entry.startsWith('dsh-') && entry !== 'dsh-typert-generator')
    .map((entry) => `@deepseek-ai/${entry}`)
    .sort()
  const staged = []
  for (const name of names) {
    const short = name.replace('@deepseek-ai/', '')
    const source = resolve(require.resolve(`${name}/package.json`), '..')
    const dest = join(workRoot, 'packages', short)
    cpSync(source, dest, { recursive: true })
    const pkgManifest = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8'))
    const paths = {}
    for (const [subpath, entry] of Object.entries(pkgManifest.exports ?? {})) {
      if (subpath === './package.json' || subpath.includes('*')) continue
      const target = typeof entry === 'string' ? entry : entry?.types ?? entry?.default
      const stub = target === null || target === undefined ? null : stubForExportTarget(target)
      if (stub === null) continue
      const stubFile = join(dest, 'src', stub.srcRel)
      mkdirSync(dirname(stubFile), { recursive: true })
      writeFileSync(stubFile, `export * from '${stub.specifier}'\n`)
      if (typeof entry === 'object' && typeof entry.types === 'string' && entry.types.endsWith('.d.ts')) {
        paths[subpath === '.' ? name : `${name}${subpath.slice(1)}`] = entry.types
      }
    }
    writeFileSync(join(dest, 'tsconfig.json'), `${JSON.stringify({
      extends: '../../../tsconfig.base.json',
      compilerOptions: { composite: true, noEmit: true },
      include: ['lib/**/*.d.ts', 'src/**/*.ts'],
    }, null, 2)}\n`)
    staged.push({ name, short, paths })
  }
  return staged
}

/** Run one generation pass and refresh this package's lib/typert.* files. */
export async function generateTypert(root) {
  const workRoot = join(root, '.typert-work')
  const packageDir = join(workRoot, 'packages', 'dsh-agent-multi')
  rmSync(workRoot, { recursive: true, force: true })
  mkdirSync(join(packageDir, 'src'), { recursive: true })

  // Host sources only: the staged package registers a single Host face (its
  // manifest omits dsh.client and the ./client export, so the analyzer never
  // treats it as dual-face). The index shim makes the '.'/'./types' exports
  // resolve back to source.
  cpSync(join(root, 'src', 'host'), join(packageDir, 'src', 'host'), { recursive: true })
  writeFileSync(join(packageDir, 'src', 'index.ts'), "export * from './host/index.ts'\n")
  // The analyzer maps export targets onto source files and writePackageArtifacts
  // needs lib/ to exist; carry over the freshly compiled host face.
  if (existsSync(join(root, 'lib', 'types'))) {
    cpSync(join(root, 'lib', 'types'), join(packageDir, 'lib', 'types'), { recursive: true })
  } else {
    mkdirSync(join(packageDir, 'lib'), { recursive: true })
  }

  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const stagedManifest = {
    name: manifest.name,
    version: manifest.version,
    type: 'module',
    exports: {
      // '.' must map to the controller source: the analyzer walks entry
      // sources for its surface scan and does not follow `export * from`,
      // so a shim entry would hide every Remote method.
      '.': { types: './lib/types/host/index.d.ts', default: './lib/index.js' },
      './types': { types: './lib/types/index.d.ts', default: './lib/types/index.js' },
      './typert': { types: './lib/typert.host.d.ts', default: './lib/typert.host.js' },
      './remote': { types: './lib/typert.remote-client.d.ts', default: './lib/typert.remote-client.js' },
      './package.json': './package.json',
    },
    files: ['lib/types', ...TYPERT_FILES.map((name) => `lib/${name}`)],
  }
  writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify(stagedManifest, null, 2)}\n`)

  const staged = stageDependencyPackages(root, workRoot)
  // Bare-specifier mappings must resolve into the staged copies: only then do
  // referenced declarations live under a registration root. The FaceAnalyzer
  // program takes its compilerOptions from the AGGREGATE config, so the paths
  // live there; the package config only widens rootNames to the staged stubs
  // (packageExportName looks entry sources up in the face program).
  const aggregatePaths = {}
  const packagePaths = {}
  for (const { name, short, paths } of staged) {
    for (const [specifier, target] of Object.entries(paths)) {
      aggregatePaths[specifier] = [`./packages/${short}/${target.slice('./'.length)}`]
      packagePaths[specifier] = [`../${short}/${target.slice('./'.length)}`]
    }
  }
  writeFileSync(join(packageDir, 'tsconfig.json'), `${JSON.stringify({
    extends: '../../../tsconfig.base.json',
    compilerOptions: {
      composite: true,
      rootDir: 'src',
      outDir: 'lib/types',
      paths: packagePaths,
    },
    include: ['src/**/*.ts', ...staged.map(({ short }) => `../${short}/src/**/*.ts`)],
  }, null, 2)}\n`)
  writeFileSync(join(workRoot, 'tsconfig.host.json'), `${JSON.stringify({
    extends: '../tsconfig.base.json',
    compilerOptions: { composite: false, paths: aggregatePaths },
    files: [],
    references: [
      { path: './packages/dsh-agent-multi' },
      ...staged.map(({ short }) => ({ path: `./packages/${short}` })),
    ],
  }, null, 2)}\n`)

  const generator = new WorkspaceTypertGenerator(workRoot)
  const artifacts = generator.generate(['dsh-agent-multi'], ['host'])
  if (artifacts.length === 0) throw new Error('typert: no host artifact emitted for dsh-agent-multi')
  writePackageArtifacts(packageDir, artifacts)

  for (const name of TYPERT_FILES) {
    const from = join(packageDir, 'lib', name)
    if (existsSync(from)) copyFileSync(from, join(root, 'lib', name))
  }
  console.log(`typert: emitted ${artifacts.length} artifact(s) -> lib/`)
  rmSync(workRoot, { recursive: true, force: true })
}

if (import.meta.url === `file:///${process.argv[1]?.replaceAll('\\', '/')}`) {
  await generateTypert(resolve(import.meta.dirname, '..'))
}
