/**
 * Structural zod schemas for workflow drafts and stored records, plus the
 * storage-domain specification and the single source of truth for the value
 * types (re-exported from {@link ./types}). Semantic graph rules live in
 * validation.ts; this module enforces per-field shape and bounds so a
 * malformed record can never enter (or brick) the domain.
 * @module @deepseek-ai/dsh-experimental-agent-multi/src/domain
 */
import type { Branded } from '@deepseek-ai/dsh-brand';
import { z } from 'zod';
/** Workflow identity across storage and runs; assigned by the host. */
export type WorkflowId = Branded<'WorkflowId'>;
/** Node kinds v1: seven canvas kinds. `note` never executes. */
export type NodeKind = 'input' | 'agent' | 'router' | 'join' | 'loop' | 'output' | 'note';
/** Intermediate-layer representation a downstream node receives (R4). */
export type EdgeFormat = 'json' | 'md' | 'text';
declare const nodeSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, z.core.$strict>>;
    kind: z.ZodLiteral<"input">;
}, z.core.$strict>, z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, z.core.$strict>>;
    kind: z.ZodLiteral<"agent">;
    systemPrompt: z.ZodString;
    provider: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    toolFilter: z.ZodOptional<z.ZodObject<{
        allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
        deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
    permissionPreset: z.ZodOptional<z.ZodString>;
    contextBudgetTokens: z.ZodOptional<z.ZodNumber>;
    retry: z.ZodObject<{
        maxAttempts: z.ZodNumber;
        backoffMs: z.ZodNumber;
        fallbackModel: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    timeoutMs: z.ZodOptional<z.ZodNumber>;
    hitlEnabled: z.ZodBoolean;
}, z.core.$strict>, z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, z.core.$strict>>;
    kind: z.ZodLiteral<"router">;
    cases: z.ZodArray<z.ZodString>;
}, z.core.$strict>, z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, z.core.$strict>>;
    kind: z.ZodLiteral<"join">;
    strategy: z.ZodEnum<{
        any: "any";
        all: "all";
        quorum: "quorum";
    }>;
    quorum: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>, z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, z.core.$strict>>;
    kind: z.ZodLiteral<"loop">;
    mode: z.ZodEnum<{
        items: "items";
        count: "count";
        while: "while";
    }>;
    itemsExpr: z.ZodOptional<z.ZodString>;
    count: z.ZodOptional<z.ZodNumber>;
    condition: z.ZodOptional<z.ZodString>;
    maxIters: z.ZodNumber;
    collect: z.ZodBoolean;
}, z.core.$strict>, z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, z.core.$strict>>;
    kind: z.ZodLiteral<"output">;
}, z.core.$strict>, z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, z.core.$strict>>;
    kind: z.ZodLiteral<"note">;
    text: z.ZodString;
}, z.core.$strict>], "kind">;
declare const edgeSchema: z.ZodObject<{
    id: z.ZodString;
    from: z.ZodString;
    fromHandle: z.ZodOptional<z.ZodString>;
    to: z.ZodString;
    toHandle: z.ZodOptional<z.ZodLiteral<"back">>;
    format: z.ZodEnum<{
        text: "text";
        json: "json";
        md: "md";
    }>;
    template: z.ZodOptional<z.ZodString>;
    inContext: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strict>;
/** Editor payload: definition content without server-assigned identity. */
export declare const workflowDraftSchema: z.ZodObject<{
    name: z.ZodString;
    nodes: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        position: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, z.core.$strict>>;
        kind: z.ZodLiteral<"input">;
    }, z.core.$strict>, z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        position: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, z.core.$strict>>;
        kind: z.ZodLiteral<"agent">;
        systemPrompt: z.ZodString;
        provider: z.ZodOptional<z.ZodString>;
        model: z.ZodOptional<z.ZodString>;
        toolFilter: z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        permissionPreset: z.ZodOptional<z.ZodString>;
        contextBudgetTokens: z.ZodOptional<z.ZodNumber>;
        retry: z.ZodObject<{
            maxAttempts: z.ZodNumber;
            backoffMs: z.ZodNumber;
            fallbackModel: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>;
        timeoutMs: z.ZodOptional<z.ZodNumber>;
        hitlEnabled: z.ZodBoolean;
    }, z.core.$strict>, z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        position: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, z.core.$strict>>;
        kind: z.ZodLiteral<"router">;
        cases: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        position: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, z.core.$strict>>;
        kind: z.ZodLiteral<"join">;
        strategy: z.ZodEnum<{
            any: "any";
            all: "all";
            quorum: "quorum";
        }>;
        quorum: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>, z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        position: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, z.core.$strict>>;
        kind: z.ZodLiteral<"loop">;
        mode: z.ZodEnum<{
            items: "items";
            count: "count";
            while: "while";
        }>;
        itemsExpr: z.ZodOptional<z.ZodString>;
        count: z.ZodOptional<z.ZodNumber>;
        condition: z.ZodOptional<z.ZodString>;
        maxIters: z.ZodNumber;
        collect: z.ZodBoolean;
    }, z.core.$strict>, z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        position: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, z.core.$strict>>;
        kind: z.ZodLiteral<"output">;
    }, z.core.$strict>, z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        position: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, z.core.$strict>>;
        kind: z.ZodLiteral<"note">;
        text: z.ZodString;
    }, z.core.$strict>], "kind">>;
    edges: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        from: z.ZodString;
        fromHandle: z.ZodOptional<z.ZodString>;
        to: z.ZodString;
        toHandle: z.ZodOptional<z.ZodLiteral<"back">>;
        format: z.ZodEnum<{
            text: "text";
            json: "json";
            md: "md";
        }>;
        template: z.ZodOptional<z.ZodString>;
        inContext: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strict>>;
}, z.core.$strict>;
/** Stored workflow definition; the host assigns id and revision. */
export declare const workflowDefinitionSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    id: z.ZodPipe<z.ZodString, z.ZodTransform<WorkflowId, string>>;
    name: z.ZodString;
    revision: z.ZodNumber;
    nodes: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        position: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, z.core.$strict>>;
        kind: z.ZodLiteral<"input">;
    }, z.core.$strict>, z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        position: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, z.core.$strict>>;
        kind: z.ZodLiteral<"agent">;
        systemPrompt: z.ZodString;
        provider: z.ZodOptional<z.ZodString>;
        model: z.ZodOptional<z.ZodString>;
        toolFilter: z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        permissionPreset: z.ZodOptional<z.ZodString>;
        contextBudgetTokens: z.ZodOptional<z.ZodNumber>;
        retry: z.ZodObject<{
            maxAttempts: z.ZodNumber;
            backoffMs: z.ZodNumber;
            fallbackModel: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>;
        timeoutMs: z.ZodOptional<z.ZodNumber>;
        hitlEnabled: z.ZodBoolean;
    }, z.core.$strict>, z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        position: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, z.core.$strict>>;
        kind: z.ZodLiteral<"router">;
        cases: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        position: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, z.core.$strict>>;
        kind: z.ZodLiteral<"join">;
        strategy: z.ZodEnum<{
            any: "any";
            all: "all";
            quorum: "quorum";
        }>;
        quorum: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>, z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        position: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, z.core.$strict>>;
        kind: z.ZodLiteral<"loop">;
        mode: z.ZodEnum<{
            items: "items";
            count: "count";
            while: "while";
        }>;
        itemsExpr: z.ZodOptional<z.ZodString>;
        count: z.ZodOptional<z.ZodNumber>;
        condition: z.ZodOptional<z.ZodString>;
        maxIters: z.ZodNumber;
        collect: z.ZodBoolean;
    }, z.core.$strict>, z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        position: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, z.core.$strict>>;
        kind: z.ZodLiteral<"output">;
    }, z.core.$strict>, z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        position: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, z.core.$strict>>;
        kind: z.ZodLiteral<"note">;
        text: z.ZodString;
    }, z.core.$strict>], "kind">>;
    edges: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        from: z.ZodString;
        fromHandle: z.ZodOptional<z.ZodString>;
        to: z.ZodString;
        toHandle: z.ZodOptional<z.ZodLiteral<"back">>;
        format: z.ZodEnum<{
            text: "text";
            json: "json";
            md: "md";
        }>;
        template: z.ZodOptional<z.ZodString>;
        inContext: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strict>>;
}, z.core.$strict>;
/** One durable workflow record; the table key is the definition id. */
export declare const workflowRecordSchema: z.ZodObject<{
    definition: z.ZodObject<{
        version: z.ZodLiteral<1>;
        id: z.ZodPipe<z.ZodString, z.ZodTransform<WorkflowId, string>>;
        name: z.ZodString;
        revision: z.ZodNumber;
        nodes: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
            id: z.ZodString;
            name: z.ZodString;
            position: z.ZodOptional<z.ZodObject<{
                x: z.ZodNumber;
                y: z.ZodNumber;
            }, z.core.$strict>>;
            kind: z.ZodLiteral<"input">;
        }, z.core.$strict>, z.ZodObject<{
            id: z.ZodString;
            name: z.ZodString;
            position: z.ZodOptional<z.ZodObject<{
                x: z.ZodNumber;
                y: z.ZodNumber;
            }, z.core.$strict>>;
            kind: z.ZodLiteral<"agent">;
            systemPrompt: z.ZodString;
            provider: z.ZodOptional<z.ZodString>;
            model: z.ZodOptional<z.ZodString>;
            toolFilter: z.ZodOptional<z.ZodObject<{
                allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>;
            permissionPreset: z.ZodOptional<z.ZodString>;
            contextBudgetTokens: z.ZodOptional<z.ZodNumber>;
            retry: z.ZodObject<{
                maxAttempts: z.ZodNumber;
                backoffMs: z.ZodNumber;
                fallbackModel: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>;
            timeoutMs: z.ZodOptional<z.ZodNumber>;
            hitlEnabled: z.ZodBoolean;
        }, z.core.$strict>, z.ZodObject<{
            id: z.ZodString;
            name: z.ZodString;
            position: z.ZodOptional<z.ZodObject<{
                x: z.ZodNumber;
                y: z.ZodNumber;
            }, z.core.$strict>>;
            kind: z.ZodLiteral<"router">;
            cases: z.ZodArray<z.ZodString>;
        }, z.core.$strict>, z.ZodObject<{
            id: z.ZodString;
            name: z.ZodString;
            position: z.ZodOptional<z.ZodObject<{
                x: z.ZodNumber;
                y: z.ZodNumber;
            }, z.core.$strict>>;
            kind: z.ZodLiteral<"join">;
            strategy: z.ZodEnum<{
                any: "any";
                all: "all";
                quorum: "quorum";
            }>;
            quorum: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>, z.ZodObject<{
            id: z.ZodString;
            name: z.ZodString;
            position: z.ZodOptional<z.ZodObject<{
                x: z.ZodNumber;
                y: z.ZodNumber;
            }, z.core.$strict>>;
            kind: z.ZodLiteral<"loop">;
            mode: z.ZodEnum<{
                items: "items";
                count: "count";
                while: "while";
            }>;
            itemsExpr: z.ZodOptional<z.ZodString>;
            count: z.ZodOptional<z.ZodNumber>;
            condition: z.ZodOptional<z.ZodString>;
            maxIters: z.ZodNumber;
            collect: z.ZodBoolean;
        }, z.core.$strict>, z.ZodObject<{
            id: z.ZodString;
            name: z.ZodString;
            position: z.ZodOptional<z.ZodObject<{
                x: z.ZodNumber;
                y: z.ZodNumber;
            }, z.core.$strict>>;
            kind: z.ZodLiteral<"output">;
        }, z.core.$strict>, z.ZodObject<{
            id: z.ZodString;
            name: z.ZodString;
            position: z.ZodOptional<z.ZodObject<{
                x: z.ZodNumber;
                y: z.ZodNumber;
            }, z.core.$strict>>;
            kind: z.ZodLiteral<"note">;
            text: z.ZodString;
        }, z.core.$strict>], "kind">>;
        edges: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            from: z.ZodString;
            fromHandle: z.ZodOptional<z.ZodString>;
            to: z.ZodString;
            toHandle: z.ZodOptional<z.ZodLiteral<"back">>;
            format: z.ZodEnum<{
                text: "text";
                json: "json";
                md: "md";
            }>;
            template: z.ZodOptional<z.ZodString>;
            inContext: z.ZodDefault<z.ZodBoolean>;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    createdAt: z.ZodISODateTime;
    updatedAt: z.ZodISODateTime;
}, z.core.$strict>;
/** Timing selectors a trigger may carry; exactly one is set (G11). */
export type TriggerTiming = {
    readonly kind: 'cron';
    readonly expression: string;
    readonly timeZone: string;
} | {
    readonly kind: 'daily';
    readonly time: string;
    readonly timeZone: string;
} | {
    readonly kind: 'weekly';
    readonly time: string;
    readonly timeZone: string;
    readonly weekdays: readonly number[];
};
/** One durable schedule trigger for a stored workflow (G11). */
export declare const triggerRecordSchema: z.ZodObject<{
    id: z.ZodString;
    workflowId: z.ZodPipe<z.ZodString, z.ZodTransform<WorkflowId, string>>;
    timing: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"cron">;
        expression: z.ZodString;
        timeZone: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<"daily">;
        time: z.ZodString;
        timeZone: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<"weekly">;
        time: z.ZodString;
        timeZone: z.ZodString;
        weekdays: z.ZodArray<z.ZodNumber>;
    }, z.core.$strip>], "kind">;
    input: z.ZodString;
    tokenBudget: z.ZodOptional<z.ZodNumber>;
    enabled: z.ZodBoolean;
    scheduledAt: z.ZodString;
    lastRunId: z.ZodOptional<z.ZodString>;
    createdAt: z.ZodISODateTime;
    updatedAt: z.ZodISODateTime;
}, z.core.$strict>;
/** Stored trigger record; the table key is the trigger id. */
export type TriggerRecord = z.infer<typeof triggerRecordSchema>;
/** Library identity; assigned by the host, distinct from node ids. */
export type AgentLibraryId = Branded<'AgentLibraryId'>;
/**
 * One library agent: the reusable execution payload of an agent node. The
 * spec mirrors `AgentNodeSpec` minus node identity (`id`, `name`, `position`);
 * inserting into a workflow copies it onto a fresh node, keeping exported
 * workflow documents self-contained.
 */
