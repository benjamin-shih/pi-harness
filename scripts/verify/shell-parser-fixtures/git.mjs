export const mutatingGitFixtures = [
	"git -C ~/.ssh add config",
	"/usr/bin/git add .",
	"git -C \"\" add .",
	"git --git-dir .git --work-tree $HOME/repo add .",
	"git --work-tree=$HOME/repo --git-dir=$HOME/repo/.git add .",
	"git -c user.name=test commit -m ok",
	"git -C \"$HOME\"/repo add .",
	"git push origin main",
	"git status && git add .",
	"git log --grep commit; git push",
	"command git add .",
	"env FOO=bar bash -c 'git add .'",
	"bash -lc 'git status && git add .'",
	"/bin/bash -lc '/usr/bin/git add .'",
	"bash --norc -c 'git add .'",
	"bash -O extglob -c 'git add .'",
	"bash +O extglob -c 'git add .'",
	"bash -o pipefail -c 'git commit -am test'",
	"bash -euo pipefail -c 'git add .'",
	"zsh -fc 'git push'",
	"sh -c 'git push'",
];

export const readOnlyGitFixtures = [
	"git log --grep commit",
	"git diff -- README.md | grep add",
	"git show HEAD:README.md",
	"git -C repo status --short",
	"git config --get remote.origin.url",
	"bash -lc 'git diff -- README.md | grep add'",
	"grep \"git add .\" README.md",
];

export const parsedGitFixtures = [
	{
		command: "git -C $HOME -C repo add .",
		expected: { cwd: "$HOME/repo", subcommand: "add" },
		description: "compose repeated git -C cwd segments",
	},
	{
		command: "cd $HOME/repo && git add .",
		expected: { cwd: "$HOME/repo", subcommand: "add" },
		description: "carry simple cd cwd into following git command",
	},
	{
		command: "cd ~/repo; git -C subdir commit -m test",
		expected: { cwd: "~/repo/subdir", subcommand: "commit" },
		description: "compose cd cwd with later git -C segment",
	},
	{
		command: "git --work-tree=$HOME/repo --git-dir=$HOME/repo/.git add .",
		expected: { cwd: "$HOME/repo", subcommand: "add" },
		description: "honor inline git work-tree option",
	},
	{
		command: "bash -lc 'git -C repo add .'",
		expected: { cwd: "repo", subcommand: "add" },
		description: "parse git command inside shell -c wrapper",
	},
];
