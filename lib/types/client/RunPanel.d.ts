import '@xyflow/react/dist/style.css';
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { WorkflowId } from '@deepseek-ai/dsh-experimental-agent-multi/types';
import type { AgentMultiInjected } from './WorkflowPage.tsx';
/** The run target: which stored workflow to execute. */
export interface RunTarget {
    readonly workflowId: WorkflowId;
    readonly name: string;
}
/**
 * Render the run launcher and live run observation for one workflow.
 * @param props - target workflow, framework copy, injected actions, and exit callback.
 * @returns the run panel.
 */
export declare function RunPanel(props: {
    readonly target: RunTarget;
    readonly actions: PropsRuntime<'main'> & AgentMultiInjected & PropsLocale<'agent-multi'>;
    readonly onExit: () => void;
}): import("react").JSX.Element;
//# sourceMappingURL=RunPanel.d.ts.map