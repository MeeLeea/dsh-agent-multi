import { jsx as _jsx } from "react/jsx-runtime";
/** Decorative occupant for the agent-multi sidebar entry. */
import { IconBranchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
/**
 * Render the branch glyph at the size the sidebar requests; the sidebar owns
 * its accessible navigation label.
 * @param props - the sidebar's icon share: the requested edge and whether the panel is selected.
 * @returns decorative branch icon.
 */
export function AgentMultiIcon({ size }) {
    return _jsx(IconBranchOutlineRegular, { size: size });
}
//# sourceMappingURL=AgentMultiIcon.js.map