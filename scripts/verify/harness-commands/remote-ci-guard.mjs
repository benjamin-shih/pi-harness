import { loadExtensionModule } from "../harness.mjs";
import { assert, root } from "./support.mjs";

function ok(stdout = "") {
	return { code: 0, stdout, stderr: "", killed: false };
}

function fail(stderr = "failed") {
	return { code: 1, stdout: "", stderr, killed: false };
}

function fakePi(handler) {
	const calls = [];
	return {
		calls,
		pi: {
			exec: async (cmd, args, options) => {
				calls.push({ cmd, args, options });
				return handler(cmd, args, options, calls) ?? fail();
			},
		},
	};
}

function listRun(run) {
	return JSON.stringify([run]);
}

export async function runRemoteCiGuardTests() {
	const guard = loadExtensionModule("extensions/shared/remote-ci-guard.ts");
	assert(guard.isGitPushCommand("git push"), "remote CI guard should detect plain git push");
	assert(guard.isGitPushCommand("git add . && git commit -m x && git push"), "remote CI guard should detect chained plain git push");
	assert(!guard.isGitPushCommand("git status && echo push"), "remote CI guard should not trigger on prose or non-push git commands");

	const passed = fakePi((cmd, args) => {
		if (cmd === "git" && args.join(" ") === "rev-parse HEAD") return ok("HEAD1\n");
		if (cmd === "git" && args.join(" ") === "remote -v") return ok("origin\thttps://github.com/example/repo.git (fetch)\norigin\thttps://github.com/example/repo.git (push)\n");
		if (cmd === "gh" && args[0] === "run" && args[1] === "list") return ok(JSON.stringify([
			{ databaseId: 99, status: "completed", conclusion: "failure", headSha: "OLD_HEAD", name: "CI" },
			{ databaseId: 101, status: "completed", conclusion: "success", headSha: "HEAD1", name: "CI" },
		]));
	});
	const passedResult = await guard.checkRemoteCiAfterPush(passed.pi, root);
	assert(passedResult.state === "passed" && passedResult.runId === "101", "remote CI guard should pass completed successful GitHub runs");
	assert(!passed.calls.some((call) => call.cmd === "gh" && call.args.includes("watch")), "remote CI guard should not watch already-completed runs");

	let listCount = 0;
	const watched = fakePi((cmd, args) => {
		if (cmd === "git" && args.join(" ") === "rev-parse HEAD") return ok("HEAD2\n");
		if (cmd === "git" && args.join(" ") === "remote -v") return ok("origin\tgit@github.com:example/repo.git (fetch)\norigin\tgit@github.com:example/repo.git (push)\n");
		if (cmd === "gh" && args[0] === "run" && args[1] === "list") {
			listCount += 1;
			return ok(listRun({ databaseId: 202, status: listCount === 1 ? "in_progress" : "completed", conclusion: listCount === 1 ? "" : "success", headSha: "HEAD2", name: "CI" }));
		}
		if (cmd === "gh" && args.join(" ") === "run watch 202 --exit-status") return ok("done\n");
	});
	const watchedResult = await guard.checkRemoteCiAfterPush(watched.pi, root);
	assert(watchedResult.state === "passed" && watched.calls.some((call) => call.cmd === "gh" && call.args.includes("watch")), "remote CI guard should watch active runs and pass after success");

	const failed = fakePi((cmd, args) => {
		if (cmd === "git" && args.join(" ") === "rev-parse HEAD") return ok("HEAD3\n");
		if (cmd === "git" && args.join(" ") === "remote -v") return ok("origin\thttps://github.com/example/repo.git (fetch)\n");
		if (cmd === "gh" && args[0] === "run" && args[1] === "list") return ok(listRun({ databaseId: 303, status: "completed", conclusion: "failure", headSha: "HEAD3", name: "CI" }));
	});
	const failedResult = await guard.checkRemoteCiAfterPush(failed.pi, root);
	assert(failedResult.state === "failed" && guard.remoteCiGuardBlock(failedResult)?.includes("Remote CI did not pass"), "remote CI guard should block failed completed runs");

	const skipped = fakePi((cmd, args) => {
		if (cmd === "git" && args.join(" ") === "rev-parse HEAD") return ok("HEAD4\n");
		if (cmd === "git" && args.join(" ") === "remote -v") return ok("origin\tssh://git.example.invalid/repo.git (fetch)\n");
	});
	const skippedResult = await guard.checkRemoteCiAfterPush(skipped.pi, root);
	assert(skippedResult.state === "skipped" && !skipped.calls.some((call) => call.cmd === "gh"), "remote CI guard should skip non-GitHub remotes without calling gh");
}
