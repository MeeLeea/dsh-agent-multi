/** Decorative occupant for the agent-multi sidebar entry. */
import { IconBranchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the branch glyph at the size the sidebar requests; the sidebar owns
 * its accessible navigation label.
 * @param props - the sidebar's icon share: the requested edge and whether the panel is selected.
 * @returns decorative branch icon.
 */
export function AgentMultiIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconBranchOutlineRegular size={size} />
}
