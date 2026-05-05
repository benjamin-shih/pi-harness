import type { TaskWeight } from "./prompt-guidance";

export type AmbientReceiptMode = "off" | "compact";
export type AmbientFeatureStatus = "not_enabled";
export type AmbientMemoryStatus = "off" | "auto_scoped";

export type AmbientPolicy = {
	weight: TaskWeight;
	receipt: AmbientReceiptMode;
	personalContext: AmbientMemoryStatus;
	advisorySubagents: AmbientFeatureStatus;
	vectorMemory: false;
	reasons: string[];
};

export function decideAmbientPolicy(weight: TaskWeight): AmbientPolicy {
	return {
		weight,
		receipt: weight === "trivial" ? "off" : "compact",
		personalContext: weight === "trivial" ? "off" : "auto_scoped",
		advisorySubagents: "not_enabled",
		vectorMemory: false,
		reasons: weight === "trivial" ? ["trivial_prompt"] : ["nontrivial_prompt"],
	};
}

export function shouldIncludeRepoContext(policy: AmbientPolicy): boolean {
	return policy.weight !== "trivial";
}

export function shouldIncludeMemoryContext(policy: AmbientPolicy): boolean {
	return policy.personalContext === "auto_scoped";
}
