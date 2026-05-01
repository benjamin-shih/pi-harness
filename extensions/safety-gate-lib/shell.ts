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
function extractRedirectionTargetWords(command: string, operators: Set<">" | "<">): string[] {
	const targets: string[] = [];
	let current = "";
	let quote: "'" | '"' | "" = "";
	let expectingTarget = false;
	let collectingTarget = false;
	const finishTarget = () => {
		const token = collectingTarget ? cleanPathToken(current) : "";
		if (token) targets.push(token);
		current = "";
		expectingTarget = false;
		collectingTarget = false;
	};
	const startTarget = (operator: ">" | "<") => {
		current = "";
		expectingTarget = true;
		collectingTarget = operators.has(operator);
	};
	for (let index = 0; index < command.length; index++) {
		const char = command[index] ?? "";
		if (quote) {
			if (char === quote) quote = "";
			else if (expectingTarget) current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if ((char === "<" || char === ">") && command[index + 1] === "(") {
			if (current) finishTarget();
			expectingTarget = false;
			collectingTarget = false;
			current = "";
			index++;
			continue;
		}
		if (char === "<" && command[index + 1] === "<") {
			if (current) finishTarget();
			expectingTarget = false;
			collectingTarget = false;
			current = "";
			while (command[index + 1] === "<" || command[index + 1] === "-") index++;
			continue;
		}
		if ((char === ">" || char === "<") && !expectingTarget) {
			startTarget(char);
			while (command[index + 1] === ">" || command[index + 1] === "&") index++;
			continue;
		}
		if (!expectingTarget) continue;
		if (char === ">" || char === "<") {
			if (current) finishTarget();
			startTarget(char);
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
	while (shellBasename(words[index] ?? "") === "command") index++;
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
function processSubstitutionCommands(command: string): string[] {
	const commands: string[] = [];
	let quote: "'" | '"' | "" = "";
	for (let index = 0; index < command.length - 1; index++) {
		const char = command[index] ?? "";
		if (quote) {
			if (char === quote) quote = "";
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (char === "\\") {
			index++;
			continue;
		}
		if (char !== "<" || command[index + 1] !== "(") continue;
		let inner = "";
		let depth = 1;
		let innerQuote: "'" | '"' | "" = "";
		index += 2;
		for (; index < command.length; index++) {
			const innerChar = command[index] ?? "";
			if (innerQuote) {
				if (innerChar === innerQuote) innerQuote = "";
				inner += innerChar;
				continue;
			}
			if (innerChar === "'" || innerChar === '"') {
				innerQuote = innerChar;
				inner += innerChar;
				continue;
			}
			if (innerChar === "(") depth++;
			if (innerChar === ")" && --depth === 0) break;
			inner += innerChar;
		}
		if (inner.trim()) commands.push(inner.trim());
	}
	return commands;
}
export function extractInputPathTokens(command: string, depth = 0): string[] {
	const tokens = new Set(extractRedirectionTargetWords(command, new Set(["<"])));
	if (depth < 2) {
		for (const innerCommand of processSubstitutionCommands(command)) {
			for (const token of extractPathTokens(innerCommand)) tokens.add(token);
			for (const token of extractInputPathTokens(innerCommand, depth + 1)) tokens.add(token);
		}
		for (const segment of commandSegments(command)) {
			const wrappedCommand = shellWrappedCommand(shellWords(segment), depth);
			if (wrappedCommand) {
				for (const token of extractInputPathTokens(wrappedCommand, depth + 1)) tokens.add(token);
			}
		}
	}
	return [...tokens];
}
export function extractOutputPathTokens(command: string, depth = 0): string[] {
	const tokens = new Set(extractRedirectionTargetWords(command, new Set([">"])));
	if (depth < 2) {
		for (const segment of commandSegments(command)) {
			const wrappedCommand = shellWrappedCommand(shellWords(segment), depth);
			if (wrappedCommand) {
				for (const token of extractOutputPathTokens(wrappedCommand, depth + 1)) tokens.add(token);
			}
		}
	}
	return [...tokens];
}
function addPathTokens(tokens: Set<string>, raw: string): void {
	for (const token of extractPathTokens(raw, true)) tokens.add(token);
}
export function extractCopyMoveSourcePathTokens(command: string, depth = 0): string[] {
	const tokens = new Set<string>();
	for (const segment of commandSegments(command)) {
		const words = commandWordsAfterPrefixes(shellWords(segment));
		const wrappedCommand = depth < 2 ? shellWrappedCommand(words, depth) : undefined;
		if (wrappedCommand) {
			for (const token of extractCopyMoveSourcePathTokens(wrappedCommand, depth + 1)) tokens.add(token);
		}
		const commandName = shellBasename(words[0] ?? "");
		if (commandName !== "cp" && commandName !== "mv") continue;
		const operands: string[] = [];
		let targetDirectoryMode = false;
		for (let index = 1; index < words.length; index++) {
			const word = words[index] ?? "";
			if (word === "--") {
				operands.push(...words.slice(index + 1));
				break;
			}
			if (word === "-t" || word === "--target-directory") {
				targetDirectoryMode = true;
				index++;
				continue;
			}
			if (word.startsWith("--target-directory=")) {
				targetDirectoryMode = true;
				continue;
			}
			if (/^-[^-].*t/.test(word)) {
				targetDirectoryMode = true;
				const afterTargetOption = word.slice(word.indexOf("t") + 1);
				if (!afterTargetOption) index++;
				continue;
			}
			if (word.startsWith("-")) continue;
			operands.push(word);
		}
		const sources = targetDirectoryMode ? operands : operands.slice(0, -1);
		for (const source of sources) {
			const token = cleanPathToken(source);
			if (token) tokens.add(token);
		}
	}
	return [...tokens];
}
function addRecursiveSourceToken(tokens: Set<string>, raw: string): void {
	if (raw === "*" || raw === "./*") {
		tokens.add(".");
		return;
	}
	if (raw.endsWith("/*")) raw = raw.slice(0, -2) || ".";
	const token = cleanPathToken(raw);
	if (token) tokens.add(token);
}
function recursiveCpSources(words: string[]): string[] {
	if (shellBasename(words[0] ?? "") !== "cp") return [];
	const recursive = words.some((word) => word === "--recursive" || word === "--archive" || (/^-[^-]/.test(word) && /[Rra]/.test(word.slice(1))));
	if (!recursive) return [];
	const operands: string[] = [];
	let targetDirectoryMode = false;
	for (let index = 1; index < words.length; index++) {
		const word = words[index] ?? "";
		if (word === "--") {
			operands.push(...words.slice(index + 1));
			break;
		}
		if (word === "-t" || word === "--target-directory") {
			targetDirectoryMode = true;
			index++;
			continue;
		}
		if (word.startsWith("--target-directory=") || /^-[^-].*t/.test(word)) {
			targetDirectoryMode = true;
			continue;
		}
		if (word.startsWith("-")) continue;
		operands.push(word);
	}
	return targetDirectoryMode ? operands : operands.slice(0, -1);
}
function tarSourceFromDirectory(directory: string | undefined, source: string): string {
	if (!directory || source.startsWith("/") || source === "~" || source.startsWith("~/") || source === "$HOME" || source.startsWith("$HOME/") || source === "${HOME}" || source.startsWith("${HOME}/")) return source;
	if (source === ".") return directory;
	return `${directory.replace(/\/+$/, "")}/${source}`;
}
function tarSources(words: string[]): string[] {
	if (shellBasename(words[0] ?? "") !== "tar") return [];
	const sources: string[] = [];
	let expectingArchive = false;
	let expectingDirectory = false;
	let directory: string | undefined;
	let createsArchive = false;
	let extractsOrLists = false;
	for (let index = 1; index < words.length; index++) {
		const word = words[index] ?? "";
		if (word === "--") {
			sources.push(...words.slice(index + 1).map((source) => tarSourceFromDirectory(directory, source)));
			break;
		}
		if (expectingDirectory) {
			directory = word;
			expectingDirectory = false;
			continue;
		}
		if (expectingArchive) {
			expectingArchive = false;
			continue;
		}
		if (word === "-C" || word === "--directory") {
			expectingDirectory = true;
			continue;
		}
		if (word.startsWith("--directory=")) {
			directory = word.slice("--directory=".length);
			continue;
		}
		if (word === "-f" || word === "--file") {
			expectingArchive = true;
			continue;
		}
		if (word.startsWith("--file=")) continue;
		if (["--create", "--append", "--update", "--concatenate"].includes(word)) {
			createsArchive = true;
			continue;
		}
		if (["--extract", "--get", "--list"].includes(word)) {
			extractsOrLists = true;
			continue;
		}
		if (index === 1 && /^[A-Za-z]+$/.test(word)) {
			createsArchive ||= /[cruA]/.test(word);
			extractsOrLists ||= /[xt]/.test(word);
			expectingArchive = word.includes("f") && word.endsWith("f");
			continue;
		}
		if (/^-[^-]/.test(word)) {
			const options = word.slice(1);
			createsArchive ||= /[cruA]/.test(options);
			extractsOrLists ||= /[xt]/.test(options);
			if (options.includes("C") && options.endsWith("C")) expectingDirectory = true;
			if (options.includes("f")) {
				const afterArchiveFlag = word.slice(word.indexOf("f") + 1);
				expectingArchive = !afterArchiveFlag;
			}
			continue;
		}
		if (word.startsWith("-")) continue;
		sources.push(tarSourceFromDirectory(directory, word));
	}
	return createsArchive && !extractsOrLists ? sources : [];
}
function zipSources(words: string[]): string[] {
	if (shellBasename(words[0] ?? "") !== "zip") return [];
	if (!words.some((word) => word === "--recurse-paths" || (/^-[^-]/.test(word) && word.slice(1).includes("r")))) return [];
	const operands = words.slice(1).filter((word) => word !== "--" && !word.startsWith("-"));
	return operands.slice(1);
}
function trailingDestinationSources(words: string[], commands: Set<string>): string[] {
	const command = shellBasename(words[0] ?? "");
	if (!commands.has(command)) return [];
	const start = command === "rclone" && ["copy", "sync", "move"].includes(words[1] ?? "") ? 2 : 1;
	const operands = words.slice(start).filter((word) => word !== "--" && !word.startsWith("-"));
	return operands.slice(0, -1).filter((word) => !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(word));
}
export function extractRecursiveEgressSourcePathTokens(command: string, depth = 0): string[] {
	const tokens = new Set<string>();
	for (const segment of commandSegments(command)) {
		const words = commandWordsAfterPrefixes(shellWords(segment));
		const wrappedCommand = depth < 2 ? shellWrappedCommand(words, depth) : undefined;
		if (wrappedCommand) {
			for (const token of extractRecursiveEgressSourcePathTokens(wrappedCommand, depth + 1)) tokens.add(token);
		}
		for (const source of [
			...recursiveCpSources(words),
			...tarSources(words),
			...zipSources(words),
			...trailingDestinationSources(words, new Set(["rsync", "rclone"])),
		]) {
			addRecursiveSourceToken(tokens, source);
		}
	}
	return [...tokens];
}
export function extractWritePathTokens(command: string): string[] {
	const tokens = new Set(extractOutputPathTokens(command));
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
