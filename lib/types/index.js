/**
 * Host service for agent-multi: durable workflow definitions with
 * optimistic-concurrency editing, plus run execution (start, resume,
 * cancel, inspect) over typert remote methods for the Web client.
 * @module @deepseek-ai/dsh-experimental-agent-multi/src/index
 */
var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
import { randomUUID } from 'node:crypto';
import z from '@deepseek-ai/schemastery';
import { SessionId } from '@deepseek-ai/dsh-session';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { brandString } from '@deepseek-ai/dsh-brand';
import { agentMultiDomain, agentLibraryRecordSchema, workflowDraftSchema, workflowRecordSchema, triggerRecordSchema } from "./domain.js";
import { validateWorkflow } from "./validation.js";
import { agentMultiProjectionDefinition } from "./projection.js";
import { executeRun } from "./engine/run.js";
import { TriggerRuntime } from "./engine/trigger-runtime.js";
import { initialTargetOf, triggerEntryOf } from "./trigger-views.js";
import { RunJournal, executeAgentNode } from "./engine/executor.js";
import { textOf } from "./engine/format.js";
/** Render a node's content blocks to plain text for the dry-run result. */
function textOfContent(blocks) {
    return textOf(blocks);
}
/** Sentinel thrown inside a CAS write when the stored revision moved ahead. */
class RevisionConflict extends Error {
    current;
    constructor(current) {
        super('workflow revision conflict');
        this.current = current;
    }
}
/**
 * Workflow CRUD and run service. Owns the `agent_multi` storage domain: the
 * domain opens with the plugin, validates every stored record, and closes on
 * dispose, so a hot reload never leaks a domain handle. Runs execute in a
 * dedicated session each; the run registry is in-memory, so resuming a run
 * after a host restart requires the run-root session recovery planned for a
 * later phase.
 */
