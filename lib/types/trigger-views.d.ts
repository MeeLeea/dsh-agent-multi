import type { TriggerRecord, TriggerTiming } from './domain.ts';
import type { TriggerEntry } from './contract.ts';
/** Compute the first strictly future UTC target for a timing rule. */
export declare function initialTargetOf(timing: TriggerTiming, now: number): string;
/** Project a stored trigger record into the client view. */
export declare function triggerEntryOf(record: TriggerRecord): TriggerEntry;
//# sourceMappingURL=trigger-views.d.ts.map