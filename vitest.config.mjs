import { defineConfig } from 'vitest/config'
import { transformWithEsbuild } from 'vite'

// Unit/integration specs live in test/*.spec.ts and import src/ directly
// (CSS module imports are stubbed). vitest 5 transforms via oxc, which keeps
// TC39 decorators verbatim — Node cannot parse them. This pre-pass lowers
// @Remote(...) in exactly the files that use it, via esbuild's standard
// stage-3 semantics (the same emit shape tsc produces for lib/).
const lowerDecorators = {
  name: 'agent-multi-lower-decorators',
  enforce: 'pre',
  async transform(code, id) {
    if (!/\.tsx?$/.test(id)) return null
    if (id.includes('node_modules')) return null
    if (!code.includes('@Remote')) return null
    return transformWithEsbuild(code, id, {
      loader: id.endsWith('.tsx') ? 'tsx' : 'ts',
      target: 'es2022',
      sourcemap: true,
    })
  },
}

export default defineConfig({
  plugins: [lowerDecorators],
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 30000,
  },
})
