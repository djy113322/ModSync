import path from "node:path";
import type { ILogger } from "@spt/models/spt/utils/ILogger";
import type { VFS } from "@spt/utils/VFS";
import type { Config, SyncPath } from "./config";
import { hashFile } from "./utility/imoHash";
import { HttpError, winPath } from "./utility/misc";
import { Semaphore } from "./utility/semaphore";

type ModFile = {
	hash: string;
	directory: boolean;
};

export class SyncUtil {
	private limiter = new Semaphore(1024);

	constructor(
		private vfs: VFS,
		private config: Config,
		private logger: ILogger,
	) {}

	private async getFilesInDir(baseDir: string, dir: string): Promise<string[]> {
		if (!this.vfs.exists(dir)) {
			this.logger.warning(
				`Corter-ModSync: Directory '${dir}' does not exist, will be ignored.`,
			);
			return [];
		}

		const stats = await this.vfs.statPromisify(dir);
		if (stats.isFile()) return [dir];

		const files: string[] = [];
		for (const fileName of this.vfs.getFiles(dir)) {
			const file = path.join(dir, fileName);

			if (this.config.isExcluded(file)) continue;

			files.push(file);
		}

		for (const dirName of this.vfs.getDirs(dir)) {
			const subDir = path.join(dir, dirName);

			if (this.config.isExcluded(subDir)) continue;

			const subFiles = await this.getFilesInDir(baseDir, subDir);
			if (
				this.vfs.getFiles(subDir).length === 0 &&
				this.vfs.getDirs(subDir).length === 0
			)
				files.push(subDir);

			files.push(...subFiles);
		}

		if (
			stats.isDirectory() &&
			this.vfs.getFiles(dir).length === 0 &&
			this.vfs.getDirs(dir).length === 0
		)
			files.push(dir);

		return files;
	}

	private async getModFilesInDir(baseDir: string, dir: string, remoteUserPath: string) : Promise<string[]> {
		if (!this.vfs.exists(dir)) {
			this.logger.warning(
				`Corter-ModSync: Mod Directory '${dir}' does not exist, will be ignored.`,
			);
			return [];
		}

		const stats = await this.vfs.statPromisify(dir);
		if (stats.isFile()) return [dir];

		const files: string[] = [];
		for (const fileName of this.vfs.getFiles(dir)) {
			const file = path.join(dir, fileName);

			if (this.config.isModExcluded(file, remoteUserPath)) {
				this.logger.info(`excluded file is ${file}`);
				continue;
			}

			files.push(file);
		}

		for (const dirName of this.vfs.getDirs(dir)) {
			const subDir = path.join(dir, dirName);

			if (this.config.isModExcluded(subDir, remoteUserPath)) continue;

			const subFiles = await this.getFilesInDir(baseDir, subDir);
			if (
				this.vfs.getFiles(subDir).length === 0 &&
				this.vfs.getDirs(subDir).length === 0
			)
				files.push(subDir);

			files.push(...subFiles);
		}

		if (
			stats.isDirectory() &&
			this.vfs.getFiles(dir).length === 0 &&
			this.vfs.getDirs(dir).length === 0
		)
			files.push(dir);

		return files;
	}

	private async buildModFile(
		file: string,
		// biome-ignore lint/correctness/noEmptyPattern: <explanation>
		_syncPath?: Required<SyncPath>,
	): Promise<ModFile> {
		const stats = await this.vfs.statPromisify(file);
		if (stats.isDirectory()) return { hash: "", directory: true };

		let retryCount = 0;
		const lock = await this.limiter.acquire();
		while (true) {
			try {
				const hash = await hashFile(file);
				lock.release();

				return {
					hash,
					directory: false,
				};
			} catch (e) {
				if (
					e instanceof Error &&
					"code" in e &&
					e.code === "EBUSY" &&
					retryCount < 5
				) {
					this.logger.error(
						`Error reading '${file}'. Retrying (${retryCount}/5)...`,
					);
					await new Promise((resolve) => setTimeout(resolve, 500));
					retryCount++;
					continue;
				}

				this.logger.error(`Error reading '${file}'. Exiting...`);
				this.logger.error(`${e}`);
				throw new HttpError(
					500,
					`Corter-ModSync: Error reading '${file}'\n${e}`,
				);
			}
		}
	}

	public async hashModFiles(
		syncPaths: Config["syncPaths"],
	): Promise<Record<string, Record<string, ModFile>>> {
		const result: Record<string, Record<string, ModFile>> = {};
		const processedFiles = new Set<string>();

		const startTime = performance.now();
		for (const syncPath of syncPaths) {
			const files = await this.getFilesInDir(syncPath.path, syncPath.path);
			const filesResult: Record<string, ModFile> = {};

			for (const file of files) {
				if (processedFiles.has(winPath(file))) continue;

				filesResult[winPath(file)] = await this.buildModFile(file, syncPath);

				processedFiles.add(winPath(file));
			}

			result[winPath(syncPath.path)] = filesResult;
		}

		this.logger.info(
			`Corter-ModSync: Hashed ${processedFiles.size} files in ${performance.now() - startTime}ms`,
		);

		return result;
	}

	/**
	 * @throws {Error} If file path is invalid
	 */
	public sanitizeDownloadPath(
		file: string,
		syncPaths: Config["syncPaths"],
		userName: string | null
	): string {
		const normalized = path.join(
			path.normalize(file).replace(/^(\.\.(\/|\\|$))+/, ""),
		);

		for (const syncPath of syncPaths) {
			const fullPath = this.getDownloadPath(syncPath, userName);
			if (!path.relative(fullPath, normalized).startsWith("..")) {
				return normalized;
			}
		}

		throw new HttpError(
			400,
			`Corter-ModSync: Requested file '${file}' is not in an enabled sync path!`,
		);
	}

	private getDownloadPath(
		syncPath: Required<SyncPath>,
		userName: string | null
	): string {
		if (userName) {
			const userFilePath = path.join("RemotePlugins", userName, syncPath.path);
			const fullPath = path.join(process.cwd(), userFilePath);
			return fullPath;
		} else {
			const fullPath = path.join(process.cwd(), syncPath.path);
			return fullPath;
		}
	}

	public async hashModFilesForUser(
		syncPaths: SyncPath[],
		userName: string
	): Promise<Record<string, Record<string, ModFile>>> {
		const result: Record<string, Record<string, ModFile>> = {};

		const processFiles = new Set<string>();

		const startTime  = performance.now();

		for (const syncPath of syncPaths) {
			const remoteFileDir = path.join("RemotePlugins" , userName);
			this.logger.info(`Coter-ModSync: server user remote path is ${remoteFileDir}`);
			const remoteFilePath = path.join(remoteFileDir, syncPath.path);
			const files = await this.getModFilesInDir(remoteFilePath, remoteFilePath, remoteFileDir);
			const filesResult : Record<string, ModFile> = {};

			for (const file of files) {
				// 检查用户特定路径
				const relativePath = path.relative(remoteFileDir, file);
				if (processFiles.has(winPath(relativePath))) continue;

				//buildModeFile函数hash的是服务端的文件
				//fileResult里面装的是不带有remoteFileDir的路径
				filesResult[winPath(relativePath)] = await this.buildModFile(file);

				processFiles.add(winPath(relativePath))
			}				
			result[winPath(syncPath.path)] = filesResult;
		}
		
		this.logger.info(
			`Overwrite Corter-ModSync: Hashed ${processFiles.size} files in ${performance.now() - startTime}ms`,
		);

		return result;
	}
}
