/**
 * Web client entry of the agent-multi workflow UI: mounts the generated
 * agent-multi Remote contribution and registers the panel surfaces.
 */
import agentMultiRemote from '@deepseek-ai/dsh-experimental-agent-multi/remote';
import { mount } from "./mount.js";
export { inject } from "./mount.js";
/**
 * Mount the client UI.
 * @param ctx - browser services.
 * @returns disposer withdrawing the Remote namespace and slot entries.
 */
export async function apply(ctx) {
    return await mount(ctx, agentMultiRemote);
}
//# sourceMappingURL=index.js.map