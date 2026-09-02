import type { RegisteredGraphDefinition } from "./registry.ts";
import { createGraphRegistry } from "./registry.ts";
import {
	assertProjectGraphRevisionHistoryDeletable,
	deleteProjectGraphRevisionHistory,
	ensureProjectGraphRevision,
	getProjectGraphRevisionHistory,
	prepareProjectGraphUpdate,
	resolveProjectGraphRevision,
	rollbackProjectGraphRevision,
	updateProjectGraphRevision,
	type GraphRevisionInspection,
	type PreparedGraphRevisionChange,
	type ProjectGraphHistory,
} from "./graph-revisions.ts";
import type {
	DeclarativeGraphSpec,
	DeleteProjectGraphResult,
	LoadProjectGraphsResult,
	LoadedProjectGraph,
	ProjectGraphCompiler,
	ProjectGraphDiagnostic,
	SaveProjectGraphResult,
} from "./project-graphs.ts";
import { deleteProjectGraph, loadProjectGraphs, saveProjectGraph } from "./project-graphs.ts";

export type GraphCatalogSourceKind = "built-in" | "project";

export interface GraphCatalogSource {
	kind: GraphCatalogSourceKind;
	path?: string;
}

export interface CatalogGraphEntry {
	definition: RegisteredGraphDefinition;
	source: GraphCatalogSource;
}

export interface GraphCatalog {
	definitions: RegisteredGraphDefinition[];
	graphs: Record<string, RegisteredGraphDefinition>;
	names: string[];
	entries: Record<string, CatalogGraphEntry>;
	sources: Record<string, GraphCatalogSource>;
	diagnostics: ProjectGraphDiagnostic[];
}

export interface GraphCatalogStoreOptions {
	builtInDefinitions: RegisteredGraphDefinition[];
	compiler: ProjectGraphCompiler;
}

export interface GraphCatalogRequest {
	cwd: string;
	trusted: boolean;
}

export interface SaveCatalogGraphRequest extends GraphCatalogRequest {
	spec: DeclarativeGraphSpec;
}

export interface SaveCatalogGraphResult extends SaveProjectGraphResult {
	catalog: GraphCatalog;
}

export interface DeleteCatalogGraphRequest extends GraphCatalogRequest {
	name: string;
}

export interface DeleteCatalogGraphResult extends DeleteProjectGraphResult {
	catalog: GraphCatalog;
}

export interface UpdateCatalogGraphRequest extends GraphCatalogRequest {
	spec: DeclarativeGraphSpec;
	expectedDefinitionHash: string;
}

export interface RollbackCatalogGraphRequest extends GraphCatalogRequest {
	name: string;
	targetDefinitionHash: string;
	expectedDefinitionHash: string;
}

interface CachedCatalog {
	cwd: string;
	trusted: boolean;
	catalog: GraphCatalog;
}

function duplicateDiagnostic(message: string, graphName: string, path?: string): ProjectGraphDiagnostic {
	return {
		code: "duplicate-graph",
		message,
		graphName,
		path,
	};
}

function mergeCatalog(
	builtInDefinitions: RegisteredGraphDefinition[],
	projectResult: LoadProjectGraphsResult,
): GraphCatalog {
	const entries = Object.create(null) as Record<string, CatalogGraphEntry>;
	const accepted: RegisteredGraphDefinition[] = [];
	const diagnostics = [...projectResult.diagnostics];
	const rejectedNames = new Set<string>();

	for (const definition of builtInDefinitions) {
		entries[definition.name] = {
			definition,
			source: { kind: "built-in" },
		};
		accepted.push(definition);
	}

	const projectCounts = new Map<string, number>();
	for (const graph of projectResult.graphs) {
		projectCounts.set(graph.definition.name, (projectCounts.get(graph.definition.name) ?? 0) + 1);
	}

	for (const graph of projectResult.graphs) {
		const name = graph.definition.name;
		if (Object.hasOwn(entries, name)) {
			diagnostics.push(duplicateDiagnostic(`Project graph conflicts with built-in graph: ${name}`, name, graph.path));
			rejectedNames.add(name);
			continue;
		}
		if ((projectCounts.get(name) ?? 0) > 1) {
			diagnostics.push(duplicateDiagnostic(`Duplicate project graph name: ${name}`, name, graph.path));
			rejectedNames.add(name);
			continue;
		}
		entries[name] = {
			definition: graph.definition,
			source: { kind: "project", path: graph.path },
		};
		accepted.push(graph.definition);
	}

	if (rejectedNames.size > 0) {
		for (const name of rejectedNames) {
			const entry = entries[name];
			if (entry?.source.kind === "project") delete entries[name];
		}
	}

	const registry = createGraphRegistry(accepted.filter((definition) => entries[definition.name]?.definition === definition));
	const sources = Object.fromEntries(Object.entries(entries).map(([name, entry]) => [name, entry.source]));
	return {
		definitions: registry.definitions,
		graphs: registry.graphs,
		names: registry.names,
		entries,
		sources,
		diagnostics,
	};
}

export class GraphCatalogStore {
	readonly builtInDefinitions: RegisteredGraphDefinition[];
	readonly compiler: ProjectGraphCompiler;
	private readonly cache = new Map<string, CachedCatalog>();

