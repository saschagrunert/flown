# Output and technical details

What a run writes and how: the files of the site and their format, the link
previews and how the flights are exported, and where the airports, the ground
under the flights and the satellite imagery come from.

## Output directory

The output directory contains the page, the frontend bundles with their source
maps, the third-party code the page loads, static assets and a `data/` directory
with one file per year:

```text
output-dir/
├── index.html
├── mapApp.bundle.js
├── mapApp.bundle.js.map
├── features.bundle.js     # Map features a first visit does not need (replay among them), imported on first use
├── features.bundle.js.map
├── wrapped.bundle.js      # Wrapped, the statistics panel and the flight list, imported on first use
├── wrapped.bundle.js.map
├── search.bundle.js       # The search of airports and places, imported on first use
├── search.bundle.js.map
├── extras.bundle.js       # The phone's sheet and the export of the map, imported on first use
├── extras.bundle.js.map
├── shared.bundle.js       # The app, which the five above import
├── shared.bundle.js.map
├── yearWorker.bundle.js   # Decodes the year files and writes the heat sources, in a worker
├── yearWorker.bundle.js.map
├── map_config.js          # Map defaults, tile API key and the build stamp
├── styles.css             # Linked in the page
├── features.css           # The styles of those features, fetched with their bundle
├── wrapped.css            # Wrapped, the statistics panel and the flight list, fetched with its bundle
├── search.css             # The search, fetched with its bundle
├── manifest.json
├── favicon.svg
├── favicon.ico
├── favicon-192.png
├── favicon-512.png
├── apple-touch-icon.png
├── vendor/                # MapLibre GL JS, html-to-image
│   ├── maplibre-gl.mjs
│   ├── maplibre-gl-shared.mjs   # Imported by the two around it
│   ├── maplibre-gl-worker.mjs   # Started by maplibre-gl.mjs as a module worker
│   ├── maplibre-gl.css
│   └── html-to-image.mjs        # Imported on the first image export
├── flags/                 # One SVG per country the flights touched
├── preview.png            # Link preview image of the site, only with --site-url
├── y/                     # Link preview page of each year (2025.html), and with --site-url its image (2025.png)
├── f/                     # The same for each flight, by its id
└── data/
    ├── airports.json      # Airport markers
    ├── metadata.json      # Years, file sizes, speed range, models, flags
    ├── 2025/
    │   └── data.json
    └── 2026/
        └── data.json
```

## Year files

