const SHELL_COMMAND_WORD_RE = /^(?:cat|bat|less|more|head|tail|sed|awk|grep|egrep|fgrep|rg|ripgrep|strings|xxd|hexdump|base64|openssl|jq|python3?|node|ruby|perl|curl|wget|scp|sftp|rsync|rclone|git|aws|gh|make|npm|pnpm|yarn|cd)$/;

export function cleanPathToken(rawPath: string): string {
	return rawPath
		.trim()
		.replace(/^(?:\d?>+|&>|<+)/, "")
		.replace(/^@/, "")
		.replace(/^[\'"]|[\'"]$/g, "")
		.replace(/[,:]+$/g, "");
}

export function extractPathTokens(command: string, includePlainOperands = false): string[] {
	const tokens = new Set<string>();
	const pathLike = /(?:^|[\s"'`=:(])(@?(?:~|\$HOME|\.{1,2}|\/)[^\s"'`;&|)]+)/g;
	let match: RegExpExecArray | null;
	while ((match = pathLike.exec(command))) {
		const token = cleanPathToken(match[1] ?? "");
		if (token) tokens.add(token);
	}

	for (const token of command.split(/\s+/)) {
		const cleaned = cleanPathToken(token);
		if (!cleaned || cleaned.startsWith("-") || /^[A-Z_]+=/.test(cleaned) || /^[a-z]+:\/\//i.test(cleaned)) continue;
		if (SHELL_COMMAND_WORD_RE.test(cleaned)) continue;
		if (includePlainOperands || /[/~.$]|(?:env|rsa|ed25519|ecdsa|dsa|npmrc|pypirc|netrc|credentials?|secrets?|tokens?|wallet|private-key|service-account|auth\.json|\.pem|\.key|\.p12|\.pfx)$/i.test(cleaned)) tokens.add(cleaned);
	}

	return [...tokens];
}

function extractRedirectionTargets(command: string): string[] {
	const targets = new Set<string>();
	const re = /(?:\d*(?:>>?|<)|&>)\s*([^\s;&|)]+)/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(command))) {
		const token = cleanPathToken(match[1] ?? "");
		if (token) targets.add(token);
	}
	return [...targets];
}

function looksFileMutationCommand(command: string): boolean {
	return /(^|[;&|()\s])(?:rm|mv|cp|touch|mkdir|rmdir|tee)\b/.test(command)
		|| /\b(?:sed|perl)\s+[^\n]*\s-i\b/.test(command);
}

export function extractWritePathTokens(command: string): string[] {
	const tokens = new Set(extractRedirectionTargets(command));
	if (looksFileMutationCommand(command)) {
		for (const token of extractPathTokens(command, true)) tokens.add(token);
	}
	return [...tokens];
}

export function looksMutatingBash(command: string): boolean {
	return looksFileMutationCommand(command)
		|| /(^|[;&|()\s])(?:python|python3|node|npm|pnpm|yarn|make|lualatex|latexmk|git\s+(?:add|commit|push|reset|checkout|switch|merge|rebase|stash|clean))\b/.test(command)
		|| /(^|[^<])>{1,2}\s*[^&]/.test(command);
}

export function looksRecursiveTraversalCommand(command: string): boolean {
	return /\bgrep\b[\s\S]*(?:\s-[A-Za-z]*r[A-Za-z]*\b|\s--(?:dereference-)?recursive\b)/i.test(command)
		|| /\b(?:rg|ripgrep|fd|find|tree)\b/i.test(command)
		|| /\bls\b[\s\S]*(?:\s-[A-Za-z]*R[A-Za-z]*\b|\s--recursive\b)/.test(command);
}
