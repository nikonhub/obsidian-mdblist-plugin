import { Notice, Plugin } from "obsidian";
import { DEFAULT_SETTINGS, MdblistSettingTab, MdblistSettings } from "./settings";
import { runSync, summarize } from "./sync";

export default class MdblistSyncPlugin extends Plugin {
	settings: MdblistSettings = DEFAULT_SETTINGS;
	private syncing = false;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.addCommand({
			id: "sync",
			name: "Sync",
			callback: () => void this.sync(),
		});
		this.addRibbonIcon("film", "Sync MDBList", () => void this.sync());
		this.addSettingTab(new MdblistSettingTab(this.app, this));
	}

	async sync(): Promise<void> {
		if (this.syncing) {
			new Notice("MDBList: a sync is already running.");
			return;
		}
		this.syncing = true;
		try {
			const summary = summarize(await runSync(this.app, this.settings));
			this.settings.lastSync = { at: Date.now(), summary };
			await this.saveSettings();
			new Notice(`MDBList: sync done. ${summary}.`);
		} catch (error) {
			console.error("MDBList sync failed", error);
			new Notice(`MDBList: sync failed. ${error instanceof Error ? error.message : String(error)}`, 10000);
		} finally {
			this.syncing = false;
		}
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<MdblistSettings> | null);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