let AgentMultiController = (() => {
    let _classSuper = TypertRemoteService;
    let _instanceExtraInitializers = [];
    let _ping_decorators;
    let _createWorkflow_decorators;
    let _saveWorkflow_decorators;
    let _listWorkflows_decorators;
    let _getWorkflow_decorators;
    let _deleteWorkflow_decorators;
    let _validateWorkflow_decorators;
    let _exportWorkflow_decorators;
    let _importWorkflow_decorators;
    let _createLibraryAgent_decorators;
    let _saveLibraryAgent_decorators;
    let _listLibraryAgents_decorators;
    let _listModelCatalog_decorators;
    let _deleteLibraryAgent_decorators;
    let _startRun_decorators;
    let _createTrigger_decorators;
    let _setTriggerEnabled_decorators;
    let _deleteTrigger_decorators;
    let _listTriggers_decorators;
    let _resumeRun_decorators;
    let _cancelRun_decorators;
    let _getRun_decorators;
    let _listRuns_decorators;
    let _dryRunNode_decorators;
    return class AgentMultiController extends _classSuper {
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _ping_decorators = [Remote('ping')];
            _createWorkflow_decorators = [Remote('createWorkflow')];
            _saveWorkflow_decorators = [Remote('saveWorkflow')];
            _listWorkflows_decorators = [Remote('listWorkflows')];
            _getWorkflow_decorators = [Remote('getWorkflow')];
            _deleteWorkflow_decorators = [Remote('deleteWorkflow')];
            _validateWorkflow_decorators = [Remote('validateWorkflow')];
            _exportWorkflow_decorators = [Remote('exportWorkflow')];
            _importWorkflow_decorators = [Remote('importWorkflow')];
            _createLibraryAgent_decorators = [Remote('createLibraryAgent')];
            _saveLibraryAgent_decorators = [Remote('saveLibraryAgent')];
            _listLibraryAgents_decorators = [Remote('listLibraryAgents')];
            _listModelCatalog_decorators = [Remote('listModelCatalog')];
            _deleteLibraryAgent_decorators = [Remote('deleteLibraryAgent')];
            _startRun_decorators = [Remote('startRun')];
            _createTrigger_decorators = [Remote('createTrigger')];
            _setTriggerEnabled_decorators = [Remote('setTriggerEnabled')];
            _deleteTrigger_decorators = [Remote('deleteTrigger')];
            _listTriggers_decorators = [Remote('listTriggers')];
            _resumeRun_decorators = [Remote('resumeRun')];
            _cancelRun_decorators = [Remote('cancelRun')];
            _getRun_decorators = [Remote('getRun')];
            _listRuns_decorators = [Remote('listRuns')];
            _dryRunNode_decorators = [Remote('dryRunNode')];
            __esDecorate(this, null, _ping_decorators, { kind: "method", name: "ping", static: false, private: false, access: { has: obj => "ping" in obj, get: obj => obj.ping }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _createWorkflow_decorators, { kind: "method", name: "createWorkflow", static: false, private: false, access: { has: obj => "createWorkflow" in obj, get: obj => obj.createWorkflow }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _saveWorkflow_decorators, { kind: "method", name: "saveWorkflow", static: false, private: false, access: { has: obj => "saveWorkflow" in obj, get: obj => obj.saveWorkflow }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _listWorkflows_decorators, { kind: "method", name: "listWorkflows", static: false, private: false, access: { has: obj => "listWorkflows" in obj, get: obj => obj.listWorkflows }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getWorkflow_decorators, { kind: "method", name: "getWorkflow", static: false, private: false, access: { has: obj => "getWorkflow" in obj, get: obj => obj.getWorkflow }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _deleteWorkflow_decorators, { kind: "method", name: "deleteWorkflow", static: false, private: false, access: { has: obj => "deleteWorkflow" in obj, get: obj => obj.deleteWorkflow }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _validateWorkflow_decorators, { kind: "method", name: "validateWorkflow", static: false, private: false, access: { has: obj => "validateWorkflow" in obj, get: obj => obj.validateWorkflow }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _exportWorkflow_decorators, { kind: "method", name: "exportWorkflow", static: false, private: false, access: { has: obj => "exportWorkflow" in obj, get: obj => obj.exportWorkflow }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _importWorkflow_decorators, { kind: "method", name: "importWorkflow", static: false, private: false, access: { has: obj => "importWorkflow" in obj, get: obj => obj.importWorkflow }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _createLibraryAgent_decorators, { kind: "method", name: "createLibraryAgent", static: false, private: false, access: { has: obj => "createLibraryAgent" in obj, get: obj => obj.createLibraryAgent }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _saveLibraryAgent_decorators, { kind: "method", name: "saveLibraryAgent", static: false, private: false, access: { has: obj => "saveLibraryAgent" in obj, get: obj => obj.saveLibraryAgent }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _listLibraryAgents_decorators, { kind: "method", name: "listLibraryAgents", static: false, private: false, access: { has: obj => "listLibraryAgents" in obj, get: obj => obj.listLibraryAgents }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _listModelCatalog_decorators, { kind: "method", name: "listModelCatalog", static: false, private: false, access: { has: obj => "listModelCatalog" in obj, get: obj => obj.listModelCatalog }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _deleteLibraryAgent_decorators, { kind: "method", name: "deleteLibraryAgent", static: false, private: false, access: { has: obj => "deleteLibraryAgent" in obj, get: obj => obj.deleteLibraryAgent }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _startRun_decorators, { kind: "method", name: "startRun", static: false, private: false, access: { has: obj => "startRun" in obj, get: obj => obj.startRun }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _createTrigger_decorators, { kind: "method", name: "createTrigger", static: false, private: false, access: { has: obj => "createTrigger" in obj, get: obj => obj.createTrigger }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _setTriggerEnabled_decorators, { kind: "method", name: "setTriggerEnabled", static: false, private: false, access: { has: obj => "setTriggerEnabled" in obj, get: obj => obj.setTriggerEnabled }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _deleteTrigger_decorators, { kind: "method", name: "deleteTrigger", static: false, private: false, access: { has: obj => "deleteTrigger" in obj, get: obj => obj.deleteTrigger }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _listTriggers_decorators, { kind: "method", name: "listTriggers", static: false, private: false, access: { has: obj => "listTriggers" in obj, get: obj => obj.listTriggers }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _resumeRun_decorators, { kind: "method", name: "resumeRun", static: false, private: false, access: { has: obj => "resumeRun" in obj, get: obj => obj.resumeRun }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _cancelRun_decorators, { kind: "method", name: "cancelRun", static: false, private: false, access: { has: obj => "cancelRun" in obj, get: obj => obj.cancelRun }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getRun_decorators, { kind: "method", name: "getRun", static: false, private: false, access: { has: obj => "getRun" in obj, get: obj => obj.getRun }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _listRuns_decorators, { kind: "method", name: "listRuns", static: false, private: false, access: { has: obj => "listRuns" in obj, get: obj => obj.listRuns }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _dryRunNode_decorators, { kind: "method", name: "dryRunNode", static: false, private: false, access: { has: obj => "dryRunNode" in obj, get: obj => obj.dryRunNode }, metadata: _metadata }, null, _instanceExtraInitializers);
            if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        static inject = ['storageDomain', 'agentLoop', 'sessions', 'subagents', 'userQuestions', 'sessionProjections'];
        static Config = z.object({
            runRootProvider: z.string().default('deepseek'),
            runRootModel: z.string().default('deepseek-chat'),
            maxActive: z.number().step(1).min(1).default(8),
            tokenBudget: z.number().step(1).min(0),
        });
        ready = __runInitializers(this, _instanceExtraInitializers);
        runs = new Map();
        config;
        triggerRuntime;
        /** Resolved domain handle once `ready` settles; the promise never rejects. */
        resolvedDomain;
        constructor(ctx, config) {
            super(ctx, 'agentMultiController', { namespace: 'agentMulti' });
            this.config = {
                runRootProvider: config.runRootProvider ?? 'deepseek',
                runRootModel: config.runRootModel ?? 'deepseek-chat',
                maxActive: config.maxActive ?? 8,
                ...(config.tokenBudget !== undefined ? { tokenBudget: config.tokenBudget } : {}),
            };
            this.ready = ctx.storageDomain.open(agentMultiDomain).then(async (domain) => {
                for (const [key, record] of domain.table('workflows').entries()) {
                    if (key !== record.definition.id) {
                        // The mismatch is the actionable failure; a rejecting close must not replace it.
                        try {
                            await domain.close();
                        }
                        catch (error) {
                            ctx.logger.warn(`agent-multi: closing the domain after a key mismatch failed: ${String(error)}`);
                        }
                        throw new Error(`agent-multi: stored workflow key "${key}" differs from record id "${record.definition.id}"`);
                    }
                }
                this.resolvedDomain = domain;
                return domain;
            });
            this.triggerRuntime = new TriggerRuntime(ctx, () => { const domain = this.domainOf(); return domain === undefined ? [] : [...domain.table('triggers').entries()].map(([, record]) => record); }, async (trigger) => await this.fireTrigger(trigger), async (trigger) => {
                const domain = await this.ready;
                await domain.table('triggers').put(trigger.id, triggerRecordSchema.parse(trigger));
            });
            ctx.effect(async () => {
                const domain = await this.ready;
                this.triggerRuntime.requestDrive();
                return () => { void domain.close(); };
            });
            ctx.effect(() => {
                const disposeProjection = ctx.root.sessionProjections.register(agentMultiProjectionDefinition);
                return () => disposeProjection();
            });
            ctx.effect(() => () => {
                void this.triggerRuntime.dispose();
                for (const record of this.runs.values())
                    record.controller.abort();
            });
        }
        /** Recompute the trigger timer after any durable trigger change. */
        requestTriggerDrive() {
            this.triggerRuntime.requestDrive();
        }
        /** Synchronous domain access when already resolved, for the timer read. */
        domainOf() {
            return this.resolvedDomain;
        }
        /** Spike smoke method; retained as the cheapest remote round-trip check. */
        ping() {
            return { pong: true };
        }
        /** @param request - Draft content for a new workflow. */
        async createWorkflow(request) {
            const errors = checkDraft(request.draft);
            if (errors.length > 0)
                return { outcome: 'invalid', errors };
            const definition = {
                version: 1,
                id: brandString(randomUUID()),
                revision: 1,
                name: request.draft.name,
                nodes: request.draft.nodes,
                edges: request.draft.edges,
            };
            const now = new Date().toISOString();
            const record = workflowRecordSchema.parse({ definition, createdAt: now, updatedAt: now });
            const domain = await this.ready;
            await domain.table('workflows').put(definition.id, record);
            return { outcome: 'created', definition };
        }
        /** @param request - Draft content plus the revision the editor based it on. */
        async saveWorkflow(request) {
            const errors = checkDraft(request.draft);
            if (errors.length > 0)
                return { outcome: 'invalid', errors };
            const domain = await this.ready;
            const table = domain.table('workflows');
            if (table.get(request.id) === undefined)
                return { outcome: 'missing' };
            const now = new Date().toISOString();
            try {
                const record = await table.update(request.id, (current) => {
                    if (current.definition.revision !== request.expectedRevision) {
                        throw new RevisionConflict(current.definition);
                    }
                    const definition = {
                        version: 1,
                        id: request.id,
                        revision: request.expectedRevision + 1,
                        name: request.draft.name,
                        nodes: request.draft.nodes,
                        edges: request.draft.edges,
                    };
                    return workflowRecordSchema.parse({ definition, createdAt: current.createdAt, updatedAt: now });
                });
                return { outcome: 'saved', definition: record.definition };
            }
            catch (error) {
                if (error instanceof RevisionConflict)
                    return { outcome: 'conflict', current: error.current };
                throw error;
            }
        }
        /** Lists every stored workflow, name-ascending with id as tiebreaker. */
        async listWorkflows() {
            const domain = await this.ready;
            return [...domain.table('workflows').entries()]
                .map(([, record]) => ({ id: record.definition.id, name: record.definition.name, revision: record.definition.revision, updatedAt: record.updatedAt }))
                .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1);
        }
        /** @param request - Exact workflow identity. */
        async getWorkflow(request) {
            const record = (await this.ready).table('workflows').get(request.id);
            if (record === undefined)
                return { outcome: 'missing' };
            return { outcome: 'found', definition: record.definition, createdAt: record.createdAt, updatedAt: record.updatedAt };
        }
        /** @param request - Exact workflow identity. */
        async deleteWorkflow(request) {
            const deleted = await (await this.ready).table('workflows').delete(request.id);
            return deleted ? { outcome: 'deleted' } : { outcome: 'missing' };
        }
        /** @param request - Draft to validate without storing. */
        async validateWorkflow(request) {
            return { errors: checkDraft(request.draft) };
        }
        /**
         * Export one stored workflow as a portable document: the definition plus a
         * package stamp. The document round-trips through {@link importWorkflow}.
         * @param request - The workflow to export.
         */
        async exportWorkflow(request) {
            const record = (await this.ready).table('workflows').get(request.id);
            if (record === undefined)
                return { outcome: 'missing' };
            return {
                outcome: 'found',
                document: { kind: 'dsh-agent-multi-workflow', version: 1, definition: record.definition },
            };
        }
        /**
         * Import a portable workflow document: validated from scratch, stored with
         * either the exported identity (`keepId`) or a fresh id. An id collision
         * under `keepId` fails as `invalid` rather than overwriting.
         * @param request - The document and identity policy.
         */
        async importWorkflow(request) {
            const { document } = request;
            if (document.kind !== 'dsh-agent-multi-workflow' || document.version !== 1) {
                return { outcome: 'invalid', errors: [{ code: 'schema-invalid', message: 'unknown workflow document kind or version' }] };
            }
            const parsed = workflowRecordSchema.safeParse({
                definition: document.definition,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            });
            if (!parsed.success) {
                return { outcome: 'invalid', errors: [{ code: 'schema-invalid', message: 'document does not match the workflow schema' }] };
            }
            const definition = {
                ...parsed.data.definition,
                id: request.keepId === true
                    ? parsed.data.definition.id
                    : brandString(randomUUID()),
                revision: 1,
            };
            const errors = validateWorkflow(definition);
            if (errors.length > 0)
                return { outcome: 'invalid', errors };
            const now = new Date().toISOString();
            const domain = await this.ready;
            const existing = await domain.table('workflows').get(definition.id);
            if (existing !== undefined) {
                return { outcome: 'invalid', errors: [{ code: 'duplicate-id', message: `workflow id "${definition.id}" already exists` }] };
            }
            const record = workflowRecordSchema.parse({ definition, createdAt: now, updatedAt: now });
            await domain.table('workflows').put(definition.id, record);
            return { outcome: 'created', definition };
        }
        /**
         * Save one agent-node spec into the reusable library. The spec is validated
         * structurally (the same schema agent nodes use); a fresh agent id is
         * assigned on create.
         * @param request - Display name and the reusable agent payload.
         */
        async createLibraryAgent(request) {
            const parsed = agentLibraryRecordSchema.safeParse({
                id: randomUUID(),
                name: request.name,
                spec: request.spec,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            });
            if (!parsed.success) {
                return {
                    outcome: 'invalid',
                    errors: parsed.error.issues.map(issue => ({
                        code: 'schema-invalid',
                        message: `${issue.path.join('.')}: ${issue.message}`,
                    })),
                };
            }
            const record = parsed.data;
            const domain = await this.ready;
            await domain.table('agents').put(record.id, record);
            return { outcome: 'created', agent: { id: record.id, name: record.name, spec: record.spec, updatedAt: record.updatedAt } };
        }
        /**
         * Replace one library agent's name and spec.
         * @param request - The agent to update and its replacement content.
         */
        async saveLibraryAgent(request) {
            const domain = await this.ready;
            const current = await domain.table('agents').get(request.id);
            if (current === undefined)
                return { outcome: 'missing' };
            const parsed = agentLibraryRecordSchema.safeParse({
                id: request.id,
                name: request.name,
                spec: request.spec,
                createdAt: current.createdAt,
                updatedAt: new Date().toISOString(),
            });
            if (!parsed.success) {
                return {
                    outcome: 'invalid',
                    errors: parsed.error.issues.map(issue => ({
                        code: 'schema-invalid',
                        message: `${issue.path.join('.')}: ${issue.message}`,
                    })),
                };
            }
            await domain.table('agents').put(parsed.data.id, parsed.data);
            return { outcome: 'saved', agent: { id: parsed.data.id, name: parsed.data.name, spec: parsed.data.spec, updatedAt: parsed.data.updatedAt } };
        }
        /** Lists every library agent, name-ascending with id as tiebreaker. */
        async listLibraryAgents() {
            const domain = await this.ready;
            return [...domain.table('agents').entries()]
                .map(([, record]) => ({ id: record.id, name: record.name, spec: record.spec, updatedAt: record.updatedAt }))
                .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1);
        }
        /**
         * Read the host model catalog: registered providers with their models, so
         * the client can offer provider/model dropdowns instead of free text. A
         * provider whose model listing fails is skipped, not fatal.
         */
        async listModelCatalog() {
            const providers = this.ctx.llm.listProviders().map((provider) => ({ id: provider.id, name: provider.name }));
            const models = (await Promise.all(providers.map(async (provider) => {
                try {
                    const listed = await this.ctx.llm.listModels(provider.id);
                    return listed.map((model) => ({ provider: model.provider, id: model.id, name: model.name }));
                }
                catch {
                    this.ctx.logger.warn(`agent-multi: listing models for provider "${provider.id}" failed`);
                    return [];
                }
            }))).flat();
            return { providers, models };
        }
        /**
         * Delete one library agent. Stored workflows keep their own node copies,
         * so deleting never breaks an existing workflow.
         * @param request - The agent to remove.
         */
        async deleteLibraryAgent(request) {
            const domain = await this.ready;
            const deleted = await domain.table('agents').delete(request.id);
            return deleted ? { outcome: 'deleted' } : { outcome: 'missing' };
        }
        /**
         * Start a run: a dedicated session, a dormant run-root agent parenting every
         * node activation, and the engine driving the workflow to a terminal
         * outcome. Returns the run identity immediately; poll `get-run`.
         * @param request - The workflow to execute and the user input.
         */
        async startRun(request) {
            const record = (await this.ready).table('workflows').get(request.workflowId);
            if (record === undefined)
                return { outcome: 'missing' };
            const runRoot = await this.ctx.agentLoop.create(SessionId(randomUUID()), {
                provider: this.config.runRootProvider,
                model: this.config.runRootModel,
            });
            const budget = request.tokenBudget !== undefined
                ? request.tokenBudget
                : this.config.tokenBudget;
            return this.launchRun(record.definition, request.input, runRoot, false, undefined, budget);
        }
        /**
         * Fire one trigger: resolve the workflow, start the run, and return the run
         * id so the runtime can record it as the trigger's latest run. Resolves with
         * `undefined` when the workflow disappeared; the trigger keeps its target.
         * @param trigger - The due trigger record.
         */
        async fireTrigger(trigger) {
            const record = (await this.ready).table('workflows').get(trigger.workflowId);
            if (record === undefined)
                return undefined;
            const runRoot = await this.ctx.agentLoop.create(SessionId(randomUUID()), {
                provider: this.config.runRootProvider,
                model: this.config.runRootModel,
            });
            const budget = trigger.tokenBudget !== undefined
                ? trigger.tokenBudget
                : this.config.tokenBudget;
            const started = this.launchRun(record.definition, trigger.input, runRoot, false, undefined, budget);
            return started.runId;
        }
        /**
         * Create a workflow trigger. The timing rule is validated by the schedule
         * package's recurrence arithmetic and armed with its first future target.
         * @param request - Workflow binding, timing rule, and run parameters.
         */
        async createTrigger(request) {
            const domain = await this.ready;
            if (domain.table('workflows').get(request.workflowId) === undefined)
                return { outcome: 'missing' };
            let scheduledAt;
            try {
                scheduledAt = initialTargetOf(request.timing, Date.now());
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return { outcome: 'invalid', errors: [{ code: 'schema-invalid', message: `timing: ${message}` }] };
            }
            const now = new Date().toISOString();
            const parsed = triggerRecordSchema.safeParse({
                id: randomUUID(),
                workflowId: request.workflowId,
                timing: request.timing,
                input: request.input,
                ...(request.tokenBudget !== undefined ? { tokenBudget: request.tokenBudget } : {}),
                enabled: true,
                scheduledAt,
                createdAt: now,
                updatedAt: now,
            });
            if (!parsed.success) {
                return {
                    outcome: 'invalid',
                    errors: parsed.error.issues.map(issue => ({
                        code: 'schema-invalid',
                        message: `${issue.path.join('.')}: ${issue.message}`,
                    })),
                };
            }
            await domain.table('triggers').put(parsed.data.id, parsed.data);
            this.requestTriggerDrive();
            return { outcome: 'created', trigger: triggerEntryOf(parsed.data) };
        }
        /**
         * Enable or disable one trigger. Disabling stops the timer obligation; the
         * committed target is preserved, so re-enabling never back-fires missed runs.
         * @param request - The trigger and its new enabled state.
         */
        async setTriggerEnabled(request) {
            const domain = await this.ready;
            const table = domain.table('triggers');
            const current = table.get(request.id);
            if (current === undefined)
                return { outcome: 'missing' };
            const updated = {
                ...current,
                enabled: request.enabled,
                // Re-acceptance restarts from a strictly future occurrence.
                ...(request.enabled ? { scheduledAt: initialTargetOf(current.timing, Date.now()) } : {}),
                updatedAt: new Date().toISOString(),
            };
            await table.put(request.id, triggerRecordSchema.parse(updated));
            this.requestTriggerDrive();
            return { outcome: 'saved', trigger: triggerEntryOf(updated) };
        }
        /**
         * Delete one trigger. Runs already started by it keep running.
         * @param request - The trigger to remove.
         */
        async deleteTrigger(request) {
            const domain = await this.ready;
            const deleted = await domain.table('triggers').delete(request.id);
            this.requestTriggerDrive();
            return deleted ? { outcome: 'deleted' } : { outcome: 'missing' };
        }
        /**
         * List triggers, oldest first, optionally narrowed to one workflow.
         * @param request - Workflow filter, or all triggers when omitted.
         */
        async listTriggers(request) {
            const domain = await this.ready;
            const triggers = [...domain.table('triggers').entries()]
                .map(([, record]) => record)
                .filter(record => request.workflowId === undefined || record.workflowId === request.workflowId)
                .sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1)
                .map(record => triggerEntryOf(record));
            return { triggers };
        }
        /**
         * Resume a paused or failed run on its existing session: completed nodes
         * are skipped from the journal, the current stored definition is used (so
         * edits between attempts take effect), and the original input replays.
         * @param request - The run to continue.
         */
        async resumeRun(request) {
            const entry = this.runs.get(request.runId);
            if (entry === undefined)
                return { outcome: 'missing' };
            if (!entry.settled)
                return { outcome: 'running' };
            const record = (await this.ready).table('workflows').get(entry.workflowId);
            if (record === undefined)
                return { outcome: 'missing' };
            this.runs.delete(request.runId);
            return this.launchRun(record.definition, entry.lastInput, entry.runRoot, true, entry.runId);
        }
        /**
         * Cancel a run: aborts the run signal, which tears down in-flight node
         * activations and settles the run as cancelled. Awaiting the settled
         * status makes the response deterministic.
         * @param request - The run to abort.
         */
        async cancelRun(request) {
            const entry = this.runs.get(request.runId);
            if (entry === undefined)
                return { outcome: 'missing' };
            entry.controller.abort();
            await entry.execution;
            return { outcome: 'cancelled', runId: request.runId, status: runStatusOf(entry) };
        }
        /**
         * Inspect a run: status plus the full agent-multi journal projected from
         * the run session (the kanban derives from these events).
         * @param request - Exact run identity.
         */
        async getRun(request) {
            const entry = this.runs.get(request.runId);
            if (entry === undefined)
                return { outcome: 'missing' };
            return { outcome: 'found', run: this.viewOf(entry) };
        }
        /**
         * List tracked runs, newest first, optionally narrowed to one workflow.
         * Registry is in-memory, so the history covers this host process only.
         * @param request - Workflow filter, or all workflows when omitted.
         */
        async listRuns(request) {
            const runs = [...this.runs.values()]
                .filter(entry => request.workflowId === undefined || entry.workflowId === request.workflowId)
                .reverse()
                .map(entry => {
                const result = entry.result;
                const failure = result?.failure === undefined ? {} : { failure: { ...result.failure } };
                return { runId: entry.runId, workflowId: entry.workflowId, status: runStatusOf(entry), ...failure };
            });
            return { runs };
        }
        /**
         * Dry-run one agent node in isolation: a throwaway run-root session, no
         * workflow storage, no journal registration. Resolves with the settled
         * node outcome so the caller sees the final output or failure directly.
         * @param request - The node spec to try and the input to feed it.
         */
        async dryRunNode(request) {
            const runRoot = await this.ctx.agentLoop.create(SessionId(randomUUID()), {
                provider: this.config.runRootProvider,
                model: this.config.runRootModel,
            });
            const controller = new AbortController();
            const journal = new RunJournal(this.ctx, runRoot.session);
            const deps = {
                ctx: this.ctx,
                runRoot,
                journal,
                runId: brandString(randomUUID()),
                ledger: new Map(),
                userInput: request.input,
                signal: controller.signal,
                nodeOf: new Map(),
                hitlChildren: new Set(),
            };
            try {
                const outcome = await executeAgentNode(deps, request.node, []);
                if (outcome.ok) {
                    const events = runRoot.session.snapshotEvents()
                        .filter(event => event.type === 'agent-multi/node-end');
                    const usage = events.length > 0
                        ? (events.at(-1)?.data).usage
                        : undefined;
                    const durationMs = events.length > 0
                        ? ((events.at(-1)?.data).durationMs ?? 0)
                        : 0;
                    return {
                        outcome: 'completed',
                        output: textOfContent(outcome.output),
                        durationMs,
                        ...(usage !== undefined ? { usage } : {}),
                    };
                }
                return {
                    outcome: 'failed',
                    errorClass: outcome.errorClass,
                    message: outcome.message,
                    attempts: outcome.attempts,
                };
            }
            finally {
                controller.abort();
            }
        }
        /**
         * Launch (or relaunch) one run and register it. The execution promise never
         * rejects here: the engine maps every outcome to a {@link RunResult}, and a
         * journaling failure is contained as a synthetic failed run.
         */
        launchRun(definition, input, runRoot, resume, runId = brandString(randomUUID()), tokenBudget) {
            const controller = new AbortController();
            const execution = executeRun({
                ctx: this.ctx,
                runRoot,
                definition,
                userInput: input,
                signal: controller.signal,
                maxActive: this.config.maxActive,
                resume,
                runId,
                ...(tokenBudget !== undefined ? { tokenBudget } : {}),
            });
            const entry = {
                runId, workflowId: definition.id, runRoot, controller, execution,
                lastInput: input, settled: false, result: undefined,
            };
            this.runs.set(runId, entry);
            void execution.then((result) => {
                entry.settled = true;
                entry.result = result;
            }, () => {
                entry.settled = true;
                entry.result = { outcome: 'failed', runId };
            });
            return { outcome: 'started', runId };
        }
        /** Project a run record into the client view over its session journal and projection. */
        viewOf(entry) {
            const events = entry.runRoot.session.snapshotEvents()
                .filter((event) => event.type.startsWith('agent-multi/'))
                .map((event) => ({ type: event.type, data: event.data }));
            const result = entry.result;
            const failure = result?.failure === undefined ? {} : { failure: { ...result.failure } };
            const projected = this.ctx.sessionProjections.stateOf(entry.runRoot.session, 'agentMulti');
            const nodes = projected?.run === undefined
                ? []
                : Object.values(projected.run.nodes)
                    .map(node => ({
                    nodeId: node.nodeId,
                    nodeKind: node.nodeKind,
                    status: node.status,
                    attempt: node.attempt,
                    ...node.streaming === undefined ? {} : { streaming: node.streaming },
                    ...node.output === undefined ? {} : { output: node.output },
                    ...node.errorClass === undefined ? {} : { errorClass: node.errorClass },
                    ...node.message === undefined ? {} : { message: node.message },
                    ...node.attempts === undefined ? {} : { attempts: node.attempts },
                    ...node.durationMs === undefined ? {} : { durationMs: node.durationMs },
                    ...node.usage === undefined ? {} : { usage: node.usage },
                }));
            const hitl = projected?.run?.hitl === undefined
                ? {}
                : {
                    hitl: {
                        nodeId: projected.run.hitl.nodeId,
                        question: projected.run.hitl.question,
                        ...projected.run.hitl.answer === undefined ? {} : { answer: projected.run.hitl.answer },
                    },
                };
            const pausedReason = projected?.run?.pauseReason === undefined
                ? {}
                : { pausedReason: projected.run.pauseReason };
            if (result?.output === undefined) {
                return {
                    runId: entry.runId, workflowId: entry.workflowId,
                    status: runStatusOf(entry), nodes, ...hitl, ...pausedReason, events, ...failure,
                };
            }
            return {
                runId: entry.runId, workflowId: entry.workflowId,
                status: runStatusOf(entry), nodes, ...hitl, ...pausedReason, events, ...failure,
                output: result.output,
            };
        }
    };
})();
export { AgentMultiController };
/** Terminal or in-progress status of a tracked run. */
function runStatusOf(entry) {
    return entry.settled ? (entry.result?.outcome ?? 'failed') : 'running';
}
/** Structural parse followed by semantic graph rules. */
function checkDraft(draft) {
    const parsed = workflowDraftSchema.safeParse(draft);
    if (!parsed.success) {
        return parsed.error.issues.map(issue => ({
            code: 'schema-invalid',
            message: `${issue.path.join('.')}: ${issue.message}`,
        }));
    }
    return validateWorkflow(parsed.data);
}
export default AgentMultiController;
//# sourceMappingURL=index.js.map