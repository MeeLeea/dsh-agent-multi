import { ScheduleId, resolveRecurringOccurrence, ScheduleInputError } from '@deepseek-ai/dsh-schedule';
/** Largest delay Node timers represent without clamping. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;
/** Map one trigger timing onto the schedule package's recurring record vocabulary. */
function recurringRecordOf(timing, scheduledAt) {
    const id = ScheduleId('trigger');
    switch (timing.kind) {
        case 'cron':
            return { kind: 'cron', id, title: 'trigger', prompt: 'trigger', expression: timing.expression, timeZone: timing.timeZone, scheduledAt };
        case 'daily':
            return { kind: 'daily', id, title: 'trigger', prompt: 'trigger', time: timing.time, timeZone: timing.timeZone, scheduledAt };
        case 'weekly':
            return { kind: 'weekly', id, title: 'trigger', prompt: 'trigger', time: timing.time, timeZone: timing.timeZone, weekdays: [...timing.weekdays], scheduledAt };
    }
}
/**
 * Owns the single host timer for workflow triggers.
 *
 * The runtime never throws to callers: drive failures are logged and the timer
 * is re-armed from the still-durable committed targets.
 */
export class TriggerRuntime {
    ctx;
    triggers;
    fire;
    commit;
    timer;
    running;
    stopping = false;
    requested = false;
    /**
     * @param ctx - Host context for logging and timer allocation.
     * @param triggers - Current durable trigger records.
     * @param fire - Start one run for a due trigger; resolves with the run id.
     * @param commit - Persist runtime-made trigger mutations.
     */
    constructor(ctx, triggers, fire, commit) {
        this.ctx = ctx;
        this.triggers = triggers;
        this.fire = fire;
        this.commit = commit;
    }
    /** Recompute the nearest obligation after startup or a durable change. */
    requestDrive() {
        if (this.stopping)
            return;
        this.requested = true;
        this.clearTimer();
        if (this.running !== undefined)
            return;
        const run = (async () => {
            while (this.requested && !this.stopping) {
                this.requested = false;
                await this.drive();
            }
        })();
        this.running = run;
        void run.catch((error) => {
            this.ctx.logger.warn(`agent-multi: trigger dispatch stopped: ${String(error)}`);
        }).finally(() => {
            this.running = undefined;
            if (this.requested && !this.stopping)
                this.requestDrive();
        });
    }
    /** Stop the timer and drain an accepted drive before disposal. */
    async dispose() {
        this.stopping = true;
        this.clearTimer();
        await this.running?.catch(() => undefined);
    }
    clearTimer() {
        if (this.timer !== undefined)
            clearTimeout(this.timer);
        this.timer = undefined;
    }
    async drive() {
        this.clearTimer();
        const scanNow = Date.now();
        const due = this.triggers().filter(record => record.enabled && Date.parse(record.scheduledAt) <= scanNow);
        for (const record of due) {
            if (this.stopping)
                return;
            try {
                const occurrence = this.resolveOccurrence(record, Date.now());
                const runId = await this.fire(record);
                const next = occurrence.nextScheduledAt ?? occurrence.occurrenceAt;
                await this.commit({
                    ...record,
                    scheduledAt: next,
                    ...(runId !== undefined ? { lastRunId: runId } : {}),
                });
            }
            catch (error) {
                // A refused fire keeps the committed target; the timer retries on the next drive.
                this.ctx.logger.warn(`agent-multi: trigger "${record.id}" failed to fire: ${String(error)}`);
            }
        }
        if (this.stopping)
            return;
        const next = this.triggers().filter(record => record.enabled)
            .reduce((at, record) => {
            const target = Date.parse(record.scheduledAt);
            return at === undefined ? target : Math.min(at, target);
        }, undefined);
        if (next !== undefined) {
            this.timer = setTimeout(() => { this.timer = undefined; this.requestDrive(); }, Math.max(0, Math.min(next - Date.now(), MAX_TIMER_DELAY_MS)));
            this.timer.unref();
        }
    }
    resolveOccurrence(record, now) {
        try {
            return resolveRecurringOccurrence(recurringRecordOf(record.timing, record.scheduledAt), now);
        }
        catch (error) {
            if (error instanceof ScheduleInputError || error instanceof Error) {
                throw new Error(`trigger timing is unsatisfiable: ${error.message}`);
            }
            throw error;
        }
    }
}
//# sourceMappingURL=trigger-runtime.js.map