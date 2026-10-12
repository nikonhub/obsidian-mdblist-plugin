import { App, Notice, TFile, getFrontMatterInfo, normalizePath, parseYaml, stringifyYaml } from "obsidian";
import { Buckets, MdblistApi } from "./api";
import { ItemCollection, MediaItem, aliases, fileName, primaryId } from "./media";
import type { MdblistSettings } from "./settings";

export interface SyncResult {
	total: number;
	created: number;
	updated: number;
	unchanged: number;
	removed: number;
	skipped: number;
}

/** `undefined` leaves a property untouched, `null` removes it. */
type Props = Record<string, unknown>;
type Frontmatter = Record<string, unknown>;

interface ManagedNote {
	file: TFile;
	frontmatter: Frontmatter;
}

const ID_PROP = "mdblist_id";

export async function runSync(app: App, settings: MdblistSettings): Promise<SyncResult> {
	if (!settings.apiKey.trim()) throw new Error("Set your API key in the plugin settings first.");

	const progress = new Notice("MDBList: fetching…", 0);
	try {
		// Fetch everything before touching the vault: a failed request must never leave a half-applied sync.
		const items = await fetchItems(settings, (message) => progress.setMessage(`MDBList: ${message}`));
		progress.setMessage(`MDBList: writing ${items.length} notes…`);
		return await writeNotes(app, settings, items);
	} finally {
		progress.hide();
	}
}

async function fetchItems(settings: MdblistSettings, report: (message: string) => void): Promise<MediaItem[]> {
	const api = new MdblistApi(settings.apiKey.trim());
	const collection = new ItemCollection();
	const listParams = {
		append_to_response: settings.extraMetadata ? "genres,poster,description" : undefined,
		lang: settings.language.trim() || undefined,
	};
	const each = (buckets: Buckets, apply: (item: MediaItem, raw: unknown) => void) => {
		for (const type of ["movie", "show"] as const) {
			for (const raw of type === "movie" ? buckets.movies : buckets.shows) {
				const item = collection.upsert(raw, type);
				if (item) apply(item, raw);
			}
		}
	};

	if (settings.syncWatchlist) {
		report("fetching watchlist…");
		each(await api.getWatchlist(listParams), (item) => (item.watchlist = true));
	}

	if (settings.syncLists) {
		report("fetching lists…");
		const lists = (await api.getLists()).filter((l) => !settings.excludedListIds.includes(l.id));
		for (const [index, list] of lists.entries()) {
			report(`fetching list ${index + 1}/${lists.length} (${list.name})…`);
			each(await api.getListItems(list.id, listParams), (item) => {
				if (!item.lists.includes(list.name)) item.lists.push(list.name);
			});
		}
	}

	if (settings.syncWatched) {
		report("fetching watched history…");
		each(await api.getWatched(), (item) => (item.watched = true));
	}

	if (settings.syncRatings) {
		report("fetching ratings…");
		each(await api.getRatings(), () => undefined);
	}

	// A note needs at least a title to be named.
	return collection.items.filter((item) => item.title !== "");
}

async function writeNotes(app: App, settings: MdblistSettings, items: MediaItem[]): Promise<SyncResult> {
	const result: SyncResult = { total: items.length, created: 0, updated: 0, unchanged: 0, removed: 0, skipped: 0 };
	const root = normalizeFolder(settings.folder);
	const notes = await indexNotes(app, root);
	const byAlias = new Map<string, ManagedNote>();
	for (const note of notes) {
		for (const key of noteAliases(note.frontmatter)) byAlias.set(key, note);
	}

	const matched = new Set<ManagedNote>();
	for (const item of items) {
		const note = aliases(item.type, item)
			.map((key) => byAlias.get(key))
			.find((n) => n !== undefined);
		const props = { ...staticProps(item), ...dynamicProps(item, settings) };

		if (note) {
			matched.add(note);
			if (await applyProps(app, note, props)) result.updated++;
			else result.unchanged++;
			continue;
		}

		const path = await newNotePath(app, settings, root, item);
		if (!path) {
			result.skipped++;
			continue;
		}
		await app.vault.create(path, noteContent(item, props));
		result.created++;
	}

	const orphans = notes.filter((note) => !matched.has(note));
	if (settings.removedItems === "trash") {
		// An empty result while notes exist smells like an API hiccup: never wipe the folder on it.
		if (items.length > 0) {
			for (const note of orphans) {
				await app.fileManager.trashFile(note.file);
				result.removed++;
			}
		}
	} else {
		const cleared: MediaItem = { type: "movie", title: "", lists: [], watchlist: false, watched: false };
		for (const note of orphans) {
			if (await applyProps(app, note, dynamicProps(cleared, settings))) result.updated++;
		}
	}
	return result;
}

function staticProps(item: MediaItem): Props {
	return {
		[ID_PROP]: primaryId(item),
		title: item.title,
		type: item.type,
		year: item.year,
		imdb_id: item.imdb,
		tmdb_id: item.tmdb,
		tvdb_id: item.tvdb,
		genres: item.genres,
		poster: item.poster,
	};
}

