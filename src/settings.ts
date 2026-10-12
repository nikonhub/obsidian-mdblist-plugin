import { AbstractInputSuggest, App, Notice, PluginSettingTab, Setting, TFolder } from "obsidian";
import { MdblistApi } from "./api";
import type MdblistSyncPlugin from "./main";

export interface MdblistSettings {
	apiKey: string;
	folder: string;
	syncWatchlist: boolean;
	syncLists: boolean;
	excludedListIds: number[];
	knownLists: { id: number; name: string }[];
	syncWatched: boolean;
	syncRatings: boolean;
	organizeByType: boolean;
	fileNameTemplate: string;
	extraMetadata: boolean;
	language: string;
	removedItems: "keep" | "trash";
	lastSync: { at: number; summary: string } | null;
}

export const DEFAULT_SETTINGS: MdblistSettings = {
	apiKey: "",
	folder: "MDBList",
	syncWatchlist: true,
	syncLists: true,
	excludedListIds: [],
	knownLists: [],
	syncWatched: false,
	syncRatings: false,
	organizeByType: true,
	fileNameTemplate: "{{title}} ({{year}})",
	extraMetadata: true,
	language: "",
	removedItems: "keep",
	lastSync: null,
};

class FolderSuggest extends AbstractInputSuggest<TFolder> {
	constructor(app: App, private readonly inputEl: HTMLInputElement) {
		super(app, inputEl);
	}

	getSuggestions(query: string): TFolder[] {
		const needle = query.toLowerCase();
		return this.app.vault
			.getAllLoadedFiles()
			.filter((f): f is TFolder => f instanceof TFolder && f.path !== "/" && f.path.toLowerCase().includes(needle))
			.slice(0, 50);
	}

	renderSuggestion(folder: TFolder, el: HTMLElement): void {
		el.setText(folder.path);
	}

	selectSuggestion(folder: TFolder): void {
		this.setValue(folder.path);
		this.inputEl.trigger("input");
		this.close();
	}
}

export class MdblistSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: MdblistSyncPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const { settings } = this.plugin;
		containerEl.empty();

		new Setting(containerEl)
			.setName("API key")
			.setDesc(
				createFragment((frag) => {
					frag.appendText("Found at the bottom of ");
					frag.createEl("a", { text: "mdblist.com/preferences", href: "https://mdblist.com/preferences/" });
					frag.appendText(".");
				}),
			)
			.addText((text) => {
				text.inputEl.type = "password";
				text.setPlaceholder("Your MDBList API key")
					.setValue(settings.apiKey)
					.onChange(async (value) => {
						settings.apiKey = value.trim();
						await this.plugin.saveSettings();
					});
			})
			.addButton((button) =>
				button.setButtonText("Test").onClick(async () => {
					button.setDisabled(true);
					try {
						const user = await new MdblistApi(settings.apiKey).getUser();
						const quota =
							user.api_requests !== undefined && user.api_requests_count !== undefined
								? ` (${user.api_requests_count}/${user.api_requests} requests used today)`
								: "";
						new Notice(`MDBList: connected as ${user.username ?? user.name ?? "unknown"}${quota}`);
					} catch (error) {
						new Notice(`MDBList: ${error instanceof Error ? error.message : String(error)}`);
					} finally {
						button.setDisabled(false);
					}
				}),
			);

		new Setting(containerEl)
			.setName("Sync folder")
			.setDesc("Notes are created here. The folder is created if it does not exist.")
			.addText((text) => {
				new FolderSuggest(this.app, text.inputEl);
				text.setPlaceholder("MDBList")
					.setValue(settings.folder)
					.onChange(async (value) => {
						settings.folder = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Sync now")
			.setDesc(
				settings.lastSync
					? `Last sync: ${new Date(settings.lastSync.at).toLocaleString()} (${settings.lastSync.summary})`
					: "Never synced. Syncing is manual: use this button, the ribbon icon or the command.",
			)
			.addButton((button) =>
				button
					.setButtonText("Sync")
					.setCta()
					.onClick(async () => {
						await this.plugin.sync();
						this.display();
					}),
			);

		new Setting(containerEl).setName("What to sync").setHeading();

		this.addToggle("Watchlist", "Adds a `watchlist` property.", "syncWatchlist");
		this.addToggle("My lists", "Adds a `lists` property with the names of the lists containing the title.", "syncLists", true);

		if (settings.syncLists) {
			new Setting(containerEl)
				.setName("Lists")
				.setDesc(
					settings.knownLists.length > 0
						? "Untick the lists you do not want. New lists are synced by default."
						: "All your lists are synced. Load them to pick which ones.",
				)
				.addButton((button) =>
					button.setButtonText(settings.knownLists.length > 0 ? "Reload" : "Load lists").onClick(async () => {
						try {
							const lists = await new MdblistApi(settings.apiKey).getLists();
							settings.knownLists = lists.map(({ id, name }) => ({ id, name }));
							await this.plugin.saveSettings();
							this.display();
						} catch (error) {
							new Notice(`MDBList: ${error instanceof Error ? error.message : String(error)}`);
						}
					}),
				);

			for (const list of settings.knownLists) {
				new Setting(containerEl)
					.setName(list.name)
					.setClass("mdblist-sync-list")
					.addToggle((toggle) =>
						toggle.setValue(!settings.excludedListIds.includes(list.id)).onChange(async (enabled) => {
							const excluded = new Set(settings.excludedListIds);
							if (enabled) excluded.delete(list.id);
							else excluded.add(list.id);
							settings.excludedListIds = [...excluded];
							await this.plugin.saveSettings();
						}),
					);
			}
		}

		this.addToggle("Watched history", "Adds `watched` and `watched_at` properties. Movies and shows only.", "syncWatched");
		this.addToggle("Ratings", "Adds `rating` and `rated_at` properties.", "syncRatings");

		new Setting(containerEl).setName("Notes").setHeading();

		this.addToggle("Separate movies and shows", "Create notes in Movies and Shows subfolders.", "organizeByType");

		new Setting(containerEl)
			.setName("File name")
			.setDesc("Available: {{title}}, {{year}}, {{type}}, {{imdb}}. Only used when a note is created.")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.fileNameTemplate)
					.setValue(settings.fileNameTemplate)
					.onChange(async (value) => {
						settings.fileNameTemplate = value.trim() || DEFAULT_SETTINGS.fileNameTemplate;
						await this.plugin.saveSettings();
					}),
			);

		this.addToggle("Poster, genres and description", "Fetch extra metadata for watchlist and list items.", "extraMetadata");

		new Setting(containerEl)
			.setName("Language")
			.setDesc("Language code for titles and descriptions, like fr or pt-BR. Leave empty for English.")
			.addText((text) =>
				text.setValue(settings.language).onChange(async (value) => {
					settings.language = value.trim();
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Titles no longer on MDBList")
			.setDesc("What happens to a note when its title is gone from everything you sync.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("keep", "Keep the note")
					.addOption("trash", "Move the note to trash")
					.setValue(settings.removedItems)
					.onChange(async (value) => {
						settings.removedItems = value === "trash" ? "trash" : "keep";
						await this.plugin.saveSettings();
					}),
			);
	}

	private addToggle(
		name: string,
		desc: string,
		key: "syncWatchlist" | "syncLists" | "syncWatched" | "syncRatings" | "organizeByType" | "extraMetadata",
		redraw = false,
	): void {
		new Setting(this.containerEl)
			.setName(name)
			.setDesc(desc)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings[key]).onChange(async (value) => {
					this.plugin.settings[key] = value;
					await this.plugin.saveSettings();
					if (redraw) this.display();
				}),
			);
	}
}
