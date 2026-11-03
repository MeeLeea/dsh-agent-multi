// Standalone build pipeline: tsc host face -> Typert generation -> tsc client
// face -> tsdown host bundle (lib/index.js) -> tsdown client bundle
// (lib/client.js). Everything runs in this one process: the sandboxed session
// shell denies child spawns (EPERM), so neither tsc nor tsdown CLI can be
// shelled out to here; both expose the library APIs used below.
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, extname, isAbsolute, resolve as resolvePath, sep } from 'node:path'
import ts from 'typescript'
import { transform } from 'lightningcss'
import { build } from 'tsdown'
import { generateTypert } from './generate-typert.mjs'

const ROOT = resolvePath(import.meta.dirname, '..')
const ID = 'dsh-agent-multi'

// ---------------------------------------------------------------------------
// tsc faces

/** Compile one tsconfig leaf with the TypeScript API; throw on any diagnostic. */
function compileTsconfig(configPath) {
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
  if (configFile.error !== undefined) throw new Error(ts.formatDiagnostics(configFile.error, formatHost))
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, dirname(configPath), undefined, configPath)
  if (parsed.errors.length > 0) throw new Error(ts.formatDiagnostics(parsed.errors, formatHost))
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options })
  const emitted = program.emit()
  const diagnostics = [...ts.getPreEmitDiagnostics(program), ...emitted.diagnostics]
  if (diagnostics.length > 0) throw new Error(ts.formatDiagnostics(diagnostics, formatHost))
  console.log(`tsc: ${basename(configPath)} -> ${parsed.options.outDir} (${parsed.fileNames.length} files)`)
}

const formatHost = {
  getCanonicalFileName: (fileName) => fileName,
  getCurrentDirectory: () => ROOT,
  getNewLine: () => '\n',
}

// ---------------------------------------------------------------------------
// Client bundle support, ported from deepseek-harness packages/client/tsdown.client.ts
// (the monorepo's shared client bundle recipe) with the repo-tree-only gates
// (input isolation, sourcemap URL rebasing) dropped.

// Specifiers the GUI module table answers at runtime; everything else inlines.
const CLIENT_EXTERNALS = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

// Contract layers and pure folds a client bundle may inline (no shared runtime
// identity): same list as the monorepo's INLINE_SAFE.
const INLINE_SAFE = /^(?:@deepseek-ai\/dsh-(?:file-reference|session|llm|tools|brand|deque|output-retention|typert-protocol|util-crypto|util-values|util-workspace-path)(?:\/|$)|@deepseek-ai\/dsh-token-meter\/client$|@deepseek-ai\/dsh-native-command\/types$|@deepseek-ai\/dsh-host-open-in-app\/shared$|@deepseek-ai\/dsh-plugin-manager\/registry$|@deepseek-ai\/dsh-agent-preset-registry\/display$|@deepseek-ai\/dsh-api-workspace-controller\/default-workspace$|@deepseek-ai\/dsh-spill-policy\/notice$)/

// Vendored framework libraries rescoped into @deepseek-ai (no shared identity).
const VENDORED_LIBRARY = /^@deepseek-ai\/(cosmokit|schemastery)(\/|$)/

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const GLOBAL_CSS_VIRTUAL_PREFIX = '\0dsh-global-css:'
const INLINE_CSS_VIRTUAL_PREFIX = '\0dsh-inline-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'
const INLINE_CSS_QUERY = '?inline'

const IMAGE_MEDIA_TYPES = new Map([['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.webp', 'image/webp']])

/** Path segment separating tsc output from the sources it was emitted from. */
const TYPES_MARKER = `${sep}lib${sep}types${sep}`

/** Trailing sourcemap reference tsc appends to every emitted module. */
const SOURCEMAP_COMMENT = /\n\/\/# sourceMappingURL=.*\s*$/

/** Emit one plugin-owned style injector and an optional CSS Modules export. */
function styleInjectionModule(fileId, css, classMap) {
  const source = [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(`${ID}/${basename(fileId)}`)};`,
    'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
    '  const tag = document.createElement(\'style\');',
    `  tag.dataset.plugin = ${JSON.stringify(ID)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
  ]
  source.push(classMap === undefined ? 'export {};' : `export default ${JSON.stringify(classMap)};`)
  return source.join('\n')
}

/** Resolve an emitted JS asset import against its source-tree counterpart. */
function sourceAssetPath(source, importer) {
  if (!source.startsWith('.') && !isAbsolute(source)) return createRequire(importer).resolve(source)
  const emitted = resolvePath(dirname(importer), source)
  if (existsSync(emitted)) return emitted
  const boundary = emitted.indexOf(TYPES_MARKER)
  if (boundary < 0) return emitted
  return resolvePath(emitted.slice(0, boundary), 'src', emitted.slice(boundary + TYPES_MARKER.length))
}

/** Chain tsc's emitted maps into the client bundle when lib/types carries them. */
function tscSourceMapPlugin() {
  return {
    name: 'dsh-tsc-sourcemap',
    async load(id) {
      if (!id.includes(TYPES_MARKER) || !id.endsWith('.js') || !existsSync(`${id}.map`)) return null
      const code = await readFile(id, 'utf8')
      const mapPath = `${id}.map`
      const map = JSON.parse(await readFile(mapPath, 'utf8'))
      if (!Array.isArray(map.sources) || map.sources.some((source) => typeof source !== 'string')) {
        throw new Error(`client sourcemap: ${mapPath} has invalid sources`)
      }
      if (
        !Array.isArray(map.sourcesContent)
        || map.sourcesContent.length !== map.sources.length
        || map.sourcesContent.some((source) => typeof source !== 'string')
      ) {
        const sourceRoot = typeof map.sourceRoot === 'string' ? map.sourceRoot : ''
        map.sourcesContent = await Promise.all(map.sources.map(async (source) =>
          await readFile(resolvePath(dirname(mapPath), sourceRoot, source), 'utf8')))
      }
      return { code: code.replace(SOURCEMAP_COMMENT, ''), map }
    },
  }
}

