/**
 * Web client entry of the agent-multi workflow UI: mounts the generated
 * agent-multi Remote contribution and registers the panel surfaces.
 */
import agentMultiRemote from '@deepseek-ai/dsh-experimental-agent-multi/remote'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { mount } from './mount.ts'

export { inject } from './mount.ts'

/**
 * Mount the client UI.
 * @param ctx - browser services.
 * @returns disposer withdrawing the Remote namespace and slot entries.
 */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  return await mount(ctx, agentMultiRemote)
}
