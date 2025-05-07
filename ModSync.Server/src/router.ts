import type { HttpFileUtil } from "@spt/utils/HttpFileUtil";
import type { SyncUtil } from "./sync";
import { glob } from "./utility/glob";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { VFS } from "@spt/utils/VFS";
import type { Config } from "./config";
import { HttpError, winPath } from "./utility/misc";
import type { ILogger } from "@spt/models/spt/utils/ILogger";
import type { PreSptModLoader } from "@spt/loaders/PreSptModLoader";
import type { HttpServerHelper } from "@spt/helpers/HttpServerHelper";
import { ProfileHelper } from "@spt/helpers/ProfileHelper";

const FALLBACK_SYNCPATHS: Record<string, object> = {};

// @ts-expect-error - undefined indicates a version before 0.8.0
FALLBACK_SYNCPATHS[undefined] = [
	"BepInEx\\plugins\\Corter-ModSync.dll",
	"ModSync.Updater.exe",
];
FALLBACK_SYNCPATHS["0.8.0"] =
	FALLBACK_SYNCPATHS["0.8.1"] =
	FALLBACK_SYNCPATHS["0.8.2"] =
	[
		{
			enabled: true,
			enforced: true,
			path: "BepInEx\\plugins\\Corter-ModSync.dll",
			restartRequired: true,
			silent: false,
		},
		{
			enabled: true,
			enforced: true,
			path: "ModSync.Updater.exe",
			restartRequired: false,
			silent: false,
		},
	];

const FALLBACK_HASHES: Record<string, object> = {};

// @ts-expect-error - undefined indicates a version before 0.8.0
FALLBACK_HASHES[undefined] = {
	"BepInEx\\plugins\\Corter-ModSync.dll": { crc: 999999999 },
	"ModSync.Updater.exe": { crc: 999999999 },
};
FALLBACK_HASHES["0.8.0"] =
	FALLBACK_HASHES["0.8.1"] =
	FALLBACK_HASHES["0.8.2"] =
	{
		"BepInEx\\plugins\\Corter-ModSync.dll": {
			"BepInEx\\plugins\\Corter-ModSync.dll": {
				crc: 999999999,
				nosync: false,
			},
		},
		"ModSync.Updater.exe": {
			"ModSync.Updater.exe": { crc: 999999999, nosync: false },
		},
	};

export class Router {
	constructor(
		private config: Config,
		private syncUtil: SyncUtil,
		private vfs: VFS,
		private httpFileUtil: HttpFileUtil,
		private httpServerHelper: HttpServerHelper,
		private modImporter: PreSptModLoader,
		private logger: ILogger,
		private profileHelper: ProfileHelper // 添加 ProfileHelper
	) { }

	/**
	 * @internal
	 */
	public async getServerVersion(
		_req: IncomingMessage,
		res: ServerResponse,
		_: RegExpMatchArray,
		_params: URLSearchParams,
		_sessionId: string
	) {
		const modPath = this.modImporter.getModPath("Corter-ModSync");
		const packageJson = JSON.parse(
			// @ts-expect-error readFile returns a string when given a valid encoding
			await this.vfs
				// @ts-expect-error readFile takes in an options object, including an encoding option
				.readFilePromisify(path.join(modPath, "package.json"), {
					encoding: "utf-8",
				}),
		);

		res.setHeader("Content-Type", "application/json");
		res.writeHead(200, "OK");
		res.end(JSON.stringify(packageJson.version));
	}

	/**
	 * @internal
	 */
	public async getSyncPaths(
		req: IncomingMessage,
		res: ServerResponse,
		_: RegExpMatchArray,
		_params: URLSearchParams,
	) {
		const version = req.headers["modsync-version"] as string;
		if (version in FALLBACK_SYNCPATHS) {
			res.setHeader("Content-Type", "application/json");
			res.writeHead(200, "OK");
			res.end(JSON.stringify(FALLBACK_SYNCPATHS[version]));
			return;
		}

		res.setHeader("Content-Type", "application/json");
		res.writeHead(200, "OK");
		res.end(
			JSON.stringify(
				this.config.syncPaths.map(({ path, ...rest }) => ({
					path: winPath(path),
					...rest,
				})),
			),
		);
	}

