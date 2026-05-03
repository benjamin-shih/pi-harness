import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function withPrivateTempTextFile<T>(prefix: string, content: string, callback: (path: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	const file = join(dir, "input.txt");
	try {
		await writeFile(file, content, { encoding: "utf8", mode: 0o600 });
		return await callback(file);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
