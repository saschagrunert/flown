# Usage

How to run the generator: the file names it reads, the aircraft models, the
Makefile, the container image and the Python package, every command-line option,
and what to do when a flight does not come out as expected. The
[README](../README.md#quick-start) has the requirements and the quick start, and
[Adding flights](adding-flights.md) the workflow for a new flight.

## KML file naming convention

The tool detects and supports **two KML filename formats**. The extension is
matched case-insensitively (`.kml` and `.KML`).

### SkyDemon format

```text
N_REGISTRATION_TYPE.kml
```

**Example:** `1_DEHYL_DA40.kml`

Where:

- `N` - Sequential flight number (e.g., `1`, `42`, `87`)
- `REGISTRATION` - Aircraft registration without hyphen. The hyphen is restored
  from a table of ICAO registration prefixes (`DEHYL` becomes `D-EHYL`, `OEAKI`
  becomes `OE-AKI`)
- `TYPE` - Aircraft type designator (e.g., `DA40`, `C172`), see below

A registration has to look like one (capitals and digits, at least one letter);
a name such as `2025_summer_trip.kml` names no aircraft. It is published with
every flight, so it also has to start with an ICAO nationality mark: the part
before its hyphen, or any mark it starts with when written without one (`DEHYL`,
`OEAKI`, `9HABC`, `VH-ABC`). A mark of one character takes as many after it as
that state gives (four for `D`, `F`, `G`, `I`, `M`, `C` and `2`, three for `Z`,
three or four for `P`, three to five for `B`), and a US registration is `N` with
a digit other than zero and at most two letters at the end (`N12345`, `N123AB`).
Anything else (`1_ANNA_DA40.kml`, `1_MIKE_DA40.kml`) is dropped with a warning
and the type stays; a name that happens to have the shape of a registration
(`DAVID`, D-AVID) still passes. A name with more than three parts
(`7_DEAGJ_DA20_copy.kml`) keeps the first three and drops the rest with a
warning. Flight dates are not included in filenames for privacy.

The hyphen is restored for these nationality prefixes: `2`, `4O`, `5B`, `9A`,
`9H`, `CS`, `D`, `E7`, `EC`, `EI`, `ES`, `EW`, `F`, `G`, `HA`, `HB`, `I`, `LN`,
`LX`, `LY`, `LZ`, `M`, `OE`, `OH`, `OK`, `OM`, `OO`, `OY`, `PH`, `S5`, `SE`,
`SP`, `SX`, `TC`, `TF`, `UR`, `YL`, `YR`, `YU`, `Z3` and `ZA`. For a prefix not
in the list, write the registration with its hyphen in the file name
(`3_VH-ABC_C172.kml`); without it the registration is used as written. Files are
numbered sequentially in chronological order and processed in numeric order.

The type is published, so only an aircraft type designator is taken, in any case
and published in capitals (`da40` becomes `DA40`): a base of up to six letters
and digits that starts with a letter (`DA40`, `EC135`, `DA40NG`, `PA`), then at
most two hyphen groups, each starting with a digit (`PA-28-181`, `DR400-180`,
`G-109B`) or a variant of one or two letters right after a digit (`DA40-NG`),
and a digit somewhere in it. Of the types of letters alone, only the ICAO
designators for aircraft without a designator of their own are taken (`GLID`,
`ULAC`, `BALL`, `GYRO`, `SHIP`, `UHEL`, `PARA`, `ZZZZ`); any other is dropped
with a warning, a real designator as well as a name (`ANNA`), and so is anything
else (`DA40 with Anna`, `DA40-ANNA`).

Nor are times of day or weekdays: the type is published, so a `TYPE` that is one
(`1_DEHYL_1513h.kml`, `1_DEHYL_15h13.kml`, `1_DEHYL_Saturday.kml`) is left out
of the site, like a date (`1_DEHYL_2026-08-16.kml`), and
`make check-obfuscation` fails on the name.

### Charterware format

```text
YYYY-MM-DD_HHMMh_REGISTRATION_ROUTE.kml
```

**Example:** `2026-01-12_1513h_OE-AKI_LOAV-LOAV.kml`

Where:

- `YYYY-MM-DD` - Flight date with hyphens (validated)
- `HHMMh` - Flight time with 'h' suffix (validated)
- `REGISTRATION` - Aircraft registration with hyphen (e.g., `OE-AKI`, `D-EXYZ`)
- `ROUTE` - Route in DEPARTURE-ARRIVAL format (e.g., `LOAV-LOAV`, `EDDF-EDDM`)

The flight date used for the year filter is taken from the file's contents (the
`<description>` element, for a file without timestamps), never from the
filename. Neither the date nor the time of the name reaches the site.