Each year file holds an object with `format`, `year`, `original_points`,
`path_info` and `segments`. `format` is the wire format of the rows, which the
page checks before reading them so a file written by another version is refused
rather than misread. `path_info` lists the flights in input order, each with its
id, year, airports, aircraft, exact altitude range and total climb
(`altitude_gain_ft`), the last three written together for every flight with an
altitude; where a flight starts and ends is read from its segments. A flight
with timestamps also has its `landings` (full stops), `touch_and_goes`,
`go_arounds` (low approaches included, which GPS cannot tell apart from them)
and `touchdowns`, one `[airport, runway]` per full stop and touch-and-go in the
order flown, with `null` for a runway the build could not tell (see
[Airport database](#airport-database)). `segments` maps a path id to
`{"start": [lat, lon], "columns": [lats, lons, altitudes, speeds, times], "ground": [...]}`,
one row per segment, written column by column: the n-th entry of each column is
the n-th row's latitude, longitude, altitude in feet, groundspeed in whole knots
(0 for a speed that is not known, and at least 1 for one that is) and relative
time in seconds. The `times` column is only present for files with timestamps,
and holds `null` for a row without one. `ground` is the ground under each row in
feet (see [Elevation data](#elevation-data)); a path whose ground the build does
not know has none, and the page takes it from the airfields.

The coordinate in a row is the segment's **end** point. Its start is the end of
the previous row, and the first row continues from `start`, so a shared point is
stored once instead of twice. Coordinates are rounded to five decimals (about 1
m), and the only segments the exporter drops are the ones whose two endpoints
round to the same coordinate (standing still), which keeps the rows contiguous.

Every value above is written as an integer difference to the row before it
rather than as the number itself (`flown/segment_codec.py`, mirrored by
`decodeYear` in `services/yearDecode.ts`, which the page runs in a worker). The
exporter has already rounded each column to the step the format counts in (1e-5
degrees, 20 ft, 1 kt, 0.1 s and 10 ft of ground), so every value is a whole
number of steps, and neighbouring rows barely differ: the encoding is lossless
and roughly halves a year file. Writing the rows column by column puts the
repeating differences of one quantity next to each other, which takes another
sixth off the compressed download. The numbers the page works with are the ones
described above; only the file is written this way. The page skips the rest of a
path, with a warning in the console, from the first value that is not a number.

## Index files and loading

`metadata.json` lists the available years, the size of each year file
(`year_file_bytes`) so the frontend can show loading progress, the groundspeed
range of the speed scale and the model names `aircraft.json` knows for the
exported aircraft (`aircraft_models`), and the countries the site carries a flag
for (`available_flags`). It carries no statistics: the frontend computes them
from the year files for the active year, aircraft and selection. Flights without
a recognizable year are skipped instead of being grouped under an "unknown"
year, and the map bounds in `map_config.js` cover only the exported flights.
`airports.json` lists every airport marker with its name, position, the ICAO
code in its name (`code`, left out for a name without one) and its country where
the airport database knows it. Airport entries carry no flight count: the
frontend derives one per airport from the active year and aircraft filter.

The data is plain JSON, organized by year and fetched on demand. The page
preloads the two index files and the latest year's file, which it opens with, so
the downloads start together with the bundles rather than after them. It
preloads CARTO's style and the index of its tiles as well (with the API key when
the site has one), which the map would otherwise only ask for one after the
other once it has started.

## Link previews

A link shared in a chat or a post unfolds from the Open Graph tags of the page
it points to. Scrapers run no JavaScript and ignore the query string, so a link
to a year or a flight (`?y=2025&p=...`) could only ever show the site's preview.
Every year and every flight therefore gets a small page of its own,
`y/2025.html` and `f/<id>.html` (the id as the page writes it into a link), with
its own title, description and image, which sends a browser on to the map with
that year or flight selected. Link to those pages to share one.

The images are 1200 by 630 pixels: the tracks as a glow, brighter where more
time was spent, in the colours of the 3D view's heat cloud, exposed so that the
busiest half percent of the lit pixels are white. They are drawn in Python
alone, without a browser, and only with `--site-url`, since an `og:image` has to
be an absolute URL (see [Hosting](hosting.md#link-previews-need---site-url)). A
flight's image depends on nothing but its track, and the images are kept in the
[cache directory](#cache-directory) under a hash of what they draw, so a run
draws only what changed. The images show no text, no dates and no build stamp,
only exported flights are drawn, and the page and image of a flight that left
the input are removed with it.

## Data export

The tool exports all flight data without downsampling:

- **Full fidelity**: Every recorded movement is preserved. Coordinates are
  written with five decimals (about 1 m), far finer than the map can show; only
  points that do not move at that precision (standing still) are dropped
- **Year-based splitting**: Data is organized by year for efficient filtering
- **On-demand loading**: Only requested years are loaded into the browser
- **Compact format**: Paths are stored as a start point plus one row per
  segment, each holding only its end point, written column by column (see
  [Year files](#year-files))
- **Duplicates skipped**: A flight whose exported content is identical to an
  earlier one (the same export under two names) is skipped with a warning naming
  both files, so it is not counted twice. So is the same flight recorded twice
  (two devices or two tools), told apart by where each recording was when: the
  one that names the aircraft, or else the one with more points, is kept
- **Split tracks joined**: The `LineString`s a logger split one flight into are
  one path again (see [Troubleshooting](usage.md#troubleshooting))
- **Plausible speeds**: A groundspeed above 600 kt comes from timestamp jitter,
  not from the aircraft; it counts as unknown rather than as 0
- **Stable path ids**: A path id is a 40-bit hash of the path's coordinates,
  rounded as exported, and altitudes; two different flights whose hashes collide
  take the next free id in input order. Ids survive regenerating the site, so
  shared links and saved selections keep their flights
- **Reproducible output**: The files do not depend on the number of CPU cores or
  on how the years were split for the workers

Parsing and the per-year export run in a process pool, so large collections
scale with the number of CPU cores. See
[`scripts/README.md`](../scripts/README.md) for the sizes used in performance
testing and the measured processing time for 100,000 files.

Supports KML files from Google Earth, Google Maps, SkyDemon, Charterware, and
other aviation apps.

## Airport database

Airport names and coordinates come from the
[OurAirports](https://ourairports.com/) CSV, which is downloaded on the first
run and kept in the [cache directory](#cache-directory) for 30 days.

The runways of the same database (`runways.csv`, cached the same way) name the
runway of every touchdown. The build reads the landings from the logs at their
full precision (`flown/landings.py`): a touchdown is a fix within 60 ft of a
field's ground (its published elevation plus how far the logger read above it
while taxiing) at 35 kt or more, a full stop one that slows below 25 kt there, a
touch-and-go one that climbs 300 ft without stopping, and a go-around an
approach below 400 ft on a runway's line that climbs away without touching down.
The runway is the track over the last 30 seconds, snapped to the nearest runway
end of the field.

Without the database the site is still generated, with the airport names as the
KML files spell them, without countries and without landings. Set
`FLOWN_REQUIRE_AIRPORT_DB=1` to fail instead, as CI does for the published site;
it requires the runways as well.

## Elevation data

The ground under the flights (the 3D view stands them on it) comes from the
[Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) on AWS Open Data,
in the Terrarium encoding, at zoom 10: pixels of about 100 m at 50 degrees
north, fine enough for the relief under a flight. The build samples the
elevation under every exported position, bilinear across tile edges, and writes
it into the year files; `flown/terrain.py` has the details, including how the
model is shifted to meet the altitudes a flight recorded taxiing at both ends.
The 3D view draws the relief from the same tiles at every zoom (the page fetches
them from AWS while the 3D view is on, a few hundred KB for a view, and credits
them on the map while they are drawn), so the ground a flight is measured
against and the ground it is drawn on are the same model. Zoomed out the map
draws it from the tiles of a coarser level, and the page smooths the sampled
ground along each flight as much before it stands the flight on it.

The tiles are downloaded on the first run, eight at a time, and kept in the
[cache directory](#cache-directory); how many the flights in this repository
take is in
[Elevation tiles at build time](development/data.md#elevation-tiles-at-build-time).
A tile never changes, so it is never fetched again. A download that fails is
tried again a few times. Offline, or when a tile cannot be fetched, the build
goes on without it: a flight with a position under a missing tile gets no ground
and stands on the line between its airfields, and one warning says how many
flights that affects. Set `FLOWN_REQUIRE_TERRAIN=1` to fail instead, as CI does
for the published site. `--no-terrain` skips the tiles altogether.

### Attribution

The terrain tiles are made by Mapzen's [Joerd](https://github.com/tilezen/joerd)
from several sources, which ask for this
[attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md):

- ArcticDEM terrain data DEM(s) were created from DigitalGlobe, Inc., imagery
  and funded under National Science Foundation awards 1043681, 1559691, and
  1542736;
- Australia terrain data © Commonwealth of Australia (Geoscience Australia)
  2017;
- Austria terrain data © offene Daten Österreichs - Digitales Geländemodell
  (DGM) Österreich;
- Canada terrain data contains information licensed under the Open Government
  Licence - Canada;
- Europe terrain data produced using Copernicus data and information funded by
  the European Union - EU-DEM layers;
- Global ETOPO1 terrain data U.S. National Oceanic and Atmospheric
  Administration
- Mexico terrain data source: INEGI, Continental relief, 2016;
- New Zealand terrain data Copyright 2011 Crown copyright (c) Land Information
  New Zealand and the New Zealand Government (All rights reserved);
- Norway terrain data © Kartverket;
- United Kingdom terrain data © Environment Agency copyright and/or database
  right 2015. All rights reserved;
- United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data
  courtesy of the U.S. Geological Survey.

## Cache directory

What a run downloads or computes and can use again is kept in one cache
directory: `~/.cache/flown` by default, or `FLOWN_CACHE_DIR` when it is set. The
container image sets it to `/cache`, which `make build` mounts from `CACHE_DIR`
(see [Makefile variables](usage.md#makefile-variables-and-targets)), and
`--cache-dir` names one for a run (see
[Command-line options](usage.md#command-line-options)). Without a home directory
(no `HOME` and no entry in the password database, as in a container run under a
foreign user id) it is `flown-cache-<uid>` in the temp directory instead, with
the user id in its name. One there that is not a directory of that user alone (a
symlink, another user's, or one others may write to) is not used: the run warns
and caches in a fresh directory of its own, for that run only, which it removes
as it exits. One that others may only read is made the user's alone (mode 0700):
the parse cache holds the raw flights. Wherever the cache directory is, its
`kml/` is made the user's alone the same way (and the cache directory too, when
the run creates it), and its entries are readable by the user alone (mode 0600);
a `kml/` that is a symlink or another user's is not used, and the run parses
without the cache. Anything in it can be deleted at any time; the next run
fetches or computes it again.

| Entry                         | What it holds                                                                                                                                                                                                                                                                  | How long                                                                                                                                                                                                                                                 | Delete it to                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `terrain/`                    | The elevation tiles under the flights, `10-<x>-<y>.png` of about 100 KB each, and next to each its decoded pixels (`.pixels`, about as much again); by far the largest part, tens of megabytes for a few years of flights                                                      | For good: a tile never changes, so it is never fetched again                                                                                                                                                                                             | Free the space; the next run downloads the tiles under its flights again                                                   |
| `airports.csv`, `runways.csv` | The OurAirports airports (about 13 MB) and runways (about 4 MB)                                                                                                                                                                                                                | Downloaded again once 30 days old. `airports.lock` and `runways.lock` order the download among the processes of a run, and `airports.download-failed` or `runways.download-failed` marks a download that failed, which is not tried again within an hour | Download the database anew (or pass `--refresh-airports`); delete a `.download-failed` marker to try again within the hour |
| `kml/`                        | The parse result of every input file, one zstd-compressed JSON each (`.json.zst`), named by the file's content and name, the cache format, the parser code and the airport database, so a change to any of them misses the cache; about a seventh of the size of the KML files | Entries unused for 30 days are removed at the start of a run, and entries of another parser, format or database at once                                                                                                                                  | Parse every file again                                                                                                     |
| `previews/`                   | The link preview images, one PNG under a hash of the tracks it draws and of the code that drew it                                                                                                                                                                              | Images unused for 30 days are removed                                                                                                                                                                                                                    | Draw every image again                                                                                                     |

## Satellite imagery

The Satellite switch draws [Sentinel-2 cloudless 2024](https://cloudless.eox.at)
by EOX IT Services GmbH, a cloud-free mosaic of the Copernicus Sentinel-2 images
of 2024 with pixels of 10 m, which the page fetches from `tiles.maps.eox.at`
without a key. The map shows it to tile level 14 (about 6 m a pixel at 50
degrees north, `z` 14 in the UI), the last that adds detail, and stretches it
beyond. It is licensed
[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) for
non-commercial use, which this site is; a commercial one would need another
source. The map credits it while it is drawn, and an exported image carries the
credit:

> EOxCloudless [cloudless.eox.at](https://cloudless.eox.at) by EOX IT Services
> GmbH (Contains modified Copernicus Sentinel data 2024)

Nothing about the imagery is part of the build.