export declare const agentLibrarySpecSchema: z.ZodType<AgentLibrarySpec>;
export interface AgentLibrarySpec {
    readonly kind: 'agent';
    readonly systemPrompt: string;
    readonly provider?: string;
    readonly model?: string;
    readonly toolFilter?: {
        readonly allow?: readonly string[];
        readonly deny?: readonly string[];
    };
    readonly permissionPreset?: string;
    readonly contextBudgetTokens?: number;
    readonly retry: {
        maxAttempts: number;
        backoffMs: number;
        fallbackModel?: string;
    };
    readonly timeoutMs?: number;
    readonly hitlEnabled: boolean;
}
/** One durable library-agent record; the table key is the agent id. */
export declare const agentLibraryRecordSchema: z.ZodObject<{
    id: z.ZodPipe<z.ZodString, z.ZodTransform<AgentLibraryId, string>>;
    name: z.ZodString;
    spec: z.ZodType<AgentLibrarySpec, unknown, z.core.$ZodTypeInternals<AgentLibrarySpec, unknown>>;
    createdAt: z.ZodISODateTime;
    updatedAt: z.ZodISODateTime;
}, z.core.$strict>;
/** Storage domain: lowercase snake names per UNIT_NAME_RE. */
export declare const agentMultiDomain: {
    name: string;
    version: number;
    tables: {
        workflows: import("@deepseek-ai/dsh-storage-domain").DomainTableSpec<string, {
            definition: {
                version: 1;
                id: WorkflowId;
                name: string;
                revision: number;
                nodes: ({
                    id: string;
                    name: string;
                    kind: "input";
                    position?: {
                        x: number;
                        y: number;
                    } | undefined;
                } | {
                    id: string;
                    name: string;
                    kind: "agent";
                    systemPrompt: string;
                    retry: {
                        maxAttempts: number;
                        backoffMs: number;
                        fallbackModel?: string | undefined;
                    };
                    hitlEnabled: boolean;
                    position?: {
                        x: number;
                        y: number;
                    } | undefined;
                    provider?: string | undefined;
                    model?: string | undefined;
                    toolFilter?: {
                        allow?: string[] | undefined;
                        deny?: string[] | undefined;
                    } | undefined;
                    permissionPreset?: string | undefined;
                    contextBudgetTokens?: number | undefined;
                    timeoutMs?: number | undefined;
                } | {
                    id: string;
                    name: string;
                    kind: "router";
                    cases: string[];
                    position?: {
                        x: number;
                        y: number;
                    } | undefined;
                } | {
                    id: string;
                    name: string;
                    kind: "join";
                    strategy: "any" | "all" | "quorum";
                    position?: {
                        x: number;
                        y: number;
                    } | undefined;
                    quorum?: number | undefined;
                } | {
                    id: string;
                    name: string;
                    kind: "loop";
                    mode: "items" | "count" | "while";
                    maxIters: number;
                    collect: boolean;
                    position?: {
                        x: number;
                        y: number;
                    } | undefined;
                    itemsExpr?: string | undefined;
                    count?: number | undefined;
                    condition?: string | undefined;
                } | {
                    id: string;
                    name: string;
                    kind: "output";
                    position?: {
                        x: number;
                        y: number;
                    } | undefined;
                } | {
                    id: string;
                    name: string;
                    kind: "note";
                    text: string;
                    position?: {
                        x: number;
                        y: number;
                    } | undefined;
                })[];
                edges: {
                    id: string;
                    from: string;
                    to: string;
                    format: "text" | "json" | "md";
                    inContext: boolean;
                    fromHandle?: string | undefined;
                    toHandle?: "back" | undefined;
                    template?: string | undefined;
                }[];
            };
            createdAt: string;
            updatedAt: string;
        }>;
        agents: import("@deepseek-ai/dsh-storage-domain").DomainTableSpec<string, {
            id: AgentLibraryId;
            name: string;
            spec: AgentLibrarySpec;
            createdAt: string;
            updatedAt: string;
        }>;
        triggers: import("@deepseek-ai/dsh-storage-domain").DomainTableSpec<string, {
            id: string;
            workflowId: WorkflowId;
            timing: {
                kind: "cron";
                expression: string;
                timeZone: string;
            } | {
                kind: "daily";
                time: string;
                timeZone: string;
            } | {
                kind: "weekly";
                time: string;
                timeZone: string;
                weekdays: number[];
            };
            input: string;
            enabled: boolean;
            scheduledAt: string;
            createdAt: string;
            updatedAt: string;
            tokenBudget?: number | undefined;
            lastRunId?: string | undefined;
        }>;
    };
};
/** Parsed draft as it enters semantic validation. */
export type ParsedWorkflowDraft = z.infer<typeof workflowDraftSchema>;
/** Parsed stored record. */
export type WorkflowRecord = z.infer<typeof workflowRecordSchema>;
/** Discriminated node union (single source of truth with the schema). */
export type NodeSpec = z.infer<typeof nodeSchema>;
/** The agent variant of the node union — the only schedulable, prompt-driven node. */
export type AgentNodeSpec = Extract<NodeSpec, {
    kind: 'agent';
}>;
/** Edge between two nodes; carries the intermediate-layer contract (R4). */
export type EdgeSpec = z.infer<typeof edgeSchema>;
/** Stored workflow; `revision` is the optimistic-concurrency counter. */
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
/** Editor payload: definition content without server-assigned identity. */
export type WorkflowDraft = z.infer<typeof workflowDraftSchema>;
export {};
//# sourceMappingURL=domain.d.ts.map