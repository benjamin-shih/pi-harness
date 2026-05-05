import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

const ENTRYPOINT_EXTENSIONS = new Set([".ts", ".js"]);

function packageManifestEntrypoints(fullDir, relativeDir) {
	const packageJson = join(fullDir, "package.json");
	if (!existsSync(packageJson)) return undefined;
	try {
		const manifest = JSON.parse(readFileSync(packageJson, "utf8"));
		return (manifest.pi?.extensions ?? [])
			.map((entryPath) => join(relativeDir, entryPath))
			.filter((entryPath) => existsSync(join(fullDir, relative(relativeDir, entryPath))));
	} catch {
		return [];
	}
}

function directoryEntrypoint(root, relativeDir, fullDir) {
	const manifestEntries = packageManifestEntrypoints(fullDir, relativeDir);
	if (manifestEntries) return manifestEntries;
	for (const indexFile of ["index.ts", "index.js"]) {
		const indexPath = join(relativeDir, indexFile);
		if (existsSync(join(root, indexPath))) return [indexPath];
	}
	return [];
}

export function extensionEntrypoints(root, options = {}) {
	const entries = readdirSync(join(root, "extensions"), { withFileTypes: true })
		.flatMap((entry) => {
			const relativeDir = join("extensions", entry.name);
			const full = join(root, relativeDir);
			if (entry.isFile() && ENTRYPOINT_EXTENSIONS.has(extname(entry.name))) return [relativeDir];
			if (!entry.isDirectory()) return [];
			return directoryEntrypoint(root, relativeDir, full);
		})
		.sort();
	return options.absolute ? entries.map((entry) => join(root, entry)) : entries;
}
