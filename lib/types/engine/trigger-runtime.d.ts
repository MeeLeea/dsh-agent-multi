/**
 * Host timer over stored workflow triggers (G11).
 *
 * Owns at most one `setTimeout` across recomputations. Due computation and
 * wall-clock arithmetic are delegated to the DSH schedule package's recurring
 * occurrence resolvers; a fire starts one run through the controller's normal
 * `startRun` path and re-arms the trigger's committed target.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { TriggerRecord } from '../domain.ts';
/** Read the stored trigger records; ordering is irrelevant to the drive. */
export type TriggerSource = () => readonly TriggerRecord[];
/** One fire: start a run for the trigger and return the run id when started. */
export type TriggerFire = (trigger: TriggerRecord) => Promise<string | undefined>;
/** Persist a trigger mutation made by the runtime (re-arm, lastRunId). */
export type TriggerCommit = (trigger: TriggerRecord) => Promise<void>;
/**
 * Owns the single host timer for workflow triggers.
 *
 * The runtime never throws to callers: drive failures are logged and the timer
 * is re-armed from the still-durable committed targets.
 */
export declare class TriggerRuntime {
    private readonly ctx;
    private readonly triggers;
    private readonly fire;
    private readonly commit;
    private timer;
    private running;
    private stopping;
    private requested;
    /**
     * @param ctx - Host context for logging and timer allocation.
     * @param triggers - Current durable trigger records.
     * @param fire - Start one run for a due trigger; resolves with the run id.
     * @param commit - Persist runtime-made trigger mutations.
     */
    constructor(ctx: Context, triggers: TriggerSource, fire: TriggerFire, commit: TriggerCommit);
    /** Recompute the nearest obligation after startup or a durable change. */
    requestDrive(): void;
    /** Stop the timer and drain an accepted drive before disposal. */
    dispose(): Promise<void>;
    private clearTimer;
    private drive;
    private resolveOccurrence;
}
//# sourceMappingURL=trigger-runtime.d.ts.map