Obfuscating the files renames them (see
[Privacy](privacy.md#obfuscating-the-kml-files-themselves)): the date becomes
January 1st of the same year and the time slot a sequence number per year and
directory, written as a time (`0000h`, `0001h`, ..., `0059h`, `0100h`). The
example becomes `2026-01-01_0000h_OE-AKI_LOAV-LOAV.kml`, and the next flight of
2026 in the same directory `2026-01-01_0001h_...`. Files are numbered in the
order of their original names, after the highest number already present, so the
names keep sorting in flight order. An existing file is never replaced.

**Note:** Charterware KML files do not include per-point timestamps. As
coordinates are not at fixed intervals, the tool does not attempt to infer
timing or speed data for Charterware files. The Groundspeed layer and the flight
time statistics are unavailable when viewing Charterware-only data. Altitude
visualization, path selection, and all other features remain available.

### Why these formats

The filename formats enable:

- **Aircraft filtering** - Filter map by specific aircraft registration
- **Per-aircraft statistics** - View distance and flight time per aircraft
- **Aircraft model lookup** - Full model names from `aircraft.json`
- **Route information** - Charterware files include departure and arrival
  airports

Without these formats, files will still be processed and paths will be
displayed, and they count towards the totals, but they belong to no aircraft:

- They are not in the aircraft filter, and selecting an aircraft hides them
- They appear in no per-aircraft statistics
- No aircraft model is looked up for them

## Aircraft model data

Aircraft model names are resolved from an `aircraft.json` file, a manually
maintained mapping of registrations (written as the map shows them; a key
without the hyphen, `DEHYL`, is read as `D-EHYL`) to full model names. The file
is looked up in the directory of every input file and in each directory above it
up to the directory given on the command line, so an `aircraft.json` in `data/`
covers the flights in `data/2025/` as well. The files found are merged into one
list that applies to every flight, wherever it lies. When two of them name the
same registration, a file in a subdirectory wins over one in a directory above
it, for the flights outside that subdirectory too, and otherwise the file found
first (in the order of the input files) wins:

```json
{
  "D-EAGJ": "Diamond DA-20A-1 Katana",
  "D-EHYL": "Diamond DA-40TDI Diamond Star"
}
```

When adding a new aircraft, add its registration and model to this file. Without
an entry the aircraft shows the type from the file name instead.

## Multiple directories

You can process KML files from several files and directories at once.
Directories are scanned with their subdirectories, and each directory given has
its own `aircraft.json` (see [Aircraft model data](#aircraft-model-data)); the
search for one never goes above it:

```bash
python -m flown data/ data-new/ extra_flight.kml --output-dir combined
```

The tool detects the format of each file and processes them accordingly.

## With an API key (optional)

**CARTO** - The base map is CARTO's dark-matter vector style, drawn by MapLibre
GL JS. It is free within CARTO's fair use limit and works without a key today,
but CARTO asks everyone to get one and may require it for vector tiles as it
already does for raster ones. The key goes on the style request and on every
tile, glyph and sprite request that follows from it. No other style is
supported: the heat steps the style's place names back and fades its border
bands, the satellite imagery goes in among its ground layers and the airport
codes are placed with its labels, all by the names of its layers.

```bash
# Pass the key on the command line or export it in the environment
make CARTO_API_KEY=your_carto_key

# Then serve
make serve
```

The key is published with the site by design (see
[SECURITY.md](../SECURITY.md#public-tile-api-key)): restrict it to your site's
domain (referrer restriction) in the CARTO dashboard. The `site` job of the
`test` workflow reads it from the `CARTO_API_KEY` repository secret.

The Aviation layer needs no key: its tiles come from
[open flightmaps](https://www.openflightmaps.org/), which covers most of Europe
and a few other regions and is credited on the map. Nor does the Satellite
switch (see [Satellite imagery](output.md#satellite-imagery)).

## Makefile variables and targets

Variables:

- `CONTAINER_RUNTIME` - Container runtime; auto-detects `podman`, then `docker`
- `INPUT_DIR` - Directory with the KML files (default: `data`)
- `OUTPUT_DIR` - Output directory (default: `docs`); it must not be `INPUT_DIR`,
  lie inside it or contain it, and the two need different base names
- `CACHE_DIR` - Host directory mounted as `/cache`, a relative one from where
  `make` runs (default: `FLOWN_CACHE_DIR` when it is set, else `~/.cache/flown`,
  see [Cache directory](output.md#cache-directory))
- `HOST_BIND` - Address `make serve` binds on the host (default: `127.0.0.1`;
  use `0.0.0.0` for the local network)
- `PORT` - Host port for `make serve` (default: `8000`)
- `CARTO_API_KEY` - Tile API key (passed by name, never printed)
- `FLOWN_SITE_URL` - The address the site is published at, for the link preview
  images (see `--site-url`)
- `SOURCE_DATE_EPOCH`, `FLOWN_COMMIT`, `FLOWN_REPOSITORY`,
  `FLOWN_STABLE_MTIMES`, `FLOWN_REQUIRE_AIRPORT_DB` and
  `FLOWN_REQUIRE_TERRAIN` - Passed into the container of `make build` when set
  (the commit and the repository are taken from your checkout otherwise)

Targets (`make help` prints this list with the current variable values):

- `build` - Build the image and generate `OUTPUT_DIR` from `INPUT_DIR` (leaves
  the input KML files alone)
- `serve` - Serve `OUTPUT_DIR` on `http://HOST_BIND:PORT` (run `make build`
  first)
- `serve-build` - Run `build`, then `serve`
- `test` - Build the frontend bundles and the site in docs/, then run the
  JavaScript and Python test suites with coverage
- `lint` - Run the linters, formatters (check only), type checkers and typos of
  the CI lint job
- `format` - Run formatters
- `lock` - Regenerate the lock files (`requirements.lock`,
  `requirements-test.lock`, `requirements-build.lock` and
  `requirements-tools.lock`) from `pyproject.toml` and `requirements-tools.in`
  with pip-compile
- `obfuscate` - Rewrite the KML files in `INPUT_DIR` in place so they carry no
  real dates (irreversible); with the host's `python` when it is Python 3.14,
  else in the container image
- `check-obfuscation` - Check that the KML files in `INPUT_DIR` and the fixture
  flights of the visual snapshots are obfuscated, where `obfuscate` runs
- `hooks` - Install the pre-push hook that refuses to push KML files with real
  dates, and the pre-commit hooks
- `clean` - Remove the container image (when a runtime is available) and local
  build artifacts, including the frontend build output in `flown/static/` and
  the fixture site of the visual snapshots (`visual-site/`)
- `help` - Show available targets and variables

Only `build`, `serve` and `serve-build` need podman or docker; `clean` also
removes the image when one of them is installed. The rest (`test`, `lint`,
`format`, `lock`, `obfuscate`, `check-obfuscation`, `hooks`, `help`) run
locally, from the virtual environment and `node_modules` (see
[CONTRIBUTING.md](../CONTRIBUTING.md)). With docker the containers run as your
user id so that generated files are not owned by root; with rootless podman the
Makefile adds `--userns=keep-id` so that the same user id works inside the
container.

## Docker usage

If you prefer using Docker directly. Input files are read and left alone, so
their directory is mounted read-only (drop the `:ro` to pass
`--obfuscate-inputs`, which rewrites them too). Mount the
[cache directory](output.md#cache-directory) so the OurAirports database and the
elevation tiles are not downloaded on every run, and run as your user id so the
output is owned by you (add `--userns=keep-id` with rootless podman):

```bash
# Build the image
docker build -t flown .
mkdir -p out ~/.cache/flown

# Generate out/ from the KML files in data/
docker run --rm --user "$(id -u):$(id -g)" \
  -v "$PWD/data:/data/data:ro" -v "$PWD/out:/data/out" \
  -v ~/.cache/flown:/cache \
  flown data --output-dir out

# With the API key (inherited from the environment, its value is not echoed)
docker run --rm --user "$(id -u):$(id -g)" -e CARTO_API_KEY \
  -v "$PWD/data:/data/data:ro" -v "$PWD/out:/data/out" \
  -v ~/.cache/flown:/cache \
  flown data --output-dir out

# Debug output
docker run --rm --user "$(id -u):$(id -g)" \
  -v "$PWD/data:/data/data:ro" -v "$PWD/out:/data/out" \
  -v ~/.cache/flown:/cache \
  flown --debug data --output-dir out

# Serve the generated site on http://127.0.0.1:8000/ (mounts out/ only, read-only)
docker run --rm -p 127.0.0.1:8000:8000 -e BIND_HOST=0.0.0.0 \
  -v "$PWD/out:/data:ro" --entrypoint python flown /app/serve.py
```

The image runs as an unprivileged user, uses `/data` as its working directory
and `FLOWN_CACHE_DIR=/cache`. `make build` and `make serve` also pass
`-e HOME=/tmp`, since the user id they run as has no entry in the image's
password database; the commands above go without it, because the cache is
`/cache` either way and the tool falls back to a directory under the temp
directory when it has no home (see
[Cache directory](output.md#cache-directory)). `serve.py` serves `DATA_DIR`
(default `/data`) and reads `BIND_HOST` (default `127.0.0.1`, hence `0.0.0.0`
inside the container), `PORT` (default `8000`), `CORS_ORIGIN` (unset by default)
and `OPEN_URL`, the address it prints (default `http://localhost:PORT/`;
`make serve` passes the host's). It sends `Cache-Control: no-store`, for
development; the headers of a published site are in
[Hosting](hosting.md#headers-and-compression).

## Python usage

From a fresh clone, build the frontend bundle first (it is not committed, and
the generator refuses to run without it):

```bash
npm ci && npm run build

pip install .                     # the runtime dependencies from pyproject.toml
python -m flown your_track.kml   # writes docs/; use --output-dir for another place

# Serve it over HTTP, then open http://127.0.0.1:8000/
python -m http.server 8000 --bind 127.0.0.1 -d docs
```

Opening `docs/index.html` from disk does not work (see
[Quick start](../README.md#quick-start)). To publish the directory, see
[Hosting](hosting.md).

`pip install .` also provides the `flown` console script and ships the templates
and static assets.

## Command-line options

```text
flown [--version] [--output-dir DIR] [--force] [--site-url URL] [--list]
            [-q] [--debug] [--obfuscate-inputs] [--private] [--no-terrain]
            [--cache-dir DIR] [--refresh-airports] [--jobs N] path [path ...]
```

`flown --help` lists the options in the groups below; `--version` prints the
version and exits.

- `path` - KML or KMZ files and/or directories. Directories are scanned with
  their subdirectories for `.kml` and `.kmz` files (case-insensitive) and
  processed in numeric order per directory; the AppleDouble files of macOS
  (`._1_x.kml`) and `.git` are skipped. `aircraft.json` is looked up next to
  every input file and above it (see
  [Aircraft model data](#aircraft-model-data)). A path that does not exist is an
  error, and a file named twice is read once.

Output:

- `--output-dir DIR` - Output directory (default: `docs`). The tool refuses to
  run if the output directory is the directory of an input file or contains one,
  or is a directory it must never clean out (`/`, the home directory). An output
  directory below the input directory is fine, so `flown flight.kml` in the
  file's directory writes to `./docs/`. It also refuses an output directory that
  holds files the site is made of (an `index.html`, a `styles.css`, a
  `data/airports.json` and the like) but no sign of an earlier run
  (`map_config.js`, `data/metadata.json`): many a project keeps a site of its
  own in `docs/`, and the run would replace it file by file.
- `--force` - Replace the files of a site in the output directory that no
  earlier run wrote (see `--output-dir`)
- `--site-url URL` - The address the site is published at, such as
  `https://example.org/flights` (default: `FLOWN_SITE_URL`). A link preview
  names its image by an absolute URL, which the build cannot know by itself:
  with the address the site, each year and each flight get a preview image (see
  [Link previews](output.md#link-previews)), without it the previews go without
  one. CI fills it in from the Pages configuration.
- `--list` - Print a table of every flight in the inputs (file, year, aircraft,
  airports as the site names them, without their dates, points, whether it has
  times) and, for each one the site would leave out, why: no year, a recording
  that never moves, a copy or a second recording of another flight. A file the
  build refuses (empty, not valid KML, does not parse, holds no flight to
  export) is marked "fails the build", since a build of it fails and publishes
  nothing. Below the table it names the airport names not from the airport
  database the site would publish (see
  [Privacy](privacy.md#what-reaches-the-site)). It writes no site and downloads
  no elevation tiles; the parse cache and the airport database are used and
  filled as by a build. It exits with 0, or with 2 when a build of the inputs
  would fail, as the build would.
- `-q`, `--quiet` - Print only warnings and errors, and one line at the end
  naming the output directory and the years in it
- `--debug` - Show debug output (it wins over `--quiet`)

Privacy:

- `--obfuscate-inputs` - Also rewrite the input KML files themselves, in place
  and irreversibly, so that the files on disk carry no real dates either. Off by
  default: the generated site never carries a flight date finer than the year
  whatever the inputs hold (see [Privacy](privacy.md)), so this is about the KML
  files, not about what gets published. Like `make obfuscate`, it also takes the
  dates out of names, descriptions and file names and renames the files that
  held one (see [Privacy](privacy.md#obfuscating-the-kml-files-themselves)).
  Keep a copy of the originals first. A `.kmz` input is refused: the dates
  inside a zip archive can be neither checked nor rewritten, so unzip it and
  keep the `.kml` file.
- `--private` - Ask search engines not to index the site: the page gets a
  `<meta name="robots" content="noindex, nofollow">` (the link preview pages
  carry `noindex` in every build). The site stays public to anyone who has the
  address. The tool writes no `robots.txt`; see
  [Hosting](hosting.md#keeping-it-out-of-search-engines) for keeping crawlers
  out entirely.

Network and cache:

- `--no-terrain` - Do not sample the ground under the flights from the elevation
  tiles (see [Elevation data](output.md#elevation-data)); nothing is downloaded
  for it, and the 3D view puts each flight on a line between its airfields
- `--cache-dir DIR` - Where the OurAirports database, the elevation tiles, the
  link preview images and the parse cache are kept (default: `FLOWN_CACHE_DIR`,
  else `~/.cache/flown`)
- `--refresh-airports` - Download the OurAirports airport and runway lists again
  instead of using the cached copies, which are otherwise renewed every 30 days.
  It marks the cached copies expired rather than deleting them, and a complete
  download replaces them; offline, the run goes on with them and warns
  `Could not refresh the airport database, using the cached copy`, as it does
  when a download after 30 days fails.
- `--jobs N` - Use at most `N` worker processes for parsing, decoding elevation
  tiles, exporting and drawing the link previews (default: one per CPU the
  process may use, within a container's CPU quota)

### How the output directory is written

Every file is written into a hidden staging directory inside the output first
and moved into place only when the whole site was generated, so a run that fails
while generating leaves the previous site untouched. Only a failure while the
finished files are moved into place (a disk filling up in that moment) can leave
a mix, which the next run repairs. Two runs cannot write to one output directory
at the same time; the second one stops. Afterwards the tool removes only its own
files that the new site no longer has (the files of years that dropped out, a
stale `mapApp.bundle.js.map`) and leaves anything else in the output directory
alone, such as a `CNAME` or a `robots.txt` of your own. It never writes through
a symlink: a symlink in place of one of its files stops the run. With
`FLOWN_STABLE_MTIMES=1` every published file gets a modification time taken from
its content (some day between 2001 and 2010), so a server that derives its ETags
from it, as GitHub Pages does, keeps them for the files a new build did not
change; CI sets it for the deployed site. Leave it off for a server that
compares the times by age (`python -m http.server`). Without it a file is dated
to 00:00 UTC of the build day (`SOURCE_DATE_EPOCH`, see
[Privacy](privacy.md#what-the-site-carries)), never the time of the build: a
bundle, stylesheet or icon a build did not change keeps its time, every file the
flights decide (the data, the page, the flags and previews) gets the build day,
and one that changed again on the same day gets a second more each time. A time
that is no such day, left by an older build or another tool, is replaced by the
build day. The directories a build writes in (the output and data directories,
the years, `vendor/`, `flags/` and the previews) get the build day as well, or
one fixed time in 2001 with `FLOWN_STABLE_MTIMES=1`. The headers a host should
send are in [Hosting](hosting.md#headers-and-compression).

### Exit status

Every failure ends in one line on stderr, `Error: ...`, after the messages that
led to it, and the exit status says what kind it was:

- `0` - The site was written (or, with `--list`, the table printed of inputs a
  build accepts).
- `2` - The command cannot work with what it was given: a usage error (an
  unknown option, `--jobs 0`), a missing input path, no KML files, an input file
  that is not valid KML or cannot be parsed (such as an empty file, a symlink or
  a `.kmz` without a `.kml` in it), an input file without a flight to export (no
  track with altitudes above sea level, none with a determinable year, or none
  that moves), a relative `--site-url`, or an output directory it refuses (see
  `--output-dir`). `--list` exits with it after the table when the build would
  stop on one of these inputs.
- `1` - The build failed on the way: a missing JavaScript bundle, a required
  airport database or elevation tile that is unavailable, an unwritable output
  directory or a full disk, an input file `--obfuscate-inputs` could not scrub.
- `130` - The run was interrupted (Ctrl+C); the previous site is left as it was.

## Troubleshooting

The build log names the file in every warning. `--debug` (or
`flown --debug <file>` on a single file) shows what the parser found.

### A flight is missing

Look for these lines:

- `Excluding path without a determinable year: <file> (<name>)`: the parser
  found no date. It takes the year from the track's own times (the first
  `<when>` of a `gx:Track` that belongs to a point of the path, so a flight
  across New Year stays in the year it started in, or a `<TimeStamp>`), then
  from a `<TimeSpan>`, then from a date in the track's placemark name
  (`EDDS to EDDP - 16 Aug 2026`), then from a Charterware `<description>` and
  finally from a `<TimeStamp>` or `<TimeSpan>` of the enclosing `<Folder>` or
  `<Document>`, never from the file name. A time that cannot be read (neither
  ISO 8601, `YYYY-MM-DD HH:MM:SSZ` nor a date without a time of day such as
  `2026-08-16`, `2026-08` or `2026`) does not count. Export the flight again
  with its times. This only leaves out a track of a file that has another one to
  export; a file none of whose tracks has a year stops the run (see below).
- A `gx:Track` time more than seven days from the track's median, or out of
  order with its neighbours, is a logger glitch: that point loses its time (and
  so its groundspeed), the rest of the track keeps theirs. A position of exactly
  0,0 is dropped as a missing fix.
- The file is not picked up at all: only files ending in `.kml` or `.kmz` (in
  any case) are read. A `.kmz` archive is read without unpacking it: its
  `doc.kml` at the root, or else its first `.kml` file, is the flight, up to the
  100 MB of a KML file (the files macOS adds to a zip, `__MACOSX/` and `._`
  names, are skipped). An archive with another archive in it, none with a `.kml`
  in it, or one that is encrypted or uses a compression Python cannot read (such
  as Deflate64) stops the run. The obfuscator cannot rewrite inside an archive,
  so `make check-obfuscation` and the hooks fail on one; unzip a `.kmz` before
  committing it.

### The run stops

One broken file stops the whole run, so a site never silently misses a flight:

- `<file>: No valid coordinates found` or `Error processing <file>`, followed by
  `<n> of <m> file(s) failed to parse`: the file holds no track the parser
  reads, or it is not valid KML (not XML at all, or cut off before its first
  track). A file cut off later, as a logger whose battery ran out leaves it, is
  read up to where it ends, with a warning that gives the parser's message with
  the line (`<file>: damaged, the points after it may be missing (...)`); white
  space before the XML declaration and `gx:` elements without the declaration of
  their namespace are read as if they were right. Only `LineString` and
  `gx:Track` geometry (also inside a `MultiGeometry`) forms a flight; polygons
  are skipped with a warning. So is a track whose `altitudeMode` is
  `clampToGround` or `relativeToGround`, because its altitudes are not above sea
  level. A track without `altitudeMode` is read as absolute, which is what
  flight logs write.
- `<file>: <reason>`, followed by `<n> of <m> file(s) hold no flight to export`:
  the file has coordinates, but nothing of it would reach the site. A file whose
  flight is only skipped as a copy of one in another file (see below) does not
  stop the run. The reason says why:
  - `no track of two or more valid points (waypoints are none)`: a waypoint file
    or one that marks places on the map, which holds no flight, or a line of
    which only one point is valid
  - `no track of two or more points with altitudes above sea level`: it holds
    lines without altitudes (a route plan), or tracks clamped to or relative to
    the ground
  - `no track with a determinable year`: see above for where the year comes from
  - `every track with a year stays on one spot`: a recording that never moved
- `<n> of <m> input file(s) are not valid KML files`: a file is empty, a symlink
  or larger than 100 MB.

Fix or remove the file and build again.

### The flight shows the wrong aircraft, or none

The registration comes only from the file name. Check the name against the
pattern: `N_REGISTRATION_TYPE.kml`, where a fourth part and any after it are
dropped with a warning, or the Charterware pattern with a valid date and time.
The registration part has to look like one: capitals and digits with at least
one letter, `DEHYL` or `D-EHYL`. A name that does not (`2025_summer_trip.kml`)
names no aircraft, and neither does a four-letter ICAO code after a date
(`20250601_EDDS_EDDP.kml`). The hyphen is only restored for the nationality
prefixes the tool knows (see [the list](#kml-file-naming-convention)); any other
registration is used as written, so write it with its hyphen the way it should
appear. A model name that is missing or wrong comes from `data/aircraft.json`;
its keys may be written with or without the hyphen and in any case. With several
input directories, the nearest `aircraft.json` wins (see
[Aircraft model data](#aircraft-model-data)).

### An airport is not recognized

The airport names come from the track's placemark name (SkyDemon names it after
the route, such as `EDCM Kamenz - EDAC Leipzig-Altenburg Airport`) or from the
route in a Charterware file name (`LOAV-LOAV`), and the ICAO codes in them are
looked up in the [OurAirports](https://ourairports.com/) database:

- `Airport database unavailable`: the database could not be downloaded, so the
  names stay as the KML file spells them and have no country. Run the build
  again with network access; CI refuses to publish without it. A download that
  failed is not tried again for an hour: to force one, pass
  `--refresh-airports`, or delete `airports.csv`, `runways.csv` and the
  `.download-failed` markers from the
  [cache directory](output.md#cache-directory).
- A code OurAirports does not know keeps the name from the file. A name without
  an ICAO code is shown as an airport only as an end of a route
  (`Home strip - Aunt farm`), and not as a single word (`Home`). Any other
  placemark name without a code (`Flight with Anna`) is free text: its start
  gets no marker and does not count as an airport in the statistics either,
  since a route end counts only where it has a marker.
- A recording that starts in the air (more than 400 m above the airport and
  level) gets no departure marker, and the arrival only gets one when the name
  is a route and the track ends in a landing. A name that is a single airport
  (`EDDS` for a local flight) gets its marker at the start, and the flight
  counts for it.
- Markers with the same ICAO code are merged into one. A name without a code is
  merged with the marker of the same name, wherever that is, or else with a
  marker closer than 1.5 km. Two different ICAO codes are never merged, however
  close the airports are.

### A flight appears twice

The same file named twice on the command line (directly and through its
directory) is read once, with `Ignoring duplicate input`. The same flight in two
files, such as one export copied under two numbers, is kept once and the copy is
skipped with a warning. So is the same flight recorded twice, by a phone and the
panel GPS or exported by two tools: two recordings with times that overlap by
more than half of the shorter one, and are in the same place at the times they
share, are one flight. The clocks of obfuscated files need not agree, since each
starts at midnight: such recordings are lined up by where they flew, and then
have to be within 150 m of each other. So are two on real clocks that are off by
a few seconds (GPS time runs 18 s ahead of UTC), or two files whose clocks are
off by whole half hours (a device that writes the local time as UTC) and whose
takeoffs and landings agree once lined up. Two recordings that name two
registrations are never one flight: two aircraft flying in formation are as
close as one flight on two loggers, and two flying one circuit an hour apart
would line up as well. The one whose file name gives the aircraft stays,
otherwise the one with more points, and the warning names both files. The
skipped one adds no airport and does not widen the map. Delete the copy from
`data/`.

### One flight shows as several, or two as one

A logger that writes a long track as several `LineString`s, each starting where
the one before ended, splits one flight into pieces, and the parser joins them
again: a line continues the one before it when both have the same placemark
name, the one before did not end on the ground, and the line starts within 50 m
of its end, at the same `<TimeSpan>` or within 30 minutes of its end. Without
times, only the point of the split written twice joins them. A `gx:Track` is
never joined. Give the pieces of a flight one name, and flights of their own
different names or times.

### The flights show but the map behind them is black

The flights, the airports and the heat are in the site itself; the map under
them is streamed from CARTO (`basemaps.cartocdn.com` for the style,
`*.basemaps.cartocdn.com` for its tiles, glyphs and sprite; see
[With an API key](#with-an-api-key-optional)). Flights over a black map mean
those requests fail: a proxy, a firewall or an ad blocker blocks the host, or,
on a site built with a key, the key is wrong, expired or restricted to another
referrer. When the style itself cannot be loaded the page says so and offers
Retry; blocked tiles, glyphs or sprites only leave holes and a line in the
browser's console. To tell the two apart, open the browser's developer tools on
the Network tab, reload and filter for `cartocdn`: a request shown as blocked,
cancelled or failed without a status points at the network or an extension, so
try another network or switch the blocker off for the site; a `401` or `403` on
the style request points at the key, so check it and its referrer restriction in
the CARTO dashboard, or build without one, since the base map loads without a
key today. Nothing of the site is lost either way: the flights, the statistics
and Replay work over the black map.

### `make check-obfuscation` or the commit hook fails

Run `make obfuscate`, then check again. It takes the dates, parts of dates,
times of day, weekdays and holidays out of names, descriptions and file names
(`1_DEHYL_DA40_16Aug.kml` becomes `1_DEHYL_DA40.kml`). When a date cannot be
removed (in an element the tool does not rewrite, or from a file name that is
taken without it or has nothing left), the rewrite names the file and the date
and stops rather than leaving it half scrubbed; remove the date by hand. The
same goes for a weekday, a holiday or a time of day anywhere else in a file
besides its timestamps, and for a date split by a CDATA section
(`16.<![CDATA[08]]>.2026`). A directory the check cannot list fails it too: fix
its permissions. A trip whose legs on several days are less than 12 hours apart
is one flight that runs past the days after January 1st: split the file into one
per day of flying, as the check says. The pre-push hook also refuses a commit
message that dates a flight it adds or changes (`Add flight 16 Aug 2026`):
reword it with `git commit --amend` or a rebase. Four digits that are a year and
a time at once, such as `2026 local` (20:26), count as a time. A duration
written like a time of day (`Flight time 1:25`) cannot be told from one and has
to go as well. A place named after a weekday other than `Friday Harbor`,
`Thursday Island` and `Sunday Creek`, or after a holiday other than
`Christmas Island`, `Christmas Creek`, `Easter Island`, `Pentecost Island`,
`Weihnachtsinsel`, `Christmas Flying Service` and the others followed by
`Harbour`, `Island`, `Creek`, `Valley`, `Coast`, `Hill`, `Township`, `Province`,
`Field`, `Airfield`, `Airport` or `Airstrip` (or their plurals), needs another
name as well. That takes the Scottish `Easter` (eastern) of
`Easter Nether Cabra Farm Airstrip` and the first name `Silvester`
(`Silvester Meier`) along, and `SAT` (San Antonio) right before a time goes as a
weekday (`KAUS to SAT 14:30` becomes `KAUS to`).

A number of ten or thirteen digits in the text of an element (not in an
attribute, and not the id after the `#` of a reference such as
`<styleUrl>#1712345678901</styleUrl>`) that reads as a Unix time between 2000
and today, in seconds or milliseconds, fails the check unless it is midnight on
January 1st: `Unix time not at midnight on Jan 1, remove it: 1710406320`. The
rewrite takes it out of names and descriptions; anywhere else it cannot tell
whether it is a time or some other number, so it leaves it alone: remove or
change it by hand. Numbers that would be a time after today, such as most phone
numbers, pass, and so do the distances and angles of a view (`<range>`,
`<altitude>`, `<heading>`).
