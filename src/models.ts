import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";

// Canonical selection + display order for the model picker.
// `resolveModel` returns the first partial match, so `opus` resolves to the first-listed opus entry.
// Extracted from index.ts so tests can import without activating the extension.

export const MODEL_IDS_IN_ORDER = ["claude-fable-5-1", "claude-fable-5", "claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-5-5", "claude-sonnet-5", "claude-sonnet-4-6", "claude-haiku-5-5", "claude-haiku-4-5"];

// Workaround for models that ship without a thinkingLevelMap. Sonnet 5 and
// Sonnet 4.6 have no map, so getSupportedThinkingLevels hides xhigh (it's
// opt-in). Both models' top effort tier is "max" with no real xhigh (verified
// via Claude Code's supportedModels API), so xhigh->max matches opus-4-6.
const DEFAULT_THINKING_LEVEL_MAPS: Record<string, Record<string, string>> = {
	"claude-sonnet-5": { xhigh: "max" },
	"claude-sonnet-4-6": { xhigh: "max" },
};

// Project pi-ai's model entries down to the fields OMP's registerProvider expects,
// and keep MODEL_IDS_IN_ORDER ordering. IDs missing from pi-ai are silently dropped.
// Context-dependent display labels are applied after plan/long-context config is known.
export function buildModels<T extends { id: string; [key: string]: any }>(piAiModels: T[]) {
	return MODEL_IDS_IN_ORDER
		.map((id) => piAiModels.find((m) => m.id === id))
		.filter((m) => m != null)
		// Forward thinkingLevelMap so per-model overrides (e.g. opus-4-7 mapping
		// xhigh->xhigh instead of xhigh->max) are visible to the effort lookup.
		.map(({ id, name, reasoning, input, contextWindow, maxTokens, thinkingLevelMap }) => ({
			id,
			name,
			reasoning, input, contextWindow, maxTokens,
			thinkingLevelMap: thinkingLevelMap ?? DEFAULT_THINKING_LEVEL_MAPS[id],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}));
}

/*
// Select the canonical OMP catalog entries in a stable picker order. Copy only
// provider-model metadata: source routing fields such as `api`, `provider`, and
// `baseUrl` must not override the bridge's custom stream handler.
export function buildModels<T extends ProviderModelConfig>(ompModels: T[]): ProviderModelConfig[] {
	const modelsById = new Map(ompModels.map((model) => [model.id, model]));
	return MODEL_IDS_IN_ORDER.flatMap((id) => {
		const model = modelsById.get(id);
		if (!model) return [];
		return [{
			id: model.id,
			name: model.name,
			reasoning: model.reasoning,
			...(model.thinking ? { thinking: model.thinking } : {}),
			input: model.input,
			cost: model.cost,
			...(model.premiumMultiplier != null ? { premiumMultiplier: model.premiumMultiplier } : {}),
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			...(model.headers ? { headers: model.headers } : {}),
			...(model.compat ? { compat: model.compat } : {}),
		}];
	});
}
*/

// User-selectable context-window policy (see provider.contextWindow in config).
//   "auto"  - per-model default policy (measured SDK behavior).
//   "1m"    - force 1M: only register 1M-capable models, request [1m] where needed.
//   "200k"  - force 200K: only register 200K-capable models, request bare model ids.
export type ContextWindowMode = "auto" | "1m" | "200k";

export type LongContextSettings = {
	plan: "pro" | "max";
	longContextExtraUsage: boolean;
	contextWindow: ContextWindowMode;
};

export type ClaudeCodeRuntimeModel = {
	cliModelId: string;
	contextWindow: number;
};

const TWO_HUNDRED_K_CONTEXT = 200_000;
const ONE_M_CONTEXT = 1_000_000;

// Measured Claude Agent SDK subscription/OAuth behavior. Do not infer this from
// pi-ai's advertised contextWindow: bare Opus 4.7 serves 1M, bare Opus 4.8 does
// not, bare Fable 5 serves 200K while claude-fable-5[1m] serves 1M, and [1m]
// entitlement differs by model. Returns null when a model has no runtime for the
// requested forced window (that model is hidden from the picker in that mode).
export function resolveClaudeCodeRuntimeModel(modelId: string, settings: LongContextSettings): ClaudeCodeRuntimeModel | null {
	switch (settings.contextWindow) {
		case "1m":
			return resolveForcedOneMRuntimeModel(modelId);
		case "200k":
			return resolveForcedTwoHundredKRuntimeModel(modelId);
		case "auto":
			return resolveAutoRuntimeModel(modelId, settings);
	}
}