/** Properties owned by a source are only written while that source is enabled. */
function dynamicProps(item: MediaItem, settings: MdblistSettings): Props {
	const props: Props = {};
	if (settings.syncWatchlist) props.watchlist = item.watchlist;
	if (settings.syncLists) props.lists = [...item.lists].sort((a, b) => a.localeCompare(b));
	if (settings.syncWatched) {
		props.watched = item.watched;
		props.watched_at = item.watchedAt ?? null;
	}
	if (settings.syncRatings) {
		props.rating = item.rating ?? null;
		props.rated_at = item.ratedAt ?? null;
	}
	return props;
}

/** Only the frontmatter is rewritten, so anything the user wrote in the note is preserved. */
async function applyProps(app: App, note: ManagedNote, props: Props): Promise<boolean> {
	const changed = Object.entries(props).some(([key, value]) => {
		if (value === undefined) return false;
		if (value === null) return note.frontmatter[key] !== undefined && note.frontmatter[key] !== null;
		return JSON.stringify(note.frontmatter[key]) !== JSON.stringify(value);
	});
	if (!changed) return false;

	await app.fileManager.processFrontMatter(note.file, (frontmatter: Frontmatter) => {
		for (const [key, value] of Object.entries(props)) {
			if (value === undefined) continue;
			if (value === null) delete frontmatter[key];
			else frontmatter[key] = value;
		}
	});
	return true;
}

function noteContent(item: MediaItem, props: Props): string {
	const frontmatter: Props = {};
	for (const [key, value] of Object.entries(props)) {
		if (value !== undefined && value !== null) frontmatter[key] = value;
	}

	const body: string[] = [];
	if (item.poster) body.push(`![poster|300](${item.poster})`);
	if (item.description) body.push(item.description);
	if (item.imdb) body.push(`[IMDb](https://www.imdb.com/title/${item.imdb}/)`);
	return `---\n${stringifyYaml(frontmatter)}---\n\n${body.join("\n\n")}\n`;
}

async function newNotePath(app: App, settings: MdblistSettings, root: string, item: MediaItem): Promise<string | null> {
	const subfolder = settings.organizeByType ? (item.type === "movie" ? "Movies" : "Shows") : "";
	const folder = [root, subfolder].filter((part) => part !== "").join("/");
	await ensureFolder(app, folder);

	const name = fileName(settings.fileNameTemplate, item);
	const candidates = [name, `${name} [${primaryId(item)}]`];
	for (const candidate of candidates) {
		const path = normalizePath(folder ? `${folder}/${candidate}.md` : `${candidate}.md`);
		if (!app.vault.getAbstractFileByPath(path)) return path;
	}
	return null;
}

async function ensureFolder(app: App, folder: string): Promise<void> {
	let current = "";
	for (const segment of folder.split("/").filter((s) => s !== "")) {
		current = current ? `${current}/${segment}` : segment;
		if (!app.vault.getAbstractFileByPath(current)) await app.vault.createFolder(current);
	}
}

function normalizeFolder(folder: string): string {
	const trimmed = folder.trim().replace(/^\/+|\/+$/g, "");
	return trimmed === "" ? "" : normalizePath(trimmed);
}

/** Notes previously created by the plugin, recognized by their `mdblist_id` property. */
async function indexNotes(app: App, root: string): Promise<ManagedNote[]> {
	const notes: ManagedNote[] = [];
	for (const file of app.vault.getMarkdownFiles()) {
		if (root !== "" && !file.path.startsWith(`${root}/`)) continue;
		const frontmatter = await readFrontmatter(app, file);
		if (frontmatter && frontmatter[ID_PROP] !== undefined && frontmatter[ID_PROP] !== null) {
			notes.push({ file, frontmatter });
		}
	}
	return notes;
}

async function readFrontmatter(app: App, file: TFile): Promise<Frontmatter | null> {
	const cache = app.metadataCache.getFileCache(file);
	if (cache) return cache.frontmatter ?? null;

	// Not indexed yet (e.g. created seconds ago by a previous sync): parse it ourselves.
	const info = getFrontMatterInfo(await app.vault.cachedRead(file));
	if (!info.exists) return null;
	try {
		const parsed: unknown = parseYaml(info.frontmatter);
		return typeof parsed === "object" && parsed !== null ? (parsed as Frontmatter) : null;
	} catch {
		return null;
	}
}

function noteAliases(frontmatter: Frontmatter): string[] {
	const type = frontmatter.type === "show" ? "show" : "movie";
	const number = (value: unknown) => (typeof value === "number" ? value : undefined);
	return [
		String(frontmatter[ID_PROP]),
		...aliases(type, {
			imdb: typeof frontmatter.imdb_id === "string" ? frontmatter.imdb_id : undefined,
			tmdb: number(frontmatter.tmdb_id),
			tvdb: number(frontmatter.tvdb_id),
		}),
	];
}

export function summarize(result: SyncResult): string {
	const parts = [`${result.total} items`, `${result.created} created`, `${result.updated} updated`];
	if (result.removed > 0) parts.push(`${result.removed} removed`);
	if (result.skipped > 0) parts.push(`${result.skipped} skipped (file name conflict)`);
	return parts.join(", ");
}
