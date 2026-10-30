/**
 * Mount the agent-multi Remote namespace and register the workflow panel,
 * its sidebar row, and the panel icon on the Web client.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis';
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol';
import { type AgentMultiKey } from './locales.ts';
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        /** Agent-multi workflow panel copy. */
        'agent-multi': AgentMultiKey;
    }
}
/** Services used by the agent-multi client UI. */
export declare const inject: string[];
/**
 * Mount the Remote contribution, then register the localized panel surfaces.
 * Disposal withdraws both the Remote namespace and the slot entries.
 * @param ctx - browser services.
 * @param contribution - generated agent-multi Remote contribution.
 * @returns combined disposer.
 */
export declare function mount(ctx: ClientContext, contribution: TypertRemoteContribution): Promise<() => Promise<void>>;
//# sourceMappingURL=mount.d.ts.map