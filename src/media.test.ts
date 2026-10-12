import assert from "node:assert/strict";
import { test } from "node:test";
import { ItemCollection, fileName, parseItem, primaryId } from "./media.ts";

const listMovie = {
	id: 917496,
	title: "Beetlejuice Beetlejuice",
	imdb_id: "tt2049403",
	tvdb_id: null,
	ids: { mdblist: "m917496", imdb: "tt2049403", tmdb: 917496, tvdb: null },
	mediatype: "movie",
	release_year: 2024,
};

test("parses a flat list item", () => {
	const item = parseItem(listMovie, "movie");
	assert.equal(item?.imdb, "tt2049403");
	assert.equal(item?.tmdb, 917496);
	assert.equal(item?.tvdb, undefined);
	assert.equal(item?.year, 2024);
});

test("parses a list item without an ids object", () => {
	const item = parseItem({ id: 258902, title: "English Teacher", imdb_id: "tt20782190", tvdb_id: 421968 }, "show");
	assert.deepEqual([item?.imdb, item?.tmdb, item?.tvdb], ["tt20782190", 258902, 421968]);
});

test("parses a nested sync item", () => {
	const item = parseItem(
		{ watched_at: "2025-10-21T12:00:00Z", movie: { title: "Beetlejuice Beetlejuice", ids: { imdb: "tt2049403", tmdb: 917496 } } },
		"movie",
	);
	assert.equal(item?.title, "Beetlejuice Beetlejuice");
	assert.equal(item?.watchedAt, "2025-10-21");
});

test("rejects items without any id", () => {
	assert.equal(parseItem({ title: "Nope" }, "movie"), null);
	assert.equal(parseItem(null, "movie"), null);
});

test("merges the same title across sources", () => {
	const collection = new ItemCollection();
	const fromList = collection.upsert(listMovie, "movie");
	const fromRatings = collection.upsert({ rating: 8, rated_at: "2025-10-21T14:00:00Z", movie: { ids: { tmdb: 917496 } } }, "movie");
	assert.equal(fromList, fromRatings);
	assert.equal(collection.items.length, 1);
	assert.equal(collection.items[0]?.rating, 8);
	assert.equal(collection.items[0]?.title, "Beetlejuice Beetlejuice");
});

test("keeps a movie and a show with the same tmdb id apart", () => {
	const collection = new ItemCollection();
	collection.upsert({ id: 1, title: "A" }, "movie");
	collection.upsert({ id: 1, title: "B" }, "show");
	assert.equal(collection.items.length, 2);
});

test("builds safe file names", () => {
	const base = { type: "movie" as const, lists: [], watchlist: false, watched: false };
	assert.equal(fileName("{{title}} ({{year}})", { ...base, title: "Face/Off", year: 1997 }), "Face Off (1997)");
	assert.equal(fileName("{{title}} ({{year}})", { ...base, title: "What If...?" }), "What If");
	assert.equal(fileName("{{title}}", { ...base, title: "???", imdb: "tt1" }), "tt1");
	assert.equal(primaryId({ ...base, tmdb: 5 }), "movie-tmdb-5");
});