function clientPlugins() {
  return [{
    // Bundle purity gate: platform module-table rows stay external, inline-safe
    // wire layers inline, every other @deepseek-ai value import is a build error.
    name: 'dsh-client-bundle-purity',
    resolveId(source) {
      if (!source.startsWith('@deepseek-ai/')) return null
      if (CLIENT_EXTERNALS.has(source)) return null
      if (VENDORED_LIBRARY.test(source)) return null
      if (INLINE_SAFE.test(source)) return null
      throw new Error(
        `client bundle purity: "${source}" is not a platform client external, a vendored library, or an inline-safe wire layer — `
        + 'cross-plugin value imports are forbidden; collaborate through cordis services instead',
      )
    },
  }, tscSourceMapPlugin(), {
    name: 'dsh-css-modules-inline',
    resolveId(source, importer) {
      if (!source.endsWith('.module.css')) return null
      const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
      return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap = {}
      const exportEntries = Object.entries(cssExports ?? {})
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      for (const [local, exp] of exportEntries) classMap[local] = exp.name
      return styleInjectionModule(fileId, code.toString(), classMap)
    },
  }, {
    name: 'dsh-css-text-inline',
    resolveId(source, importer) {
      if (!source.endsWith(`.css${INLINE_CSS_QUERY}`)) return null
      const stylesheet = source.slice(0, -INLINE_CSS_QUERY.length)
      const abs = importer !== undefined ? sourceAssetPath(stylesheet, importer) : stylesheet
      return INLINE_CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId) {
      if (!virtualId.startsWith(INLINE_CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(INLINE_CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code } = transform({ filename: fileId, code: source, minify: true })
      return `export default ${JSON.stringify(code.toString())};`
    },
  }, {
    name: 'dsh-css-global-inline',
    resolveId(source, importer) {
      if (!source.endsWith('.css') || source.endsWith('.module.css')) return null
      const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
      return GLOBAL_CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId) {
      if (!virtualId.startsWith(GLOBAL_CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(GLOBAL_CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code } = transform({ filename: fileId, code: source, minify: true })
      return styleInjectionModule(fileId, code.toString())
    },
  }, {
    name: 'dsh-image-inline',
    resolveId(source, importer) {
      if (importer === undefined || !IMAGE_MEDIA_TYPES.has(extname(source))) return null
      return sourceAssetPath(source, importer)
    },
    async load(fileId) {
      const mediaType = IMAGE_MEDIA_TYPES.get(extname(fileId))
      if (mediaType === undefined) return null
      this.addWatchFile(fileId)
      const data = await readFile(fileId)
      return `export default ${JSON.stringify(`data:${mediaType};base64,${data.toString('base64')}`)};`
    },
  }]
}

// ---------------------------------------------------------------------------
// Pipeline

const mode = process.env.NODE_ENV ?? 'production'

await compileTsconfig(resolvePath(ROOT, 'tsconfig.host.json'))
await generateTypert(ROOT)
await compileTsconfig(resolvePath(ROOT, 'tsconfig.client.json'))

// Host bundle: ESM for the plugin Loader, every package.json dep/peer external
// (tsdown default), matching the hand-maintained lib/index.js this replaces.
await build({
  name: `${ID}/host`,
  cwd: ROOT,
  // Standalone package nested under the monorepo: never climb to an ancestor
  // tsdown.config.ts, it describes a pnpm workspace this package left behind.
  config: false,
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  sourcemap: false,
})
console.log('tsdown: lib/index.js (host)')

// Client bundle: CJS factory registered with window.__ModuleLoader__, platform
// externals only, CSS Modules/global styles/images inlined.
await build({
  name: `${ID}/client`,
  cwd: ROOT,
  config: false,
  entry: { client: 'lib/types/client/index.js' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: (specifier) => CLIENT_EXTERNALS.has(specifier),
    alwaysBundle: (specifier) => !CLIENT_EXTERNALS.has(specifier),
  },
  inputOptions: {
    resolve: {
      conditionNames: [mode === 'development' ? 'development' : 'production', 'browser', 'import', 'module', 'default'],
      alias: {
        // The generated remote contribution inlines into the client bundle.
        'dsh-agent-multi/remote': resolvePath(ROOT, 'lib/typert.remote-client.js'),
      },
    },
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(mode),
    'import.meta.env.MODE': JSON.stringify(mode),
    'import.meta.env': JSON.stringify({ MODE: mode }),
  },
  plugins: clientPlugins(),
  outputOptions: {
    entryFileNames: 'client.js',
    chunkFileNames: 'client.[name].js',
    sourcemapExcludeSources: false,
    banner: (chunk) =>
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, ${chunk.isEntry ? '' : `chunk: ${JSON.stringify(chunk.fileName)}, `}factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
console.log('tsdown: lib/client.js (client)')
console.log('build: done')
