export function redactSensitiveText(text: string): string {
	return text
		.replace(/-----BEGIN [^-]*(?:PRIVATE KEY|SECRET)[\s\S]*?-----END [^-]*(?:PRIVATE KEY|SECRET)-----/gi, "[REDACTED_PRIVATE_BLOCK]")
		.replace(/(https?:\/\/[^:\s/@]+:)[^@\s]+(@)/gi, "$1[REDACTED]$2")
		.replace(/(Authorization:\s*Bearer\s+)[^\s'\"]+/gi, "$1[REDACTED]")
		.replace(/\b([A-Za-z0-9_]{0,80}(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE[_-]?KEY|ACCESS[_-]?KEY)[A-Za-z0-9_]{0,80}\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s'\"]+)/gi, "$1[REDACTED]")
		.replace(/(--(?:api-key|token|password|secret)\s+)[^\s'\"]+/gi, "$1[REDACTED]")
		.replace(/\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})\b/g, "[REDACTED_TOKEN]");
}

export function truncateText(text: string, maxChars: number): string {
	const clean = redactSensitiveText(text).replace(/\s+/g, " ").trim();
	return clean.length <= maxChars ? clean : `${clean.slice(0, maxChars - 1)}…`;
}

export function truncateMiddle(text: string, maxChars: number, label = "content"): string {
	if (text.length <= maxChars) return text;
	if (maxChars <= 200) return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
	const marker = `\n\n[${label} truncated: omitted ${text.length - maxChars} chars to keep custom compaction under model context limits]\n\n`;
	const keep = Math.max(0, maxChars - marker.length);
	const head = Math.floor(keep * 0.35);
	const tail = keep - head;
	return `${text.slice(0, head)}${marker}${text.slice(text.length - tail)}`;
}

export function compactSerializedConversation(text: string): string {
	const lines = text.split(/\r?\n/);
	const kept: string[] = [];
	let skipping: "thinking" | "tool" | undefined;

	for (const line of lines) {
		const isSectionStart = /^\[[A-Za-z ]+\]:/.test(line);
		if (isSectionStart) skipping = undefined;

		if (line.startsWith("[Assistant thinking]:")) {
			kept.push("[Assistant thinking]: [omitted by memory spine budget]");
			skipping = "thinking";
			continue;
		}
		if (line.startsWith("[Tool result]:")) {
			kept.push("[Tool result]: [omitted by memory spine budget; use file/tool metadata]");
			skipping = "tool";
			continue;
		}
		if (skipping) continue;
		kept.push(line);
	}

	return redactSensitiveText(kept.join("\n"));
}

export function formatUnknownError(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}
