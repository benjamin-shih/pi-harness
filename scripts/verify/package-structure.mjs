import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, extensionEntrypoints, loadExtension, readJson, root, fail } from "./harness.mjs";

export function runPackageStructureTests() {
	const packageJson = readJson("package.json");
	if (packageJson) {
		for (const key of ["extensions", "prompts", "themes"]) {
			const entries = packageJson.pi?.[key];
			assert(Array.isArray(entries) && entries.length > 0, `package.json pi.${key} must be a non-empty array`);
			for (const entry of entries ?? []) {
				const resolved = join(root, entry);
				assert(existsSync(resolved), `package.json pi.${key} path does not exist: ${entry}`);
			}
		}
	}

	for (const theme of readdirSync(join(root, "themes")).filter((file) => file.endsWith(".json"))) {
		const data = readJson(join("themes", theme));
		assert(Boolean(data?.name), `${theme} is missing a theme name`);
		assert(Boolean(data?.colors && typeof data.colors === "object"), `${theme} is missing colors`);
	}

	for (const prompt of readdirSync(join(root, "prompts")).filter((file) => file.endsWith(".md"))) {
		const text = readFileSync(join(root, "prompts", prompt), "utf8");
		assert(text.startsWith("---\n"), `${prompt} is missing frontmatter`);
		assert(/^description:\s*.+$/m.test(text), `${prompt} is missing a description`);
	}

	for (const dep of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
		assert(Boolean(packageJson?.peerDependencies?.[dep]), `missing peerDependency ${dep}`);
		assert(!packageJson?.dependencies?.[dep], `${dep} should not be bundled in dependencies`);
	}

	const extensionEntries = extensionEntrypoints();
	assert(extensionEntries.includes(join("extensions", "ui-polish", "index.ts")), "verify should discover directory-style ui-polish extension");

	for (const extension of extensionEntries) {
		try {
			loadExtension(extension);
		} catch (error) {
			fail(`${extension} failed to load: ${error.stack ?? error.message}`);
		}
	}
}
