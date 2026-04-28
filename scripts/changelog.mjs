import { execFileSync } from "node:child_process";

function git(args) {
	return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function tryGit(args) {
	try {
		return git(args);
	} catch {
		return "";
	}
}

const lastTag = tryGit(["describe", "--tags", "--abbrev=0"]);
const range = lastTag ? `${lastTag}..HEAD` : "HEAD";
const log = tryGit(["log", "--oneline", "--decorate=short", range]);
const version = process.argv[2] ?? "<version>";
const date = new Date().toISOString().slice(0, 10);

console.log(`# ${version} - ${date}`);
console.log();
console.log(`Range: ${lastTag || "initial history"}..HEAD`);
console.log();
console.log("## Added");
console.log("- None");
console.log();
console.log("## Changed");
if (log) {
	for (const line of log.split(/\r?\n/)) console.log(`- ${line}`);
} else {
	console.log("- None");
}
console.log();
console.log("## Fixed");
console.log("- None");
console.log();
console.log("## Breaking");
console.log("- None");
console.log();
console.log("Review and edit these notes before tagging a release.");
