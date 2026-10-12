// Pure data helpers: no Obsidian imports here so this file can be unit tested.

export type MediaType = "movie" | "show";

export interface MediaIds {
	imdb?: string;
	tmdb?: number;
	tvdb?: number;
	mdblist?: string;
}

export interface MediaItem extends MediaIds {
	type: MediaType;
	title: string;
	year?: number;
	genres?: string[];
	poster?: string;
	description?: string;
	lists: string[];
	watchlist: boolean;
	watched: boolean;
	watchedAt?: string;
	rating?: number;
	ratedAt?: string;
}

type Raw = Record<string, unknown>;

const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w500";

function isRecord(value: unknown): value is Raw {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
	return undefined;
}

/** `2025-10-21T12:00:00Z` -> `2025-10-21`, so Obsidian treats it as a date property. */
function day(value: unknown): string | undefined {
	const match = str(value)?.match(/^\d{4}-\d{2}-\d{2}/);
	return match?.[0];
}

function genres(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const names = value
		.map((g) => (isRecord(g) ? str(g.name) ?? str(g.title) ?? str(g.slug) : str(g)))
		.filter((g): g is string => g !== undefined);
	return names.length > 0 ? names : undefined;
}

function poster(value: unknown): string | undefined {
	const url = str(value);
	if (!url) return undefined;
	return url.startsWith("/") ? TMDB_IMAGE_BASE + url : url;
}

/**
 * Normalizes an API item. List endpoints return flat objects, sync endpoints
 * nest the media under a `movie` / `show` key, so both shapes are accepted.
 */
export function parseItem(raw: unknown, type: MediaType): Partial<MediaItem> & { type: MediaType } | null {
	if (!isRecord(raw)) return null;
	const nested = isRecord(raw[type]) ? raw[type] : undefined;
	const inner = nested ?? raw;
	const ids: Raw = {
		...(isRecord(raw.ids) ? raw.ids : {}),
		...(isRecord(inner.ids) ? inner.ids : {}),
	};

	const parsed = {
		type,
		title: str(inner.title),
		year: num(inner.release_year) ?? num(inner.year),
		imdb: str(ids.imdb) ?? str(inner.imdb_id),
		// On flat list items the top-level `id` is the TMDB id.
		tmdb: num(ids.tmdb) ?? (nested ? undefined : num(inner.id)),
		tvdb: num(ids.tvdb) ?? num(inner.tvdb_id),
		mdblist: str(ids.mdblist),
		genres: genres(inner.genres),
		poster: poster(inner.poster),
		description: str(inner.description),
		watchedAt: day(raw.last_watched_at) ?? day(raw.watched_at),
		rating: num(raw.rating),
		ratedAt: day(raw.rated_at),
	};
	return aliases(type, parsed).length > 0 ? parsed : null;
}

/** Every key under which an item can be recognized, most stable first. */
export function aliases(type: MediaType, ids: MediaIds): string[] {
	const out: string[] = [];
	if (ids.imdb) out.push(ids.imdb);
	if (ids.tmdb !== undefined) out.push(`${type}-tmdb-${ids.tmdb}`);
	if (ids.tvdb !== undefined) out.push(`${type}-tvdb-${ids.tvdb}`);
	if (ids.mdblist) out.push(`mdblist-${ids.mdblist}`);
	return out;
}

export function primaryId(item: MediaIds & { type: MediaType }): string {
	return aliases(item.type, item)[0] ?? "";
}

/** Merges the same title coming from several sources (watchlist, lists, history, ratings). */
export class ItemCollection {
	readonly items: MediaItem[] = [];
	private byAlias = new Map<string, MediaItem>();

	upsert(raw: unknown, type: MediaType): MediaItem | null {
		const parsed = parseItem(raw, type);
		if (!parsed) return null;

		const keys = aliases(type, parsed);
		let item = keys.map((k) => this.byAlias.get(k)).find((i) => i !== undefined);
		if (!item) {
			item = { type, title: "", lists: [], watchlist: false, watched: false };
			this.items.push(item);
		}
		const target = item as unknown as Raw;
		for (const [key, value] of Object.entries(parsed)) {
			if (value !== undefined && (target[key] === undefined || target[key] === "")) target[key] = value;
		}
		for (const key of aliases(type, item)) this.byAlias.set(key, item);
		return item;
	}
}

const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|#^[\]]/g;

export function fileName(template: string, item: MediaItem): string {
	const name = template
		.replace(/{{\s*title\s*}}/g, item.title)
		.replace(/{{\s*year\s*}}/g, item.year !== undefined ? String(item.year) : "")
		.replace(/{{\s*type\s*}}/g, item.type)
		.replace(/{{\s*imdb\s*}}/g, item.imdb ?? "")
		.replace(/\(\s*\)|\[\s*\]/g, "")
		.replace(ILLEGAL_FILENAME_CHARS, " ")
		.replace(/\s+/g, " ")
		.trim()
		// Obsidian cannot open files starting with a dot or ending with one.
		.replace(/^\.+|\.+$/g, "");
	return name || primaryId(item);
}
