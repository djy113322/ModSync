import type { DependencyContainer } from "tsyringe";

import type { IncomingMessage, ServerResponse } from "node:http";
import type { IPreSptLoadMod } from "@spt/models/external/IPreSptLoadMod";
import type { ILogger } from "@spt/models/spt/utils/ILogger";
import type { HttpListenerModService } from "@spt/services/mod/httpListener/HttpListenerModService";
import type { HttpFileUtil } from "@spt/utils/HttpFileUtil";
import type { VFS } from "@spt/utils/VFS";
import type { JsonUtil } from "@spt/utils/JsonUtil";
import { ConfigUtil, type Config } from "./config";
import { SyncUtil } from "./sync";
import { Router } from "./router";
import type { PreSptModLoader } from "@spt/loaders/PreSptModLoader";
import type { HttpServerHelper } from "@spt/helpers/HttpServerHelper";
import { DatabaseServer } from "@spt/servers/DatabaseServer";
import { ProfileHelper } from "@spt/helpers/ProfileHelper";

class Mod implements IPreSptLoadMod {
	private static container: DependencyContainer;

	private static loadFailed = false;
	private static config: Config;

	public async preSptLoad(container: DependencyContainer): Promise<void> {
		Mod.container = container;
		const logger = container.resolve<ILogger>("WinstonLogger");
		const vfs = container.resolve<VFS>("VFS");
		const jsonUtil = container.resolve<JsonUtil>("JsonUtil");
		const modImporter = container.resolve<PreSptModLoader>("PreSptModLoader");
		const databaseServer = container.resolve<DatabaseServer>("DatabaseServer");
		const configUtil = new ConfigUtil(vfs, jsonUtil, modImporter, logger);
		const httpListenerService = container.resolve<HttpListenerModService>(
			"HttpListenerModService",
		);

		// 确保 RemotePlugins 目录结构存在
		if (!vfs.exists("RemotePlugins")) {
			vfs.createDirAsync("RemotePlugins");
			
			// 创建 DefaultPlugins 目录
			vfs.createDirAsync("RemotePlugins/DefaultPlugins");
			
			// 复制 BepInEx 到 DefaultPlugins
			if (vfs.exists("BepInEx")) {
				vfs.copyDir("BepInEx", "RemotePlugins/DefaultPlugins/BepInEx");
				logger.info("Created DefaultPlugins with BepInEx content");
			} else {
				Mod.loadFailed = true;
				logger.error("Custom Corter-ModSync: BepInEx File is not exist");
			}

			if (vfs.exists("ModSync.Updater.exe")) {
				vfs.copyFile("ModSync.Updater.exe", "RemotePlugins/DefaultPlugins/ModSync.Updater.exe");
				logger.info("add mod sync exe file");
			} else {
				Mod.loadFailed = true;
				logger.error("Custom Corter-ModSync: ModSync.Updater.exe File is not exist");
			}
		}

		httpListenerService.registerHttpListener(
			"ModSyncListener",
			this.canHandleOverride,
			this.handleOverride,
		);

		try {
			Mod.config = await configUtil.load();
			logger.info(`first config name is ${Mod.config.syncPaths.at(0)?.name}, first config enforced is ${Mod.config.syncPaths.at(0)?.enforced}`);
			logger.info(`first config name is ${Mod.config.syncPaths.at(1)?.name}, first config enforced is ${Mod.config.syncPaths.at(1)?.enforced}`);
			logger.info(`first config name is ${Mod.config.syncPaths.at(2)?.name}, first config enforced is ${Mod.config.syncPaths.at(2)?.enforced}`);
			logger.info(`first config name is ${Mod.config.syncPaths.at(3)?.name}, first config enforced is ${Mod.config.syncPaths.at(3)?.enforced}`);
			logger.info(`first config name is ${Mod.config.syncPaths.at(4)?.name}, first config enforced is ${Mod.config.syncPaths.at(4)?.enforced}`);
			logger.info(`first config name is ${Mod.config.syncPaths.at(5)?.name}, first config enforced is ${Mod.config.syncPaths.at(5)?.enforced}`);
		} catch (e) {
			Mod.loadFailed = true;
			logger.error("Corter-ModSync: Failed to load config!");
			throw e;
		}

		if (!vfs.exists("ModSync.Updater.exe")) {
			Mod.loadFailed = true;
			logger.error("Corter-ModSync: ModSync.Updater.exe not found! Please ensure ALL files from the release zip are extracted onto the server.");
		}

		if (!vfs.exists("BepInEx/plugins/Corter-ModSync.dll")) {
			Mod.loadFailed = true;
			logger.error("Corter-ModSync: Corter-ModSync.dll not found! Please ensure ALL files from the release zip are extracted onto the server.");
		}
	}

	public canHandleOverride(_sessionId: string, req: IncomingMessage): boolean {
		return !Mod.loadFailed && (req.url?.startsWith("/modsync/") ?? false);
	}

	public async handleOverride(
		sessionId: string,
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		const logger = Mod.container.resolve<ILogger>("WinstonLogger");
		const vfs = Mod.container.resolve<VFS>("VFS");
		const httpFileUtil = Mod.container.resolve<HttpFileUtil>("HttpFileUtil");
		const httpServerHelper =
			Mod.container.resolve<HttpServerHelper>("HttpServerHelper");
		const modImporter =
			Mod.container.resolve<PreSptModLoader>("PreSptModLoader");
		
		const profileHelper = Mod.container.resolve<ProfileHelper>("ProfileHelper");
		logger.info(`Corter-ModSync: sessionID in handleOverride is ${sessionId}.`);
		const profile = profileHelper.getPmcProfile(sessionId);
		if (profile) {
			logger.info(`Corter-ModSync: username is ${profile.Info.Nickname}.`);
		}
		const syncUtil = new SyncUtil(vfs, Mod.config, logger);
		const router = new Router(
			Mod.config,
			syncUtil,
			vfs,
			httpFileUtil,
			httpServerHelper,
			modImporter,
			logger,
			profileHelper
		);

		try {
			router.handleRequest(sessionId, req, res);
		} catch (e) {
			logger.error("Corter-ModSync: Failed to handle request!");
			throw e;
		}
	}
}

export const mod = new Mod();
