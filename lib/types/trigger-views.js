/**
 * Trigger helpers shared by the controller: initial target computation over
 * the schedule package's recurrence arithmetic, and the client view mapping.
 * @module @deepseek-ai/dsh-experimental-agent-multi/src/trigger-views
 */
import { createCronScheduleRecord, createDailyScheduleRecord, createWeeklyScheduleRecord, ScheduleId, } from '@deepseek-ai/dsh-schedule';
/** Compute the first strictly future UTC target for a timing rule. */
export function initialTargetOf(timing, now) {
    // The created record's prompt and title are inert for trigger use; only its
    // validated timing fields and computed target are consumed.
    switch (timing.kind) {
        case 'cron':
            return createCronScheduleRecord(ScheduleId('trigger'), 'trigger', { expression: timing.expression, time_zone: timing.timeZone }, now, 'trigger').scheduledAt;
        case 'daily':
            return createDailyScheduleRecord(ScheduleId('trigger'), 'trigger', { time: timing.time, time_zone: timing.timeZone }, now, 'trigger').scheduledAt;
        case 'weekly':
            return createWeeklyScheduleRecord(ScheduleId('trigger'), 'trigger', { time: timing.time, time_zone: timing.timeZone, weekdays: [...timing.weekdays] }, now, 'trigger').scheduledAt;
    }
}
/** Project a stored trigger record into the client view. */
export function triggerEntryOf(record) {
    return {
        id: record.id,
        workflowId: record.workflowId,
        timing: record.timing,
        input: record.input,
        ...(record.tokenBudget !== undefined ? { tokenBudget: record.tokenBudget } : {}),
        enabled: record.enabled,
        scheduledAt: record.scheduledAt,
        ...(record.lastRunId !== undefined ? { lastRunId: record.lastRunId } : {}),
        updatedAt: record.updatedAt,
    };
}
//# sourceMappingURL=trigger-views.js.map