# MDBList Sync

Sync your [MDBList](https://mdblist.com) watchlist, lists, watched history and ratings into Obsidian notes.

One note per movie or show, with the data in properties so it works with Bases, Dataview and search:

```yaml
mdblist_id: tt2049403
title: Beetlejuice Beetlejuice
type: movie
year: 2024
imdb_id: tt2049403
tmdb_id: 917496
genres: [comedy, fantasy]
poster: https://…
watchlist: true
lists: [Halloween]
watched: true
watched_at: 2025-10-21
rating: 8
rated_at: 2025-10-21
```

## Usage

1. Paste your API key (bottom of [mdblist.com/preferences](https://mdblist.com/preferences/)) in the plugin settings and hit **Test**.
2. Pick the sync folder.
3. Run the **MDBList Sync: Sync** command, or click the film icon in the ribbon.

Syncing is manual only. Nothing is ever sent to MDBList: the sync is one way, MDBList to Obsidian.

## How notes are handled

- A note is recognized by its `mdblist_id` property, not its name or location. Rename or move it inside the sync folder freely.
- On later syncs only the properties above are updated. The body of the note and any property you add yourself are left alone.
- When a title disappears from everything you sync, its note is kept by default (with `watchlist: false` and `lists: []`). You can choose to move it to the trash instead.
- Seasons and episodes are ignored: only movies and shows get a note.

## Development

```bash
npm install
npm run dev    # watch build
npm run build  # type check + production build
npm test
```

To try it, copy or symlink `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/mdblist-sync/`.
