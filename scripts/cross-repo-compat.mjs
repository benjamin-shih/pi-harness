import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function runJson(command, args, options = {}) {
	const stdout = execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: options.timeout ?? 10_000, cwd: options.cwd, env: options.env });
	return JSON.parse(stdout);
}

const agentsRoot = resolve(process.env.AGENTS_SHARED_ROOT || join(homedir(), ".agents"));
const scripts = join(agentsRoot, "scripts");
assert(existsSync(join(scripts, "task-api.sh")), "AGENTS_SHARED_ROOT must point to a .agents checkout");

const tempRoot = mkdtempSync(join(tmpdir(), "pi-cross-repo-compat-"));
try {
	const project = join(tempRoot, "project");
	const tasksRoot = join(tempRoot, "tasks");
	const memoryRoot = join(tempRoot, "memory");
	const settings = join(tempRoot, "pi-settings.json");
	const approvals = join(tempRoot, "pi-approvals.json");
	mkdirSync(project, { recursive: true });
	writeFileSync(join(project, "AGENTS.md"), "# compat project\n");
	writeFileSync(settings, JSON.stringify({ packages: [] }) + "\n");
	writeFileSync(approvals, JSON.stringify({ version: 1, policy: { default_action: "deny", requires_exact_pins: true, runtime_network_checks: false }, approved: [] }) + "\n");
	const env = { ...process.env, AGENTS_SHARED_ROOT: agentsRoot, TASKS_ROOT: tasksRoot, AGENTS_TASKS_ROOT: tasksRoot, AGENTS_MEMORY_ROOT: memoryRoot, PI_SETTINGS_PATH: settings, AGENTS_PI_PACKAGE_APPROVALS: approvals };

	const info = runJson("bash", [join(scripts, "task-api.sh"), "info"], { env, cwd: project });
	assert(info.task_api_version === 1, "task API version should be v1");
	assert(info.capabilities?.includes("task_close"), "task API should advertise task_close");

	execFileSync("bash", [join(scripts, "task-init.sh"), "compat-task", "--runtime", "pi", "--owner", "tester", "--cwd", project], { env, cwd: project, stdio: "ignore" });
	const reasonFile = join(tempRoot, "close-reason.txt");
	writeFileSync(reasonFile, "compat close\n", { mode: 0o600 });
	const closed = runJson("bash", [join(scripts, "task-close.sh"), "compat-task", "completed", "--reason-file", reasonFile, "--runtime", "pi", "--owner", "tester"], { env, cwd: project });
	assert(closed.status === "completed", "task-close should close temp task");

	const promptFile = join(tempRoot, "prompt.txt");
	writeFileSync(promptFile, "Prepare a source-backed implementation brief\n", { mode: 0o600 });
	const decision = runJson("bash", [join(scripts, "orchestration-decision.sh"), "--prompt-file", promptFile, "--cwd", project, "--json"], { env, cwd: project });
	assert(decision.orchestration_api_version === 1 && decision.read_only === true, "orchestration decision should be read-only v1");
	assert(decision.artifacts?.html?.long_response?.enabled === true, "orchestration decision should expose long-response HTML policy");
	const safePath = runJson("bash", [join(scripts, "path-safety.sh"), "--path", "AGENTS.md", "--cwd", project, "--operation", "read"], { env, cwd: project });
	assert(safePath.policy_api_version === 1 && safePath.action === "allow", "path safety should allow normal project files");
	const protectedPath = runJson("bash", [join(scripts, "path-safety.sh"), "--path", "~/.ssh", "--cwd", project, "--operation", "egress", "--recursive"], { env, cwd: project });
	assert(protectedPath.policy_api_version === 1 && protectedPath.allowed === false && protectedPath.action === "block", "path safety should block protected recursive egress paths");
	const htmlPolicy = runJson("bash", [join(scripts, "html-artifact-policy.sh"), "--shape", "general", "--complexity", "standard", "--risk", "low", "--project-type", "repo", "--json"], { env, cwd: project });
	assert(htmlPolicy.decision?.long_response?.enabled === true, "HTML policy should expose long-response guidance");
	assert(htmlPolicy.decision?.recommended?.some((item) => item.mode === "html_report"), "HTML policy should recommend reports for long standard responses");

	const htmlData = join(tempRoot, "html-data.json");
	const htmlOut = join(tempRoot, "brief.html");
	writeFileSync(htmlData, JSON.stringify({ title: "Compat Brief", summary: "Flexible sections", sections: [{ title: "Result", body: "Pass" }] }) + "\n");
	const render = runJson("bash", [join(scripts, "html-artifact-render.sh"), "--template", "report", "--data", htmlData, "--out", htmlOut, "--json"], { env, cwd: project });
	assert(render.render_mode === "flexible_sections", "HTML renderer should support flexible section data");

	const stats = runJson("bash", [join(scripts, "memory-stats.sh"), "--include-global", "--cwd", project, "--json"], { env, cwd: project });
	assert(stats.memory_api_version === 1 && stats.scope?.global === true, "memory stats should support explicit global scope");
	const review = runJson("bash", [join(scripts, "memory-review.sh"), "--include-global", "--cwd", project, "--json"], { env, cwd: project });
	assert(review.memory_api_version === 1 && review.scope?.global === true, "memory review should support explicit global review");

	const packageDoctor = runJson("bash", [join(scripts, "pi-package-doctor.sh"), "--settings", settings, "--approvals", approvals], { env, cwd: project });
	assert(packageDoctor.pi_package_policy_api_version === 1, "pi package doctor should return v1 payload");

	console.log("cross-repo compat ok");
} finally {
	rmSync(tempRoot, { recursive: true, force: true });
}
