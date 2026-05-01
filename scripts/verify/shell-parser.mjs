import { assert, loadExtensionModule } from "./harness.mjs";

export function runShellParserTests() {
	const shell = loadExtensionModule("extensions/safety-gate-lib/shell.ts");
	for (const [command, expected] of [
		["printf ok>./out.txt", "./out.txt"],
		["echo ok 2>../err.log", "../err.log"],
		["cat < ~/.ssh/config", "~/.ssh/config"],
		["tee .env", ".env"],
	]) {
		assert(shell.extractWritePathTokens(command).includes(expected), `shell parser should extract write/redirection target ${expected}`);
	}
	for (const [command, expected] of [
		["node ./scripts/foo.js", "./scripts/foo.js"],
		["cat $HOME/.ssh/config", "$HOME/.ssh/config"],
		["rg token ~/.config/gh", "~/.config/gh"],
	]) {
		assert(shell.extractPathTokens(command).includes(expected), `shell parser should extract path token ${expected}`);
	}
	for (const command of ["grep -R needle .", "find . -type f", "ls -R .", "rg needle ."]) {
		assert(shell.looksRecursiveTraversalCommand(command), `shell parser should detect recursive traversal: ${command}`);
	}
}
