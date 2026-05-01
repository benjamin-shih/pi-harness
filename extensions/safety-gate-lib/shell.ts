const SHELL_COMMAND_WORD_RE = /^(?:cat|bat|less|more|head|tail|sed|awk|grep|egrep|fgrep|rg|ripgrep|strings|xxd|hexdump|base64|openssl|jq|python3?|node|ruby|perl|curl|wget|scp|sftp|rsync|rclone|git|aws|gh|make|npm|pnpm|yarn|tar|zip|unzip|xargs|cd)$/;

export function cleanPathToken(rawPath: string): string {
	return rawPath
		.trim()
		.replace(/^(?:\d?>+|&>|<+)/, "")
		.replace(/^@/, "")
		.replace(/^[\'"]|[\'"]$/g, "")
		.replace(/^\$\{HOME\}(?=\/|$)/, "$HOME")
		.replace(/[,:]+$/g, "");
}

function commandSegments(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: "'" | '"' | "" = "";
	for (let index = 0; index < command.length; index++) {
		const char = command[index] ?? "";
		if (quote) {
			if (char === quote) quote = "";
			current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			current += char;
			continue;
		}
		if (char === "\\" && index + 1 < command.length) {
			current += char + (command[index + 1] ?? "");
			index++;
			continue;
		}
		if (/[;&|()]/.test(char)) {
			if (current.trim()) segments.push(current.trim());
			current = "";
			continue;
		}
		current += char;
	}
	if (current.trim()) segments.push(current.trim());
	return segments;
}

function shellWords(command: string): string[] {
	const words: string[] = [];
	let current = "";
	let inWord = false;
	let quote: "'" | '"' | "" = "";
	for (let index = 0; index < command.length; index++) {
		const char = command[index] ?? "";
		if (quote) {
			if (char === quote) quote = "";
			else current += char;
			inWord = true;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			inWord = true;
			continue;
		}
		if (char === "\\" && index + 1 < command.length) {
			current += command[index + 1] ?? "";
			inWord = true;
			index++;
			continue;
		}
		if (/\s|[;&|()]/.test(char)) {
			if (inWord) words.push(current);
			current = "";
			inWord = false;
			continue;
		}
		current += char;
		inWord = true;
	}
	if (inWord) words.push(current);
	return words;
}

export function extractPathTokens(command: string, includePlainOperands = false): string[] {
	const tokens = new Set<string>();
	const quotedPathLikePatterns = [
		/"(@?(?:~|\$\{HOME\}|\$HOME|\.{1,2}|\/)[^"]+)"/g,
		/'(@?(?:~|\$\{HOME\}|\$HOME|\.{1,2}|\/)[^']+)'/g,
		/"(~|\$\{HOME\}|\$HOME|\.{1,2}|\/)"(\/[^\s"'`;&|)]+)/g,
		/'(~|\$\{HOME\}|\$HOME|\.{1,2}|\/)'(\/[^\s"'`;&|)]+)/g,
		/(~|\$\{HOME\}|\$HOME)"(\/[^"`;&|)]+)"/g,
		/(~|\$\{HOME\}|\$HOME)'(\/[^'`;&|)]+)'/g,
	];
	for (const pattern of quotedPathLikePatterns) {
		let quotedMatch: RegExpExecArray | null;
		while ((quotedMatch = pattern.exec(command))) {
			const token = cleanPathToken(`${quotedMatch[1] ?? ""}${quotedMatch[2] ?? ""}`);
			if (token) tokens.add(token);
		}
	}

	const pathLike = /(?:^|[\s"'`=:(])(@?(?:~|\$\{HOME\}|\$HOME|\.{1,2}|\/)[^\s"'`;&|)]+)/g;
	let match: RegExpExecArray | null;
	while ((match = pathLike.exec(command))) {
		const token = cleanPathToken(match[1] ?? "");
		if (token) tokens.add(token);
	}

	for (const token of [...shellWords(command), ...command.split(/\s+/)]) {
		const cleaned = cleanPathToken(token);
		if (!cleaned || cleaned.startsWith("-") || /^[A-Z_]+=/.test(cleaned) || /^[a-z]+:\/\//i.test(cleaned)) continue;
		if (SHELL_COMMAND_WORD_RE.test(cleaned)) continue;
		if (includePlainOperands || /[/~.$]|(?:env|rsa|ed25519|ecdsa|dsa|npmrc|pypirc|netrc|credentials?|secrets?|tokens?|wallet|private-key|service-account|auth\.json|\.pem|\.key|\.p12|\.pfx)$/i.test(cleaned)) tokens.add(cleaned);
	}

	return [...tokens];
}

function extractRedirectionTargetWords(command: string): string[] {
	const targets: string[] = [];
	let current = "";
	let quote: "'" | '"' | "" = "";
	let expectingTarget = false;
	const finishTarget = () => {
		const token = cleanPathToken(current);
		if (token) targets.push(token);
		current = "";
		expectingTarget = false;
	};
	for (let index = 0; index < command.length; index++) {
		const char = command[index] ?? "";
		if (quote) {
			if (char === quote) quote = "";
			else current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if ((char === ">" || char === "<") && !expectingTarget) {
			current = "";
			expectingTarget = true;
			while (command[index + 1] === ">" || command[index + 1] === "&") index++;
			continue;
		}
		if (!expectingTarget) continue;
		if (char === ">" || char === "<") {
			if (current) finishTarget();
			expectingTarget = true;
			while (command[index + 1] === ">" || command[index + 1] === "&") index++;
			continue;
		}
		if (/\s|[;&|)]/.test(char)) {
			if (current) finishTarget();
			continue;
		}
		current += char;
	}
	if (expectingTarget && current) finishTarget();
	return targets;
}

function extractRedirectionTargets(command: string): string[] {
	const targets = new Set<string>(extractRedirectionTargetWords(command));
	for (const pattern of [
		/(?:\d*(?:>>?|<)|&>)\s*"([^"]+)"/g,
		/(?:\d*(?:>>?|<)|&>)\s*'([^']+)'/g,
	]) {
		let quotedMatch: RegExpExecArray | null;
		while ((quotedMatch = pattern.exec(command))) {
			const token = cleanPathToken(quotedMatch[1] ?? "");
			if (token) targets.add(token);
		}
	}
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