	/**
	 * @internal
	 */
	public async getExclusions(
		_req: IncomingMessage,
		res: ServerResponse,
		_: RegExpMatchArray,
		_params: URLSearchParams,
		_sessionId: string
	) {
		res.setHeader("Content-Type", "application/json");
		res.writeHead(200, "OK");
		res.end(JSON.stringify(this.config.exclusions));
	}

	/**
	 * @internal
	 */
	public async getHashes(
		req: IncomingMessage,
		res: ServerResponse,
		_: RegExpMatchArray,
		params: URLSearchParams,
		sessionId: string
	) {
		const version = req.headers["modsync-version"] as string;
		if (version in FALLBACK_HASHES) {
			res.setHeader("Content-Type", "application/json");
			res.writeHead(200, "OK");
			res.end(JSON.stringify(FALLBACK_HASHES[version]));
			return;
		}

		// 获取用户名或 profile_id
		// const SessionId = req.headers["SessionId"] as string;
		// this.logger.info(`Corter-ModSync: getting profile for session ${sessionId} in get hashes func`);
		const userName = await this.getProfileName(sessionId);
		
		this.logger.info(`Corter-ModSync: username is ${userName}`)
		let pathsToHash = this.config.syncPaths;
		if (params.has("path")) {
			pathsToHash = this.config.syncPaths.filter(
				({ path, enforced }) =>
					enforced || params.getAll("path").includes(path),
			);
		}

		// 基于用户特定路径哈希文件
		let hashes;
		if (userName) {
			// this.logger.info(`Corter-ModSync: Enter the hash user name path`);
			// this.logger.info(`Corter-ModSync: username is ${userName}`)
			// 检查用户目录是否存在
			const userPluginDir = path.join("RemotePlugins", userName);
			if (!this.vfs.exists(userPluginDir)) {
				// 创建用户目录
				this.vfs.createDirAsync(userPluginDir);
				
				// 复制默认插件到用户目录
				if (this.vfs.exists("RemotePlugins/DefaultPlugins")) {
					this.vfs.copyDir("RemotePlugins/DefaultPlugins", userPluginDir);
					this.logger.info(`Created user plugin directory for ${userName}`);
				}
			}

			// 修改 hashModFiles 方法以支持用户特定路径，或创建一个新的版本
			hashes = await this.syncUtil.hashModFilesForUser(pathsToHash, userName);
		} else {
			this.logger.info(`Corter-ModSync: Enter the hash default path`);
			// 使用原始哈希方法
			hashes = await this.syncUtil.hashModFiles(pathsToHash);
			this.logger.warning(
				`Corter-ModSync: hash unknown username file`,
			);
		}

		res.setHeader("Content-Type", "application/json");
		res.writeHead(200, "OK");
		res.end(JSON.stringify(hashes));
	}

