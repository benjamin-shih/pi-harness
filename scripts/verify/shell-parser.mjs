import { assert, loadExtensionModule } from "./harness.mjs";
import {
	copyMoveSourceFixtures,
	inputPathAbsentFixtures,
	inputPathFixtures,
	mutatingGitFixtures,
	mutatingShellFixtures,
	parsedGitFixtures,
	pathTokenFixtures,
	readOnlyGitFixtures,
	readOnlyShellMutationFixtures,
	recursiveTraversalFixtures,
	writePathTokenFixtures,
} from "./shell-parser-fixtures/index.mjs";

function assertIncludes(actual, expected, message) {
	assert(actual.includes(expected), message);
}

export function runShellParserTests() {
	const shell = loadExtensionModule("extensions/safety-gate-lib/shell.ts");

	for (const { command, expected } of copyMoveSourceFixtures) {
		assertIncludes(shell.extractCopyMoveSourcePathTokens(command), expected, `shell parser should extract copy/move source target ${expected}`);
	}

	for (const { command, absent } of inputPathAbsentFixtures) {
		assert(!shell.extractInputPathTokens(command).includes(absent), `shell parser should not inspect quoted process-substitution literal ${absent}`);
	}

	for (const { command, expected } of inputPathFixtures) {
		assertIncludes(shell.extractInputPathTokens(command), expected, `shell parser should extract input redirection target ${expected}`);
	}

	for (const { command, expected } of writePathTokenFixtures) {
		assertIncludes(shell.extractWritePathTokens(command), expected, `shell parser should extract write/redirection target ${expected}`);
	}

	for (const { command, expected } of pathTokenFixtures) {
		assertIncludes(shell.extractPathTokens(command), expected, `shell parser should extract path token ${expected}`);
	}

	for (const command of recursiveTraversalFixtures) {
		assert(shell.looksRecursiveTraversalCommand(command), `shell parser should detect recursive traversal: ${command}`);
	}

	for (const { command, expectedWriteTargets } of mutatingShellFixtures) {
		assert(shell.looksMutatingBash(command), `shell parser should detect mutating shell command: ${command}`);
		for (const expected of expectedWriteTargets) assertIncludes(shell.extractWritePathTokens(command), expected, `shell parser should extract mutating shell target ${expected}`);
	}

	for (const command of readOnlyShellMutationFixtures) {
		assert(!shell.looksMutatingBash(command), `shell parser should not treat read-only shell command as mutating: ${command}`);
		assert(shell.extractWritePathTokens(command).length === 0, `shell parser should not extract write targets from read-only shell command: ${command}`);
	}

	for (const command of mutatingGitFixtures) {
		assert(shell.looksMutatingBash(command), `shell parser should detect mutating git command: ${command}`);
	}

	for (const command of readOnlyGitFixtures) {
		assert(!shell.looksMutatingBash(command), `shell parser should not treat read-only git command as mutating: ${command}`);
	}

	for (const { command, expected, description } of parsedGitFixtures) {
		const parsed = shell.parseGitCommands(command);
		assert(parsed[0]?.cwd === expected.cwd && parsed[0]?.subcommand === expected.subcommand, `shell parser should ${description}`);
	}
}
