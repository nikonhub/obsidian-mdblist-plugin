import { requestUrl } from "obsidian";

const BASE_URL = "https://api.mdblist.com";
const PAGE_SIZE = 1000;
const MAX_PAGES = 200;

export interface UserInfo {
	username?: string;
	name?: string;
	plan?: string;
	api_requests?: number;
	api_requests_count?: number;
	rate_limit?: number;
	rate_limit_remaining?: number;
}

export interface UserList {
	id: number;
	name: string;
	slug?: string;
	items?: number;
}

export interface Buckets {
	movies: unknown[];
	shows: unknown[];
}

type Params = Record<string, string | number | undefined>;

export class MdblistApiError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
	}
}

export class MdblistApi {
	constructor(private readonly apiKey: string) {}

	getUser(): Promise<UserInfo> {
		return this.get("/user").then((r) => r.json as UserInfo);
	}

	async getLists(): Promise<UserList[]> {
		const { json } = await this.get("/lists/user");
		if (!Array.isArray(json)) return [];
		return json.filter((l): l is UserList => typeof l?.id === "number" && typeof l?.name === "string");
	}

	getWatchlist(params: Params): Promise<Buckets> {
		return this.getBuckets("/watchlist/items", params);
	}

	getListItems(listId: number, params: Params): Promise<Buckets> {
		return this.getBuckets(`/lists/${listId}/items`, params);
	}

	getWatched(): Promise<Buckets> {
		return this.getBuckets("/sync/watched", {});
	}

	getRatings(): Promise<Buckets> {
		return this.getBuckets("/sync/ratings", {});
	}

	/** Follows `next_cursor` until the endpoint is exhausted. */
	private async getBuckets(path: string, params: Params): Promise<Buckets> {
		const out: Buckets = { movies: [], shows: [] };
		const seenCursors = new Set<string>();
		let page: Params = {};

		for (let i = 0; i < MAX_PAGES; i++) {
			const { json, headers } = await this.get(path, { ...params, limit: PAGE_SIZE, ...page });
			const movies = Array.isArray(json?.movies) ? json.movies : [];
			const shows = Array.isArray(json?.shows) ? json.shows : [];
			out.movies.push(...movies);
			out.shows.push(...shows);

			const cursor = json?.pagination?.next_cursor ?? json?.next_cursor;
			if (typeof cursor === "string" && cursor !== "" && !seenCursors.has(cursor)) {
				seenCursors.add(cursor);
				page = { cursor };
			} else if (headers["x-has-more"] === "true" && movies.length + shows.length > 0) {
				// No cursor but more data: fall back to the deprecated offset pagination.
				const seasons = Array.isArray(json?.seasons) ? json.seasons.length : 0;
				const episodes = Array.isArray(json?.episodes) ? json.episodes.length : 0;
				const offset = typeof page.offset === "number" ? page.offset : 0;
				page = { offset: offset + movies.length + shows.length + seasons + episodes };
			} else {
				break;
			}
		}
		return out;
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private async get(path: string, params: Params = {}): Promise<{ json: any; headers: Record<string, string> }> {
		const query = new URLSearchParams({ apikey: this.apiKey });
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined && value !== "") query.set(key, String(value));
		}

		const response = await requestUrl({ url: `${BASE_URL}${path}?${query}`, method: "GET", throw: false });
		const headers: Record<string, string> = {};
		for (const [key, value] of Object.entries(response.headers ?? {})) headers[key.toLowerCase()] = String(value);

		let json: unknown;
		try {
			json = JSON.parse(response.text);
		} catch {
			json = undefined;
		}

		if (response.status >= 400) {
			throw new MdblistApiError(errorMessage(response.status, json, headers), response.status);
		}
		return { json, headers };
	}
}

function errorMessage(status: number, json: unknown, headers: Record<string, string>): string {
	const detail =
		typeof json === "object" && json !== null
			? (json as Record<string, unknown>).error ?? (json as Record<string, unknown>).detail
			: undefined;
	if (status === 429) {
		const retry = Number(headers["retry-after"]);
		const wait = Number.isFinite(retry) && retry > 0 ? ` Retry in ${Math.ceil(retry / 60)} min.` : "";
		return `${typeof detail === "string" ? detail : "Rate limit exceeded."}${wait}`;
	}
	if (typeof detail === "string") return detail;
	return `MDBList API returned HTTP ${status}`;
}