export type ParsedGitCommand = { subcommand: string; args: string[]; cwd?: string };

function composeGitCwd(base: string | undefined, next: string | undefined): string | undefined {
	if (!next) return base;
	if (!base || next.startsWith("/") || next === "~" || next.startsWith("~/") || next === "$HOME" || next.startsWith("$HOME/") || next === "${HOME}" || next.startsWith("${HOME}/")) return next;
	return `${base.replace(/\/+$/, "")}/${next}`;
}

function shellBasename(commandWord: string): string {
	return commandWord.split("/").pop() ?? commandWord;
}

export function parseGitCommands(command: string, depth = 0): ParsedGitCommand[] {
	const commands: ParsedGitCommand[] = [];
	let segmentCwd: string | undefined;
	for (const segment of commandSegments(command)) {
		const words = shellWords(segment);
		if (words[0] === "cd" && words[1] !== undefined) {
			segmentCwd = composeGitCwd(segmentCwd, words[1]);
			continue;
		}
		for (let index = 0; index < words.length; index++) {
			if (/^(?:bash|sh|zsh)$/.test(shellBasename(words[index] ?? "")) && depth < 2) {
				let optionIndex = index + 1;
				while (optionIndex < words.length - 1) {
					const option = words[optionIndex] ?? "";
					if (!option.startsWith("-") && !option.startsWith("+")) break;
					const shortOptionHasCommand = /^-[^-]/.test(option) && option.slice(1).includes("c");
					if (option === "-c" || shortOptionHasCommand) {
						commands.push(...parseGitCommands(words[optionIndex + 1] ?? "", depth + 1));
						break;
					}
					if ((/^-[^-]/.test(option) && option.slice(1).includes("o")) || option === "-o" || option === "-O" || option === "+O" || option === "--rcfile" || option === "--init-file") {
						optionIndex += 2;
						continue;
					}
					optionIndex++;
				}
			}
			if (shellBasename(words[index] ?? "") !== "git") continue;
			let subcommandIndex = index + 1;
			let gitCwd: string | undefined = segmentCwd;
			while (subcommandIndex < words.length) {
				const word = words[subcommandIndex] ?? "";
				if (word === "-C") {
					gitCwd = composeGitCwd(gitCwd, words[subcommandIndex + 1]);
					subcommandIndex += 2;
					continue;
				}
				if (word === "--work-tree") {
					gitCwd = composeGitCwd(gitCwd, words[subcommandIndex + 1]);
					subcommandIndex += 2;
					continue;
				}
				if (word.startsWith("--work-tree=")) {
					gitCwd = composeGitCwd(gitCwd, word.slice("--work-tree=".length));
					subcommandIndex++;
					continue;
				}
				if (word === "-c" || word === "--git-dir") {
					subcommandIndex += 2;
					continue;
				}
				if (word.startsWith("--git-dir=") || word.startsWith("-")) {
					subcommandIndex++;
					continue;
				}
				commands.push({ subcommand: word, args: words.slice(subcommandIndex + 1), ...(gitCwd ? { cwd: gitCwd } : {}) });
				break;
			}
		}
	}
	return commands;
}

export function parseGitCommand(command: string): ParsedGitCommand | undefined {
	return parseGitCommands(command)[0];
}

function looksMutatingGitCommand(command: string): boolean {
	const mutating = new Set(["add", "commit", "push", "reset", "checkout", "switch", "merge", "rebase", "stash", "clean"]);
	return parseGitCommands(command).some((git) => mutating.has(git.subcommand));
}

export function looksMutatingBash(command: string): boolean {
	return looksFileMutationCommand(command)
		|| /(^|[;&|()\s])(?:python|python3|node|npm|pnpm|yarn|make|lualatex|latexmk)\b/.test(command)
		|| looksMutatingGitCommand(command)
		|| /(^|[^<])>{1,2}\s*[^&]/.test(command);
}

export function looksRecursiveTraversalCommand(command: string): boolean {
	return /\bgrep\b[\s\S]*(?:\s-[A-Za-z]*r[A-Za-z]*\b|\s--(?:dereference-)?recursive\b)/i.test(command)
		|| /\b(?:rg|ripgrep|fd|find|tree)\b/i.test(command)
		|| /\bls\b[\s\S]*(?:\s-[A-Za-z]*R[A-Za-z]*\b|\s--recursive\b)/.test(command);
}
