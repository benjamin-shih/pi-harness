export const recursiveTraversalFixtures = [
	"grep -R needle .",
	"grep --recursive needle .",
	"grep --dereference-recursive needle .",
	"find . -type f",
	"fd token .",
	"tree ~/.config",
	"ls -R .",
	"ls --recursive .",
	"rg needle .",
	"ripgrep token $HOME/.config",
];
