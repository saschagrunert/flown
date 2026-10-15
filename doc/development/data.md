# Data

The Python side and the data it writes: the package and its locked dependencies,
how the parser joins split tracks and drops second recordings of a flight, how
the groundspeed of a row is averaged, the format of the year files, the
elevation tiles the build samples, and the year worker that decodes the files in
the page. What the files hold is described for users in
[Output and technical details](../output.md).

## Python package and dependencies

The dependencies are declared once, in `pyproject.toml`: the runtime
dependencies plus the `test` and `dev` extras, and the `build` dependency group
with the setuptools that builds the package. CI, the container image and the
setup in [CONTRIBUTING.md](../../CONTRIBUTING.md#setup) install what `uv.lock`
pins with `uv sync --locked`, with the hashes it records, so nothing is resolved
from the ranges. None of them installs the package into that environment: the
tests and the site builds run it from the checkout, the container image copies
the sources and runs them from `PYTHONPATH`, and the packaging job of CI builds
the wheel from the `build` group without build isolation and installs it on its
own. Run `uv lock` after changing the dependencies, or `make lock` to move every
package to its newest release.

### Runtime dependencies

- `lxml` - Fast XML parsing for KML files
- `rcssmin`, `minify-html` - Output minification (HTML/CSS)

## Split tracks and recordings of one flight

`_join_split_lines` in `flown/parser_standard.py` joins the `LineString`s of a
file that are one flight in pieces. A line continues the one before it
(`_continues`) when both have the same name, the one before has not landed
(`_ends_on_ground`: it came back down to within 30 m of its lowest altitude
after climbing 150 m above that, or its last three points stand within 15 m of
each other), and the line starts within 50 m of where the one before ended, with
the same time span or within 30 minutes of its end. Without times, or without a
name, only the point of the split written twice (the same longitude, latitude
and altitude) joins them. A document `TimeSpan` over a flight out and one back,
or two untimed flights of a placemark named after the aircraft, stay two
flights. `gx:Track`s are never joined.

After `drop_duplicate_paths` in `flown/path_content.py` has dropped the exact
copies, `drop_overlapping_paths` in `flown/duplicates.py` drops a recording of a
flight another one of the same year records as well: two timed recordings are
one flight when they overlap in time by more than half of the shorter one and
are within 300 m of each other at 20 moments spread over the time they share
(two of them may be further apart). That holds for recordings on the real clock,
the files of a user who does not obfuscate them. Obfuscated files, though, start
every flight at midnight on January 1st, so two recordings of one flight line up
only if they were started in the same second, and every flight of a year
overlaps every other.

Two real clocks may be off, though: a phone on its own clock, a logger that
writes GPS time (18 s ahead of UTC), or one that writes the local time as UTC.
Two recordings on real clocks that the comparison as they are tells apart are
therefore lined up as below as well, but only by a shift two real clocks are off
by (`_real_clock_shift`): up to a minute, or within 25 s of a whole number of
half hours up to 15 hours. Two that neither moved at about one time nor took off
about a whole number of half hours apart are not lined up at all
(`_clocks_may_line_up`), which spares finding the shifts of most pairs of
flights of one day. Two flights of one day the same way at the same pace would
line up at some shift; the rule keeps them apart unless they flew that close to
a whole number of half hours apart, took off and landed together within 15 % of
the shorter one's time in the air (30 s at least), and stayed within 150 m all
the way. A shift of half hours lines up recordings of two files only: one file
was written by one clock, so the circuits of a session in it never line up with
each other. Two files are two by their paths, folders and all (`source`, set by
the run): two folders may hold files of one name. No shift lines up two
recordings that name two registrations (`_two_aircraft`), nor does any
comparison: two aircraft flying in formation are as close as one flight on two
loggers, and two flying one circuit an hour apart line up as well as one flight
on two clocks. Two circuit flights of one aircraft, or of files that name none,
flown an hour apart to within 25 s with as many laps at the same pace, would
still count once. Only Nepal and the Chatham Islands keep a time zone off by a
quarter hour; a logger there writing the local time as UTC counts its flight
twice. Recordings on real clocks more than 15 hours apart are never compared:
the kept ones are gone through in the order they started, and one that ended
that long before a recording started is passed over for it and every later one
(`_MAX_CLOCK_OFFSET_S`). That took a year of 8,000 flights from one field from
17.8 s to 1.5 s, where every recording was compared with every other before.

Where one of two recordings starts in the first three days of its year
(`_clock_known`), only the time from its takeoff run to its last landing counts
(`_Timed.moving`, faster than 20 m/s over 10 s), since two flights from one
field stand and taxi in the same places. At 20 moments of the shorter one,
`_clock_shifts` looks up (in a grid of 300 m cells, which also holds the lines
between fixes far apart) when the other passed closest to where it was, and a
shift of the clock that at least three of them agree on to within 5 s is checked
as above, but within 150 m: with the time free, circuits flown at one field on
different days come within 300 m often enough. Every two recordings of a year
are compared, which most flights from one field pass the first look at (their
areas overlap), so the 20 moments of each recording are worked out once, and a
set of the cells the other comes near (`_Timed.reach`) leaves out the moments it
cannot be found near before a line of it is looked at: two flights that are near
each other at fewer than three of them are none. That halved the time of a year
of 1,000 flights made of the flights of `data/`, each copied a few hundred
metres off, from 23 s to 11 s.

The flights of `data/` all start at the same moment, and the two of them that
come closest to one flight (two flights of D-EAGJ at EDAQ) are still apart at 11
of the 20 moments. A copy of each of them with 11 m of noise and a clock of its
own is found for all 103, and for 98 of them when it keeps every tenth fix only.
The recording that names the aircraft stays, its registration first and then its
type, and of two that name as much the one with more points; the warning names
both files. Recordings without times are not compared.

Both drops run in `select_exported_paths` in `flown/data_exporter.py`, before
`_export_site` in `flown/pipeline.py` takes the map extent and the airports from
the paths that are left: a dropped copy or recording neither widens the map nor
adds an airport.

The parser drops XML comments and processing instructions while it reads a file
(`remove_comments` in `_parse_kml_tree`), so a comment inside a `<coordinates>`,
a `<gx:coord>`, a `<when>` or a `<name>` no longer ends its text there; the
obfuscator reads a `<when>` past a comment the same way.

## Groundspeed

The groundspeed of a row is the average over the segments that start within a
minute of it (`SpeedWindow` in `flown/segment_calculator.py`,
`SPEED_WINDOW_SECONDS` wide), standing still included. A segment longer than the
window (`outlasts_the_window`: a paused logger, a lost fix) stays out of it,
since it would enter with all of its time and take the minute before it down to
a few knots. Its own row takes the window around its start, or its own speed
where that window is empty, as with a logger that writes a fix every few
minutes. A row without times gets its share of the path's average speed.

## Year file format

The year files are data format 7 (`FORMAT_VERSION` in `flown/segment_codec.py`,
`DATA_FORMAT_VERSION` in `services/yearDecode.ts`; bump both together, the page
refuses any other).

Format 7 writes the latitude and longitude columns as second differences: each
value is how much the step from the row before changed, the step before the
first row counting as zero. An aircraft holds its course and speed for many
rows, so the latest year on `data/` shrank by 8.5 % raw and 7.3 % gzipped. The
other columns stay first differences, which their second differences made
larger. Rounding the times to whole seconds would have saved another third of
the time column, but a segment shorter than the rounding then took no time, and
the heat of the map moved with it.

Format 6 wrote the groundspeeds in whole knots instead of tenths of a knot. The
exporter rounds them to whole knots already (`exported_knots` in
`flown/export_pipeline.py`), so the tenths only added a trailing zero to every
speed difference: 2.3 % of the year files on `data/`, 0.9 % gzipped. The encoder
refuses a speed that is not a whole number of knots. Times stay at a tenth of a
second, which the replay needs for fixes less than a second apart.

Format 5 wrote the altitudes in steps of 20 ft instead of 100 ft, which cost
about 4 % more gzipped year files on `data/`, and added the landings of every
flight with timestamps to its `path_info`: `landings`, `touch_and_goes`,
`go_arounds` and the `touchdowns` as `[airport, runway]`. `flown/landings.py`
reads them with the parse of each file (in the parse workers) from the
full-precision track, with the fields and the runways of the OurAirports
database (`load_runway_database` caches `runways.csv` next to `airports.csv`),
and the parse cache keeps them with the paths; its key covers both databases.
The page only adds them up.

Format 4 added a `ground` column per path: the ground under every row in steps
of 10 ft, as differences like the other columns, left out for a path whose
ground is not known. `flown/terrain.py` computes it at build time from the
Terrarium elevation tiles of AWS, shifted to meet the altitudes the flight
recorded taxiing at both ends, so the correction lives in one place and the page
only reads the result (`groundProfileFt` in `calculations/groundProfile.ts`
falls back to the line between the fields without it). The statistics panel
measures the cruise above that ground as well, and says "above field" instead of
AGL when a flight had none and was measured above its own lowest altitude.

### airports.json

`airports.json` is not versioned: the site is always built with its data, and
the page reads it as it is. Its `code` field (the ICAO code in the name,
`airport_icao_code` in `flown/airport_lookup.py`, which also merges the
airports) came with format 4 of the year files as an addition: the page shows
the code the export found rather than reading the name again, and an airport
without a code shows none.

## Elevation tiles at build time

The tiles (zoom 10, about 100 KB each) are cached as PNGs in `terrain/` of the
[cache directory](../output.md#cache-directory) and decoded by a small
pure-Python PNG reader in a process pool; `data/` needs 389 of them, 44 MB. The
decoded pixels of a tile are kept next to its PNG (`<tile>.pixels`, compressed
with zstd, checked against its CRC), so a later build reads them in a fraction
of a millisecond instead of decoding the PNG again. A tile is only cached once
its every chunk checks out, so a download cut short is fetched again rather than
kept. A failed request or a server error is tried again three times, with pauses
of 1, 2 and 4 s. When the last attempt could not reach the host at all, the host
is given up for the run. A server error only costs that tile, unless three tiles
in a row (across the fetch threads, without a tile that got through between
them) used up their attempts on server errors: then the host is given up as
well, rather than every tile of the run spending its attempts and pauses. Each
fetch thread keeps one connection to the host, through the proxy that
`HTTPS_PROXY` names unless `NO_PROXY` exempts the host, and a redirect away from
the host or from https is refused. Offline, or for a tile that cannot be
fetched, the build goes on and the flights under it get no ground; one warning
says how many. `FLOWN_REQUIRE_TERRAIN=1` fails it instead, which the CI job that
deploys the site sets. The ground is sampled once in the main process and kept
as one array of elevations per path, aligned with its points
(`sample_path_elevations`), which is what the export chunks are handed: a
million points take tens of megabytes this way, where a mapping of coordinates
took more than a gigabyte. `--no-terrain` skips the tiles altogether, which
`scripts/build_visual_site.py` does: its snapshots show no 3D view. The CI jobs
that build from `data/` restore the tile cache with `actions/cache`.

## The year worker

`yearWorker.bundle.js` is a build of its own and shares nothing with the others:
it is everything that works on the year files, and on the heat sources made of
them. The page head preloads it (a `modulepreload` beside the shared chunk), so
its download overlaps the app's; the loader imports it with the first year file
(`services/dataLoader.ts`), and the file then starts itself a second time as a
module worker, which parses and decodes the year files off the main thread and
hands the columns back as typed arrays; the page builds its dataset from them a
few milliseconds at a time (`services/yearDecoder.ts`,
`services/yearDataset.ts`). The worker also draws the heatmap's heat and writes
the GeoJSON of the heat sources and of the lines along the flights (the heat
lines and the colour layers' lines, `services/flightLines.ts`), which MapLibre's
worker reads from Blob URLs (see
[The heat sources and the year worker](heat.md#the-heat-sources-and-the-year-worker)).
Where the worker cannot be used, the same code runs on the main thread.