	/**
	 * @internal
	 */
	public async fetchModFile(
		req: IncomingMessage,
		res: ServerResponse,
		matches: RegExpMatchArray,
		_params: URLSearchParams,
		sessionId: string
	) {
		const filePath = decodeURIComponent(matches[1]);
		
		// 获取用户名或 profile_id
		// const SessionId = req.headers["SessionId"] as string;

		//TODO: 将路径替换为带有RemotePlugins的目录
		// this.logger.info(`Corter-ModSync: getting profile for session ${sessionId} in fetch files func`);
		const userName = await this.getProfileName(sessionId);
		// 用于存储实际将要发送的文件路径
		let actualFilePath = filePath;
		
		// 检查是否为 BepInEx 路径，这些是我们想要个性化的
		if (filePath.startsWith("BepInEx/")) {
			if (userName) {
				// 用户特定目录路径
				const userPluginDir = path.join("RemotePlugins", userName);
				
				// 检查用户目录是否存在
				if (!this.vfs.exists(userPluginDir)) {
					// 创建用户目录
					this.vfs.createDir(userPluginDir);
					
					// 复制默认插件到用户目录
					if (this.vfs.exists("RemotePlugins/DefaultPlugins")) {
						this.vfs.copyDir("RemotePlugins/DefaultPlugins", userPluginDir);
						this.logger.info(`Created user plugin directory for ${userName}`);
					}
				}
				
				// 构建用户特定的文件路径
				const userFilePath = path.join(userPluginDir, filePath);
				
				// 如果用户特定文件存在，使用它，否则使用默认路径
				if (this.vfs.exists(userFilePath)) {
					actualFilePath = userFilePath;
					this.logger.debug(`Using user-specific file: ${userFilePath}`);
				}
			}
		}

		// 安全检查路径
		const sanitizedPath = this.syncUtil.sanitizeDownloadPath(
			actualFilePath,
			this.config.syncPaths,
			userName,
		);

		if (!this.vfs.exists(sanitizedPath))
			throw new HttpError(
				404,
				`Attempt to access non-existent path ${filePath}`
			);

		try {
			const fileStats = await this.vfs.statPromisify(sanitizedPath);
			res.setHeader("Accept-Ranges", "bytes");
			res.setHeader(
				"Content-Type",
				this.httpServerHelper.getMimeText(path.extname(filePath)) ||
				"text/plain"
			);
			res.setHeader("Content-Length", fileStats.size);
			return this.httpFileUtil.sendFileAsync(res, sanitizedPath);
		} catch (e) {
			throw new HttpError(
				500,
				`Corter-ModSync: Error reading '${filePath}'\n${e}`
			);
		}
	}

	/**
     * 根据session获取用户档案名称
     */
    private async getProfileName(sessionId: string): Promise<string | null> {
		if (sessionId)
		{
				try
				{
					// this.logger.info(`Corter-ModSync: getting profile for session ${sessionId}`);
					const profile = this.profileHelper.getPmcProfile(sessionId);
					if(profile)
					{
						// const profileId = profile.aid || profile._id;
						const profileNam = profile.Info.Nickname;
						return profileNam;
					}
				} catch(error) {
					this.logger.error(`Error getting profile for session ${sessionId}: ${error}`);
					return null;
				}
		}
		else {
			this.logger.error(`Corter-ModSync: can not get profile for session ${sessionId}`);
		}
		return null;
    }
	public handleRequest(sessionId: string, req: IncomingMessage, res: ServerResponse) {
		const routeTable = [
			{
				route: glob("/modsync/version"),
				handler: this.getServerVersion.bind(this),
			},
			{
				route: glob("/modsync/paths"),
				handler: this.getSyncPaths.bind(this),
			},
			{
				route: glob("/modsync/exclusions"),
				handler: this.getExclusions.bind(this),
			},
			{
				route: glob("/modsync/hashes"),
				handler: (req: IncomingMessage, res: ServerResponse, matches: RegExpMatchArray, params: URLSearchParams) => 
					this.getHashes(req, res, matches, params, sessionId),
			},
			{
				route: glob("/modsync/fetch/**"),
				handler: (req: IncomingMessage, res: ServerResponse, matches: RegExpMatchArray, params: URLSearchParams) => 
					this.fetchModFile(req, res, matches, params, sessionId),
			},
		];

		const url = new URL(req.url!, `http://${req.headers.host}`);

		try {
			for (const { route, handler } of routeTable) {
				const matches = route.exec(url.pathname);
				if (matches) return handler(req, res, matches, url.searchParams, sessionId);
			}

			throw new HttpError(404, "Corter-ModSync: Unknown route");
		} catch (e) {
			if (e instanceof Error)
				this.logger.error(
					`Corter-ModSync: Error when handling [${req.method} ${req.url}]:\n${e.message}\n${e.stack}`,
				);

			if (e instanceof HttpError) {
				res.writeHead(e.code, e.codeMessage);
				res.end(e.message);
			} else {
				res.writeHead(500, "Internal server error");
				res.end(
					`Corter-ModSync: Error handling [${req.method} ${req.url}]:\n${e}`,
				);
			}
		}
	}
}
