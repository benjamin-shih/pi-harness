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

function commandWordsAfterPrefixes(words: string[]): string[] {
	let index = 0;
	while (shellBasename(words[index] ?? "") === "command") index++;
	if (shellBasename(words[index] ?? "") === "env") {
		index++;
		while (index < words.length) {
			const word = words[index] ?? "";
			if (word === "--") {
				index++;
				break;
			}
			if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || ["-i", "-", "-0", "--ignore-environment", "--null", "--debug", "--list-signal-handling"].includes(word)) {
				index++;
				continue;
			}
			if (word === "-S" || word === "--split-string") return [...shellWords(words[index + 1] ?? ""), ...words.slice(index + 2)];
			if (word.startsWith("-S") && word.length > 2) return [...shellWords(word.slice(2)), ...words.slice(index + 1)];
			if (word.startsWith("--split-string=")) return [...shellWords(word.slice("--split-string=".length)), ...words.slice(index + 1)];
			if (["-u", "--unset", "-C", "--chdir", "--argv0"].includes(word)) {
				index += 2;
				continue;
			}
			if (word.startsWith("-u") || word.startsWith("-C") || word.startsWith("--unset=") || word.startsWith("--chdir=") || word.startsWith("--argv0=") || word.startsWith("--ignore-signal") || word.startsWith("--default-signal") || word.startsWith("--block-signal")) {
				index++;
				continue;
			}
			break;
		}
	}
	return words.slice(index);
}

function shellWrappedCommand(words: string[], depth: number): string | undefined {
	const commandWords = commandWordsAfterPrefixes(words);
	if (depth >= 2 || !/^(?:bash|sh|zsh)$/.test(shellBasename(commandWords[0] ?? ""))) return undefined;
	let optionIndex = 1;
	while (optionIndex < commandWords.length - 1) {
		const option = commandWords[optionIndex] ?? "";
		if (!option.startsWith("-") && !option.startsWith("+")) break;
		const shortOptionHasCommand = /^-[^-]/.test(option) && option.slice(1).includes("c");
		if (option === "-c" || shortOptionHasCommand) return commandWords[optionIndex + 1];
		if ((/^-[^-]/.test(option) && option.slice(1).includes("o")) || option === "-o" || option === "-O" || option === "+O" || option === "--rcfile" || option === "--init-file") {
			optionIndex += 2;
			continue;
		}
		optionIndex++;
	}
	return undefined;
}

function hasSedInPlaceEditOption(words: string[]): boolean {
	for (let index = 1; index < words.length; index++) {
		const word = words[index] ?? "";
		if (word === "--") return false;
		if (!word.startsWith("-") || word === "-") return false;
		if (word === "--in-place" || word.startsWith("--in-place=") || /^-[A-Za-z]*i[A-Za-z]*(?:\..*)?$/.test(word)) return true;
		if (["-e", "-f", "--expression", "--file"].includes(word)) index++;
	}
	return false;
}

function hasPerlInPlaceEditOption(words: string[]): boolean {
	for (let index = 1; index < words.length; index++) {
		const word = words[index] ?? "";
		if (word === "--") return false;
		if (!word.startsWith("-") || word === "-") return false;
		if (["-e", "-E", "-M", "-m", "-I"].includes(word)) {
			index++;
			continue;
		}
		let consumesAttachedArgument = false;
		for (const char of word.slice(1)) {
			if (char === "i") return true;
			if (["e", "E", "M", "m", "I"].includes(char)) {
				consumesAttachedArgument = true;
				break;
			}
		}
		if (consumesAttachedArgument) continue;
	}
	return false;
}

function hasInPlaceEditOption(words: string[]): boolean {
	const commandWords = commandWordsAfterPrefixes(words);
	const command = shellBasename(commandWords[0] ?? "");
	if (command === "sed") return hasSedInPlaceEditOption(commandWords);
	if (command === "perl") return hasPerlInPlaceEditOption(commandWords);
	return false;
}

function looksFileMutationCommand(command: string, depth = 0): boolean {
	if (/(^|[;&|()\s])(?:rm|mv|cp|touch|mkdir|rmdir|tee)\b/.test(command)) return true;
	for (const segment of commandSegments(command)) {
		const words = shellWords(segment);
		if (hasInPlaceEditOption(words)) return true;
		const wrappedCommand = shellWrappedCommand(words, depth);
		if (wrappedCommand && looksFileMutationCommand(wrappedCommand, depth + 1)) return true;
	}
	return false;
}

export function extractWritePathTokens(command: string): string[] {
	const tokens = new Set(extractRedirectionTargetWords(command));
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