	constructor(options: GraphCatalogStoreOptions) {
		this.builtInDefinitions = options.builtInDefinitions;
		this.compiler = options.compiler;
	}

	private cacheKey(request: GraphCatalogRequest): string {
		return `${request.trusted ? "trusted" : "untrusted"}\0${request.cwd}`;
	}

	async getCatalog(request: GraphCatalogRequest): Promise<GraphCatalog> {
		const key = this.cacheKey(request);
		const cached = this.cache.get(key);
		if (cached) return cached.catalog;
		return this.reload(request);
	}

	async reload(request: GraphCatalogRequest): Promise<GraphCatalog> {
		const projectResult = await loadProjectGraphs({
			cwd: request.cwd,
			trusted: request.trusted,
			compiler: this.compiler,
		});
		const catalog = mergeCatalog(this.builtInDefinitions, projectResult);
		this.cache.set(this.cacheKey(request), {
			cwd: request.cwd,
			trusted: request.trusted,
			catalog,
		});
		return catalog;
	}

	async saveProjectGraph(request: SaveCatalogGraphRequest): Promise<SaveCatalogGraphResult> {
		const current = await this.reload(request);
		if (current.graphs[request.spec.name]) {
			throw new Error(`Graph already exists in catalog: ${request.spec.name}`);
		}

		const saved = await saveProjectGraph({
			cwd: request.cwd,
			trusted: request.trusted,
			compiler: this.compiler,
			spec: request.spec,
		});
		if (saved.graph.definition.definitionHash) {
			await ensureProjectGraphRevision({
				cwd: request.cwd,
				trusted: request.trusted,
				compiler: this.compiler,
				name: request.spec.name,
				action: "create",
			});
		}
		const catalog = await this.reload(request);
		return {
			...saved,
			catalog,
		};
	}

	async ensureProjectGraphRevision(request: GraphCatalogRequest & { name: string }): Promise<{ graph: LoadedProjectGraph; history: ProjectGraphHistory } | undefined> {
		const current = await this.reload(request);
		const entry = current.entries[request.name];
		if (!entry) throw new Error(`Unknown graph: ${request.name}`);
		if (entry.source.kind !== "project") return undefined;
		if (!entry.definition.definitionHash) return undefined;
		return ensureProjectGraphRevision({ ...request, compiler: this.compiler });
	}

	async prepareProjectGraphUpdate(request: UpdateCatalogGraphRequest): Promise<PreparedGraphRevisionChange> {
		const current = await this.reload(request);
		const entry = current.entries[request.spec.name];
		if (!entry) throw new Error(`Unknown graph: ${request.spec.name}`);
		if (entry.source.kind !== "project") throw new Error(`Built-in graph cannot be updated: ${request.spec.name}`);
		return prepareProjectGraphUpdate({ ...request, compiler: this.compiler });
	}

	async updateProjectGraph(request: UpdateCatalogGraphRequest) {
		await this.prepareProjectGraphUpdate(request);
		const updated = await updateProjectGraphRevision({ ...request, compiler: this.compiler });
		const catalog = await this.reload(request);
		return { ...updated, catalog };
	}

	async getProjectGraphHistory(request: GraphCatalogRequest & { name: string; definitionHash?: string }): Promise<GraphRevisionInspection> {
		const current = await this.reload(request);
		const entry = current.entries[request.name];
		if (!entry) throw new Error(`Unknown graph: ${request.name}`);
		if (entry.source.kind !== "project") throw new Error(`Built-in graph has no project revision history: ${request.name}`);
		return getProjectGraphRevisionHistory({ ...request, compiler: this.compiler });
	}

	async rollbackProjectGraph(request: RollbackCatalogGraphRequest) {
		const current = await this.reload(request);
		const entry = current.entries[request.name];
		if (!entry) throw new Error(`Unknown graph: ${request.name}`);
		if (entry.source.kind !== "project") throw new Error(`Built-in graph cannot be rolled back: ${request.name}`);
		const rolledBack = await rollbackProjectGraphRevision({ ...request, compiler: this.compiler });
		const catalog = await this.reload(request);
		return { ...rolledBack, catalog };
	}

	async resolveProjectGraphRevision(request: GraphCatalogRequest & {
		name: string;
		version: string | undefined;
		definitionHash: string | undefined;
		sourcePath: string | undefined;
	}): Promise<RegisteredGraphDefinition> {
		return resolveProjectGraphRevision({ ...request, compiler: this.compiler });
	}

	async deleteProjectGraph(request: DeleteCatalogGraphRequest): Promise<DeleteCatalogGraphResult> {
		const current = await this.reload(request);
		const entry = current.entries[request.name];
		if (!entry) throw new Error(`Unknown graph: ${request.name}`);
		if (entry.source.kind !== "project") throw new Error(`Built-in graph cannot be deleted: ${request.name}`);
		await assertProjectGraphRevisionHistoryDeletable(request.cwd, request.name);

		const deleted = await deleteProjectGraph({
			cwd: request.cwd,
			trusted: request.trusted,
			compiler: this.compiler,
			name: request.name,
		});
		await deleteProjectGraphRevisionHistory(request.cwd, request.name);
		const catalog = await this.reload(request);
		return {
			...deleted,
			catalog,
		};
	}
}

export function createGraphCatalogStore(options: GraphCatalogStoreOptions): GraphCatalogStore {
	return new GraphCatalogStore(options);
}
