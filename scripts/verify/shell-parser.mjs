import { assert, loadExtensionModule } from "./harness.mjs";

export function runShellParserTests() {
	const shell = loadExtensionModule("extensions/safety-gate-lib/shell.ts");
	for (const [command, expected] of [
		["printf ok>./out.txt", "./out.txt"],
		["echo ok 2>../err.log", "../err.log"],
		["cat < ~/.ssh/config", "~/.ssh/config"],
		["printf ok > './out file.txt'", "./out file.txt"],
		["printf ok > \"$HOME\"/.ssh/config", "$HOME/.ssh/config"],
		["printf ok > $HOME\"/.ssh/config\"", "$HOME/.ssh/config"],
		["printf ok >./safe.txt>$HOME/.ssh/config", "$HOME/.ssh/config"],
		["tee .env", ".env"],
	]) {
		assert(shell.extractWritePathTokens(command).includes(expected), `shell parser should extract write/redirection target ${expected}`);
	}
	for (const [command, expected] of [
		["node ./scripts/foo.js", "./scripts/foo.js"],
		["cat $HOME/.ssh/config", "$HOME/.ssh/config"],
		["cat \"$HOME\"/.ssh/config", "$HOME/.ssh/config"],
		["cat $HOME\"/.ssh/config\"", "$HOME/.ssh/config"],
		["cat \"$HOME\"/.config/\"gh/hosts.yml\"", "$HOME/.config/gh/hosts.yml"],
		["cat \"${HOME}\"\"/.ssh/config\"", "$HOME/.ssh/config"],
		["cat '${HOME}/.ssh/config'", "$HOME/.ssh/config"],
		["cat './dir with spaces/key.pem'", "./dir with spaces/key.pem"],
		["bash -c 'cat ~/.ssh/config'", "~/.ssh/config"],
		["tar czf archive.tgz ~/.ssh", "~/.ssh"],
		["zip -r backup.zip '$HOME/.config/gh'", "$HOME/.config/gh"],
		["xargs -a ~/.ssh/config echo", "~/.ssh/config"],
		["rg token ~/.config/gh", "~/.config/gh"],
	]) {
		assert(shell.extractPathTokens(command).includes(expected), `shell parser should extract path token ${expected}`);
	}
	for (const command of ["grep -R needle .", "find . -type f", "ls -R .", "rg needle ."]) {
		assert(shell.looksRecursiveTraversalCommand(command), `shell parser should detect recursive traversal: ${command}`);
	}
	for (const command of ["git -C ~/.ssh add config", "/usr/bin/git add .", "git -C \"\" add .", "git --git-dir .git --work-tree $HOME/repo add .", "git push origin main", "git status && git add .", "git log --grep commit; git push", "bash -lc 'git status && git add .'", "/bin/bash -lc '/usr/bin/git add .'", "bash --norc -c 'git add .'", "bash -O extglob -c 'git add .'", "bash +O extglob -c 'git add .'", "bash -o pipefail -c 'git commit -am test'", "bash -euo pipefail -c 'git add .'", "sh -c 'git push'"]) {
		assert(shell.looksMutatingBash(command), `shell parser should detect mutating git command: ${command}`);
	}
	for (const command of ["git log --grep commit", "git diff -- README.md | grep add"]) {
		assert(!shell.looksMutatingBash(command), `shell parser should not treat read-only git command as mutating: ${command}`);
	}
	const repeatedC = shell.parseGitCommands("git -C $HOME -C repo add .");
	assert(repeatedC[0]?.cwd === "$HOME/repo" && repeatedC[0]?.subcommand === "add", "shell parser should compose repeated git -C cwd segments");
	const cdGit = shell.parseGitCommands("cd $HOME/repo && git add .");
	assert(cdGit[0]?.cwd === "$HOME/repo" && cdGit[0]?.subcommand === "add", "shell parser should carry simple cd cwd into following git commands");
	assert(shell.extractPathTokens("echo $(cat ~/.ssh/config)").includes("~/.ssh/config"), "shell parser should conservatively inspect command substitution text");
}