function resolveAutoRuntimeModel(modelId: string, settings: LongContextSettings): ClaudeCodeRuntimeModel {
	switch (modelId) {
		case "claude-fable-5-1":
			return { cliModelId: "claude-fable-5-1", contextWindow: TWO_HUNDRED_K_CONTEXT };
		case "claude-opus-5-5":
			return { cliModelId: "claude-opus-5-5[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-opus-5":
			return { cliModelId: "claude-opus-5[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-sonnet-5-5":
			return { cliModelId: "claude-sonnet-5-5[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-haiku-5-5":
			return { cliModelId: "claude-haiku-5-5", contextWindow: TWO_HUNDRED_K_CONTEXT };
		case "claude-opus-4-8":
			return { cliModelId: "claude-opus-4-8[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-opus-4-7":
			return { cliModelId: "claude-opus-4-7", contextWindow: ONE_M_CONTEXT };
		case "claude-opus-4-6": {
			const useOneM = settings.plan === "max" || settings.longContextExtraUsage;
			return {
				cliModelId: useOneM ? "claude-opus-4-6[1m]" : "claude-opus-4-6",
				contextWindow: useOneM ? ONE_M_CONTEXT : TWO_HUNDRED_K_CONTEXT,
			};
		}
		case "claude-fable-5":
			return { cliModelId: "claude-fable-5", contextWindow: TWO_HUNDRED_K_CONTEXT };
		case "claude-sonnet-5":
			return { cliModelId: "claude-sonnet-5[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-sonnet-4-6":
			return {
				cliModelId: settings.longContextExtraUsage ? "claude-sonnet-4-6[1m]" : "claude-sonnet-4-6",
				contextWindow: settings.longContextExtraUsage ? ONE_M_CONTEXT : TWO_HUNDRED_K_CONTEXT,
			};
		case "claude-haiku-4-5":
			return { cliModelId: "claude-haiku-4-5", contextWindow: TWO_HUNDRED_K_CONTEXT };
		default:
			console.error(`claude-bridge: encountered model ${modelId} with no known context size, defaulting to 200K`);
			return { cliModelId: modelId, contextWindow: TWO_HUNDRED_K_CONTEXT };
	}
}

function resolveForcedOneMRuntimeModel(modelId: string): ClaudeCodeRuntimeModel | null {
	switch (modelId) {
		case "claude-fable-5-1":
			return { cliModelId: "claude-fable-5-1[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-opus-5-5":
			return { cliModelId: "claude-opus-5-5[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-opus-5":
			return { cliModelId: "claude-opus-5[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-sonnet-5-5":
			return { cliModelId: "claude-sonnet-5-5[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-haiku-5-5":
			return { cliModelId: "claude-haiku-5-5[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-opus-4-8":
			return { cliModelId: "claude-opus-4-8[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-opus-4-7":
			return { cliModelId: "claude-opus-4-7", contextWindow: ONE_M_CONTEXT };
		case "claude-opus-4-6":
			return { cliModelId: "claude-opus-4-6[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-fable-5":
			return { cliModelId: "claude-fable-5[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-sonnet-5":
			return { cliModelId: "claude-sonnet-5[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-sonnet-4-6":
			return { cliModelId: "claude-sonnet-4-6[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-haiku-4-5":
			return null;
		default:
			console.error(`claude-bridge: encountered model ${modelId} with no known 1M runtime, hiding it`);
			return null;
	}
}

function resolveForcedTwoHundredKRuntimeModel(modelId: string): ClaudeCodeRuntimeModel | null {
	switch (modelId) {
		case "claude-fable-5-1":
			return { cliModelId: "claude-fable-5-1", contextWindow: TWO_HUNDRED_K_CONTEXT };
		case "claude-opus-5-5":
			return { cliModelId: "claude-opus-5-5", contextWindow: TWO_HUNDRED_K_CONTEXT };
		case "claude-opus-5":
			return { cliModelId: "claude-opus-5", contextWindow: TWO_HUNDRED_K_CONTEXT };
		case "claude-sonnet-5-5":
			return { cliModelId: "claude-sonnet-5-5", contextWindow: TWO_HUNDRED_K_CONTEXT };
		case "claude-haiku-5-5":
			return { cliModelId: "claude-haiku-5-5", contextWindow: TWO_HUNDRED_K_CONTEXT };
		case "claude-opus-4-8":
			return { cliModelId: "claude-opus-4-8", contextWindow: TWO_HUNDRED_K_CONTEXT };
		case "claude-opus-4-7":
			return null;
		case "claude-opus-4-6":
			return { cliModelId: "claude-opus-4-6", contextWindow: TWO_HUNDRED_K_CONTEXT };
		case "claude-fable-5":
			return { cliModelId: "claude-fable-5", contextWindow: TWO_HUNDRED_K_CONTEXT };
		case "claude-sonnet-5":
			return { cliModelId: "claude-sonnet-5", contextWindow: TWO_HUNDRED_K_CONTEXT };
		case "claude-sonnet-4-6":
			return { cliModelId: "claude-sonnet-4-6", contextWindow: TWO_HUNDRED_K_CONTEXT };
		case "claude-haiku-4-5":
			return { cliModelId: "claude-haiku-4-5", contextWindow: TWO_HUNDRED_K_CONTEXT };
		default:
			console.error(`claude-bridge: encountered model ${modelId} with no known 200K runtime, hiding it`);
			return null;
	}
}

// Split a registered picker id into its base model id and the forced window it
// encodes. Variant ids carry a "-1m"/"-200k" suffix (see buildVariantModels); the
// unsuffixed id maps to the config default. Base ids never end in those suffixes,
// so the split is unambiguous.
export function parseVariantId(id: string): { baseId: string; forced?: "1m" | "200k" } {
	if (id.endsWith("-1m")) return { baseId: id.slice(0, -3), forced: "1m" };
	if (id.endsWith("-200k")) return { baseId: id.slice(0, -5), forced: "200k" };
	return { baseId: id };
}

export function claudeCodeModelId(model: { id: string }, settings: LongContextSettings): string {
	const { baseId, forced } = parseVariantId(model.id);
	const runtimeModel = forced === "1m"
		? resolveForcedOneMRuntimeModel(baseId)
		: forced === "200k"
			? resolveForcedTwoHundredKRuntimeModel(baseId)
			: resolveClaudeCodeRuntimeModel(baseId, settings);
	if (runtimeModel == null) {
		const requested = forced ?? settings.contextWindow;
		throw new Error(`claude-bridge: model ${model.id} has no Claude Code runtime (contextWindow=${requested})`);
	}
	return runtimeModel.cliModelId;
}

export function resolveModel<T extends { id: string }>(models: T[], input: string): T | undefined {
	const lower = input.toLowerCase();
	return models.find((m) => m.id === lower || m.id.includes(lower));
}
