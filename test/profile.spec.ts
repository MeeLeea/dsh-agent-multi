/** The standalone bundle must carry one parseable, explicit multi-agent workflow layer. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

describe('Agent Multi profile bundle', () => {
  it('declares a parseable layer with the workflow service, client discovered via package.json', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      name?: string
      private?: boolean
      dsh?: { bundle?: { patch?: string }; client?: { platform?: string } }
    }
    // Standalone layout: one private package ships host + client; the host row
    // loads through cordis.patch.yml, the Web client is discovered from
    // dsh.client in package.json (no separate ui-* insert row).
    expect(manifest.name).toBe('dsh-agent-multi')
    expect(manifest.private).toBe(true)
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dsh?.client?.platform).toBe('web')

    const parsed = yaml.load(
      readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    )
    expect(Array.isArray(parsed)).toBe(true)
    const patches = parsed as {
      id?: string
      disabled?: boolean
      config?: Record<string, unknown>
      insert?: { id?: string; name?: string; config?: Record<string, unknown> }[]
    }[]
    const inserted = patches.flatMap(patch => patch.insert ?? [])
    expect(inserted.find(entry => entry.id === 'agent-multi')).toMatchObject({
      name: 'dsh-agent-multi',
      config: { maxActive: 8 },
    })
    // The client half must NOT have a separate insert row anymore.
    expect(inserted.some(entry => entry.id === 'ui-agent-multi')).toBe(false)
  })
})
