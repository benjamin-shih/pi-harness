import type { TaskWeight } from "../harness-commands/prompt-guidance";

export type AmbientReceiptMode = "off" | "compact";
export type AmbientFeatureStatus = "not_enabled";

export type AmbientPolicy = {
	weight: TaskWeight;
	receipt: AmbientReceiptMode;
	personalContext: AmbientFeatureStatus;
	advisorySubagents: AmbientFeatureStatus;
	vectorMemory: false;
	reasons: string[];
};

export function decideAmbientPolicy(weight: TaskWeight): AmbientPolicy {
	return {
		weight,
		receipt: weight === "trivial" ? "off" : "compact",
		personalContext: "not_enabled",
		advisorySubagents: "not_enabled",
		vectorMemory: false,
		reasons: weight === "trivial" ? ["trivial_prompt"] : ["nontrivial_prompt"],
	};
}

export function shouldIncludeRepoContext(policy: AmbientPolicy): boolean {
	return policy.weight !== "trivial";
}
