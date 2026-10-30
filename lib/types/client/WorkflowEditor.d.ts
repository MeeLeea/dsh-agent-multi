import '@xyflow/react/dist/style.css';
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { WorkflowDefinition, WorkflowId } from '@deepseek-ai/dsh-experimental-agent-multi/types';
import type { AgentMultiInjected } from './WorkflowPage.tsx';
/** The definition the editor edits. */
export interface EditorTarget {
    readonly definition: WorkflowDefinition;
}
/** Inspector form props: framework copy plus injected actions. */
export type InspectorProps = PropsRuntime<'main'> & InjectFace<AgentMultiInjected> & PropsLocale<'agent-multi'>;
/**
 * Render the canvas editor with palette, inspector, and save/validate bar.
 * @param props - target definition, framework copy, injected actions, exit and run callbacks.
 * @returns the editor layout.
 */
export declare function WorkflowEditor(props: {
    readonly target: EditorTarget;
    readonly actions: InspectorProps;
    readonly onExit: () => void;
    readonly onRun: (workflowId: WorkflowId, name: string) => void;
}): import("react").JSX.Element;
//# sourceMappingURL=WorkflowEditor.d.ts.map