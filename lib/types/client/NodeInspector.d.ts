import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { AgentNodeSpec, AgentLibrarySpec, DryRunNodeResult, NodeSpec, ModelCatalog } from '@deepseek-ai/dsh-experimental-agent-multi/types';
/** Remote action surface the inspector needs for the dry-run probe. */
export interface DryRunActions {
    readonly dryRunNode: (request: {
        node: AgentNodeSpec;
        input: string;
    }) => Promise<{
        ok: boolean;
        value?: DryRunNodeResult;
        message?: string;
    }>;
}
/** Remote action surface the inspector needs for library saves. */
export interface LibraryActions {
    readonly createLibraryAgent: (request: {
        name: string;
        spec: AgentLibrarySpec;
    }) => Promise<{
        ok: boolean;
    }>;
}
/** Remote action surface the inspector needs for the host model catalog. */
export interface CatalogActions {
    readonly load: () => Promise<{
        ok: boolean;
        value?: ModelCatalog;
        message?: string;
    }>;
}
/** Inspector props: the node spec, its replacement callback, and copy. */
export interface NodeInspectorProps {
    readonly spec: NodeSpec;
    readonly onChange: (next: NodeSpec) => void;
    readonly onDelete: () => void;
    readonly dryRun?: DryRunActions;
    readonly library?: LibraryActions;
    readonly labels: PropsRuntime<'main'> & PropsLocale<'agent-multi'>;
    readonly catalog?: CatalogActions;
}
/**
 * Render the configuration form for one node.
 * @param props - node spec, change and delete callbacks, localized copy.
 * @returns the inspector form.
 */
export declare function NodeInspector(props: NodeInspectorProps): import("react").JSX.Element;
//# sourceMappingURL=NodeInspector.d.ts.map