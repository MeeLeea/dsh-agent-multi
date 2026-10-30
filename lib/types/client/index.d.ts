import type { Context as ClientContext } from '@deepseek-ai/cordis';
export { inject } from './mount.ts';
/**
 * Mount the client UI.
 * @param ctx - browser services.
 * @returns disposer withdrawing the Remote namespace and slot entries.
 */
export declare function apply(ctx: ClientContext): Promise<() => Promise<void>>;
//# sourceMappingURL=index.d.ts.map