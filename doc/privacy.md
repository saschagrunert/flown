# Privacy

What the generated site holds and what it leaves out, what the page and the
build ask other servers for, and how to scrub the KML files themselves.

## What the site carries

**The generated site carries no flight date finer than the year.** Flight paths
keep only relative seconds since the start of each flight, which is enough for
the replay and the speed colours; a flight keeps its year, and nothing else.
That holds whatever the input files contain, so nothing has to be done to them
before generating a site. The site shows where you have been and how much you
have flown, but not when.

The one full date it carries that depends on the flights is when it was built:
`map_config.js` holds the build date (the day in UTC, without the time) and the
short hash of the commit it was built from, and the statistics panel shows both.
It also holds a hash of the generator's own files (`generator`), which the tests
compare with the checkout and which holds no date. A site built right after a
flight therefore hints at the day of that flight, but not at its time. The files
carry the day as well, as their modification time, which a server sends as
`Last-Modified`: 00:00 UTC of the build day, and a second later for a file a
second build of the day changed. Every file the flights decide (the data, the
page, the flags and the previews) gets the build day on every build, changed or
not, so none of them keeps the day of the build that first published it, which
would date its flight; only a bundle, stylesheet or icon a build did not change
keeps its time. A time an older build or another tool left, which can hold the
time of day, is replaced by the build day. The directories a build writes in get
00:00 UTC of the build day as well, which a directory listing would show
otherwise. With `FLOWN_STABLE_MTIMES=1` the time is taken from the content
instead (see
[How the output directory is written](usage.md#how-the-output-directory-is-written)).
Set `SOURCE_DATE_EPOCH` to stamp a different day. The commit is `FLOWN_COMMIT`
(with its remote in `FLOWN_REPOSITORY`, which `make build` sets from your
checkout), else `GITHUB_SHA` on GitHub Actions (in the repository
`GITHUB_REPOSITORY` names, on the server `GITHUB_SERVER_URL` names, which is
`https://github.com` unless the workflow runs on GitHub Enterprise, so the link
is right on a fork as well), else `HEAD` of the checkout the tool runs from. The
hash links to the commit only when the repository is known.

That is the site. A repository the KML files are committed to keeps its own
dates: a public one dates every committed flight to the day of its commit, in
the commit itself, in the Actions run it started and in the Pages deployment
that followed, however well the files are obfuscated. Whoever publishes their
flights in a public repository should therefore push them in batches, some time
after the last of them, so that no push dates a flight. Coarse commit dates
(`GIT_AUTHOR_DATE` and `GIT_COMMITTER_DATE` set to the first of the month, say)
only hide the date inside the commit: when it was pushed is public whatever the
commit says, in the Actions run the push starts, in the events GitHub lists for
the repository and in the Pages deployment that follows. So are the title and
the description of a pull request, and the name of the branch it comes from. The
pre-push hook (`make hooks`) warns when a push adds the flights of one trip: up
to three flights, or legs that each start where the one before ended and come
back to the field of the first only at the end. It refuses a push to a branch
whose name holds a date, a weekday or a holiday when the commits pushed to that
branch add or change a flight (`flights-2026-08-16`); a branch of code pushed
along with them passes. To a remote never fetched from it only warns: it cannot
tell new flights from those the remote already has.

## Your input files

**Your input files are read and left alone** unless you pass
`--obfuscate-inputs`, which cannot be undone.

## Requests to other servers

Every server the page asks (below) sees the visitor's address and which site
asks: the browser names the origin of the page (`https://<user>.github.io`,
without its path) in every request the page makes to another site, so a tile
server knows whose map a visitor looks at.

**The page asks CARTO for the base map on every view**: the map tiles of the
area in view and the fonts of their labels (`*.basemaps.cartocdn.com`), at every
zoom and pan. CARTO sees the visitor's address and which tiles, so roughly where
on the map they look, and the key of the site (see the end of this page). It is
the one server outside the site that every view of the page contacts.

**The build asks AWS for the elevation tiles of the area you flew over** (see
[Elevation data](output.md#elevation-data)): tiles of about 25 km across at 50
degrees north, fetched once and cached, with nothing else in the request. Pass
`--no-terrain` to build without them.

**The build downloads the OurAirports database** (see
[Airport database](output.md#airport-database)): the airports and runways CSV
files from GitHub Pages (`davidmegginson.github.io`), on the first run and again
once the cached copy is 30 days old, with nothing about your flights in the
request.

**The page asks AWS for the elevation tiles of the area in view** while the 3D
view is on, at every zoom, to draw or shade the relief: AWS sees the visitor's
address and which tiles, so roughly where on the map they look, as CARTO does
for the base map. Nothing is fetched from AWS otherwise.

**The page asks EOX for the satellite imagery of the area in view** while the
Satellite switch is on (see [Satellite imagery](output.md#satellite-imagery)):
EOX sees the visitor's address and which tiles, as AWS and CARTO do. Nothing is
fetched from EOX while it is off, and it is off unless the visitor, their saved
state or the link they followed turns it on.

**The page asks Photon for the places a visitor searches for** (see
[Search](features.md#search)): once the visitor has typed three characters or
more into the search and paused or pressed Enter, the page sends what was typed,
in lower case, to Photon of komoot (`photon.komoot.io`), which looks it up in
OpenStreetMap. Photon sees that text, the visitor's address and which site asks
(the browser names the page's origin in a request to another site), but no
cookie, no address of the page and nothing about the flights or the map in view.
The site's own airports are matched on the page, and a text that is the code or
the name of one of them (`EDAQ`, `Halle-Oppin`) is not sent; one that only
starts like one (`EDA`, `Halle`) is, as it may name a place as well. Nothing is
sent while the search is closed or holds fewer than three characters, and the
page keeps the answers to the last 50 texts for the visit, so it does not send
one of them again.

**The page asks open flightmaps for the aviation charts of the area in view**
while the Aviation switch is on and the map is zoomed in far enough to draw them
(see [Aviation](features.md#aviation)): its tile server
(`nwy-tiles-api.prod.newaydata.com`) sees the visitor's address and which tiles,
as EOX does. Nothing is fetched from it while the switch is off, which it is
unless the visitor, their saved state or the link they followed turns it on.

**The page asks the Pyodide CDN for the Python runtime** (`cdn.jsdelivr.net`)
the first time a visitor drops their own flights on it (see
[Your flights](features.md#your-flights)), and then AWS for the elevation tiles
and GitHub Pages for the OurAirports database as a build does (above), from a
worker in the browser. The files dropped and everything built from them stay in
the browser's storage; the requests carry nothing of them beyond which elevation
tiles the flights touch, as a build's do, so AWS learns roughly where they went.
**Without the ground under the flights**, a choice of the panel, asks AWS for
none. On a site at `<user>.github.io`, every Pages site of that account can read
the storage the files are kept in (see
[Hosting](hosting.md#your-flights-and-the-origin)).

## Obfuscating the KML files themselves

That is a separate need: this repository commits the files in `data/`, and they
must not carry real dates. `--obfuscate-inputs`, or
`python -m flown.obfuscate <dir>` on its own, rewrites them in place
(atomically, after validation). The timestamps of a flight are shifted by one
offset of whole seconds so that it starts at 00:00:00 UTC on January 1st of its
year: the intervals between its points, the gaps between its tracks and so its
durations, speeds, landings and flight time stay exactly as they were, while
neither its date nor its time of day is left. A flight across midnight stays in
one piece and in the year it started in. A file holding flights on several dates
moves each of them to midnight on January 1st of its own year. A date in a name
that the parser reads a year from (`EDDS to EDDP - 16 Aug 2026`,
`EDDS 2026-08-16`) moves to January 1st of its year, and every other date, part
of a date, time of day, weekday, holiday and Unix time the check would report in
a name or a description goes (`EDDS-EDDP 16 Aug` becomes `EDDS-EDDP`), as often
as it takes until none is left (`Sat Sat 16 Aug` loses both); a Charterware
description keeps its date, moved to January 1st with `12:00AM` as its time.
Descriptions follow the same rule as names, so where a number could be a date it
goes with the dates: `Fuel 26.08 gal` loses `26.08` and `LOWI 08-26` loses
`08-26`. Only what stands right next to a removed date changes, so the rest of a
description (its links, line breaks and HTML) stays as written. Charterware file
names move to January 1st, other file names lose their dates, times, weekdays
and holidays the same way (`1_DEHYL_DA40_16Aug.kml` becomes `1_DEHYL_DA40.kml`
and `EDDS Sat 14:30 16 Aug 2026.kml` becomes `EDDS.kml`, unless that name is
taken or nothing is left), and every creator field is replaced. Read-only files
and symlinks are reported instead of rewritten. Obfuscated KML files still
contain:

- The year of each flight
- The durations between points, counted from midnight
- Full precision coordinates and altitudes
- The order of the flights (from the file numbering)

`python -m flown.obfuscate <dir> --check` verifies a directory: the first
timestamp of every flight must be 00:00:00 on January 1st (a fraction of a
second may follow), and no other date may appear anywhere in a file or its name
(numeric, also with the year first and spaces such as `2026 08 16` or with en
dashes, with an English or German month name such as `16 Aug 2026` or
`16. Mai 2026`, or with the month in Roman numerals such as `16.VII.2026` or
`2026. VII. 16.`), except the two days after January 1st that a flight past
midnight runs into. A name, a description or the name of the file holds no part
of a date either, which the year of the flight completes (`16 Aug`, `16.08.`,
`16/08`, `16.VII.`, `KW33`, `CW33`, `260816`, `03/2026`, `08-2026`, `2026.08`,
`VII/2026`, `Summer 2026`, `Q3 2026`, and `Sat` next to a date). Nor may a
weekday named in full (`Saturday`, `Samstag`, `sonntags`): the timestamps no
longer fall on it. Nor may a holiday, in English or German (`Christmas Eve`,
`Easter Monday`, `Thanksgiving`, `Columbus Day`, `May Day`, `Heiligabend`,
`Ostermontag`, `Pfingsten`, `Nikolaustag`, `Tag der Deutschen Einheit`), which
names the day as well; the places named after one keep it (`Christmas Island`,
`Easter Island`, `Pentecost Airport`, `Whitsunday Coast`). The name of a file
carries no time of day either (`1513h`, `1513H`, `15h13`, `0930Z`, `0930z`,
`0930UTC`, `15:13`, `3pm`, `10 AM`, `1430 GMT`, `1430 Zulu`, `14:30 EST`,
`1430 local`, `0930 hours`, `14.30Z`, `0930Z-1045Z`, `14.30-15.45 Uhr`,
`14.30 bis 15.45 Uhr`, `14:30 +02:00`, `1430+0200`), except for the sequence
number in the time slot of an obfuscated Charterware name, and neither do its
names and descriptions, nor a Unix time of a past day in the text of an element
(see
[Troubleshooting](usage.md#make-check-obfuscation-or-the-commit-hook-fails)). An
`AM` in capitals after a number is a time, even where it is German written in
capitals (`2 AM RHEIN`), which cannot be told from one; `3 am` stays. A comment,
a processing instruction or a CDATA section inside a text hides nothing from the
check (`16<!-- -->.08.2026`, `16.<![CDATA[08]]>.2026`), and neither does a
directory it cannot list: the check fails on it. The timestamps of one track (a
gx:Track, the tracks of a gx:MultiTrack, or a Placemark without either that is
no point marker) count as one flight and are never split, and so do tracks no
more than 12 hours apart in one year; the TimeStamp of a point marker joins the
flight before it within two hours, across New Year too. A track that starts
after New Year keeps its year, as the site does, even right after a flight that
ended the night before, unless it overlaps that flight in time or its Placemark
has a TimeSpan that begins before New Year: then it moves into the year that
flight or that TimeSpan starts in. A recording that runs longer than those days
fails the check rather than being cut in two, and so do legs of a trip on
several days less than 12 hours apart in one file: the check says to split the
file into one per day of flying. When a date cannot be removed (in an element
the tool does not rewrite, say, or a file name that is taken without it), the
rewrite lists it and stops rather than leaving a file half scrubbed.

The pre-push hook (`make hooks`) runs the check before every push, and refuses a
commit message that names a date, a weekday or a holiday when its commit adds or
changes a flight in `data/` (`Add flight 16 Aug 2026`): the history of the
repository is as public as the files.

## What reaches the site

Kept in the site:

- Coordinates, altitudes, distances, groundspeeds, to five decimals (about a
  metre), from the start of a recording to its end: the taxiing as well, so the
  spot the flights from a home field start and end at, where the aircraft is
  parked, can be read off to within a few metres, unless the build is told to
  leave the ends out with `--trim-ends METRES`: every flight then loses its
  points within that distance of where it starts and ends, the taxiing and the
  parking spot with them (300 covers the apron and the taxiway of most fields; a
  recording that never leaves that distance is left out). The extent of the map
  and the airports are worked out from what is left, and the landings counted
  before, so they stay as they were
- Airport visit counts
- Per flight, the number of full-stop landings, touch-and-goes and go-arounds,
  and the field and runway of each touchdown, without a time
- Flight time per year and per aircraft
- Airport names: a placemark name that holds an ICAO code (`EDDS`,
  `EDAQ Halle-Oppin`), and both sides of a route name as written, with or
  without a code (`Home strip - Aunt farm`). A route name between two people
  (`Anna Mueller - Bob Smith`) therefore publishes their names as airports,
  unless a field with a code is next to them. The build warns with every name it
  publishes that is not the name the airport database gives its code
  (`EDDS Stuttgart`), so a name that only looks like one (`ANNA Mueller`) is
  named too, and so is one with codes the parser could not name it by
  (`Anna EDDS EDDF`); `--list` names them below its table. Without an airport
  database the build cannot tell them apart and says so once
- The aircraft registration and type of a file name (`1_DEHYL_DA40.kml`); the
  registration only when it starts with an ICAO nationality mark (`D-EHYL`,
  `DEHYL`, `OE-AKI`, `N12345`; a mark of one letter with as many characters
  after it as that state gives, four for `D`), so `ANNA` or `MIKE` is dropped
  with a warning, although a name that happens to have the shape of one
  (`DAVID`, D-AVID) is not; the type only when it is a type designator with a
  digit (`DA40`, `C172`, `PA-28-181`) or one of the ICAO designators without one
  (`GLID`), in capitals. Any other text there is dropped with a warning, a type
  of letters alone too (see [the rule](usage.md#kml-file-naming-convention))
- The order of the flights: each year lists them in input order, which is the
  order of their dates for numbered and Charterware file names. Together with
  the speeds, tracks and runways of each flight, that order narrows down when
  each one was flown, for someone who compares them with weather archives or the
  flights of others
- The same again in the link preview pages of each year and flight (their year,
  airports and aircraft), and images of the tracks

Removed from the site:

- Individual flight dates and times
- Any other placemark name: free text such as `Flight with Anna` or
  `Untitled Path` is no airport name, and the start of such a flight gets no
  airport marker at all
- Dates and times of day in placemark and file names (`16 Aug 2026`,
  `the 16th of August 2026`, `16/Aug/2026`, `16/08`, `16-08`, `16_08`, `26.08`,
  `16.8`, `16 08 2026`, `16AUG26`, `16-AUG-26`, `260816`, `03/2026`,
  `2026/8/16`, `KW33 2026`, `KW33`, `CW33`, `Week 33`, `Wk 33`, `2026W33`,
  `2026/W33`, `08-2026`, `2026_08`, `2026.08`, `Aug '26`, `Jul/Aug 2026`,
  `16-18 Aug 2026`, `16.-18.08.2026`, `Summer 2026`, `Sommer 2026`, `Q3 2026`,
  `H2 2026`, `2026-08-16T14Z`, `14:30`, `1430Z`, `0930z`, `1430 UTC`, `1430L`,
  `1513h`, `1513H`, `1430hrs`, `14h30`, `15.13h`, `14.30 Uhr`, `3pm`, `10 AM`,
  `0930Z-1045Z`, `2026-08-16_1430`, `2026-08-16-14-30`, `2026-08-16 14-30`,
  `2026-08-16 14-30h`, `2026-08-16 14-30 h`, `2026-08-16T14-30-00Z`,
  `14.30-15.45 Uhr`, `14.30 to 15.45Z`, `202608161430`; a range with a unit or a
  runway after the date stays, `2026-08-16 14-30 min`, `2026-08-16 18-75 m`,
  `2026-08-16 07-25 RWY`, while hours and minutes of the clock with a bare `h`,
  `m` or `s` are a time), with the zone, the fraction of a second or the offset
  that follows a time (`1430 GMT`, `1430 Zulu`, `09:30 EDT`, `14:30 AEST`,
  `1430 local`, `0930 hours`, `14:30:00.5Z`, `14:30 +02:00`, `1430+0200`; the
  common zones, not every one there is), also with German month names written
  day first (`16. Mai 2026`, `16. März`, `16MAI26`, `Mai 2026`); a month name
  alone (`Flugplatz Juli`) stays, and so do runway designators in a name that
  speaks of a runway (`RWY 08/26`, `07L/25R`) and a version after a word or an
  app that says so (`firmware 12.10`, `ForeFlight 2026.03`), and a season, a
  quarter or a half without its year (`Summer camp`), a decade (`Dec '80s`;
  `May '68` goes, as `Aug '98` could be a flight), and the number of a type
  before a date (`PA-28-16 Aug 2026` keeps `PA-28`: a range only counts with
  days that go up), while a bare `26/08` is August 26th and `EDDS 07/25` July
  25th (or July 2025): where a name could hold a date, the date goes. A
  registration that looks like a time keeps it (`N1513H`, `RA-1430L`), and `W33`
  alone is the code of an airport in the US as often. A time written with a dot
  and nothing else (`Aunt farm 14.30`) stays, since it cannot be told from a
  decimal (`Fuel 14.30`); with a zone, the local time, the hours or `Uhr` it
  goes (`14.30Z`, `14.30 UTC`, `14.30L`, `14.30 hrs`, `15.13h`, `14.30 Uhr`).
  Four digits before `hours` go even where they count the hours of an engine
  (`Engine 1500 hours`)
- Weekdays in placemark and file names: named in full in English or German
  wherever they stand (`Saturday`, `Sundays`, `Samstag`, `sonntags`,
  `Sonntagsflug`, `Samstagnachmittag`), and abbreviated only right next to a
  date or a time (`Sat 16 Aug 2026`, `Sa., 16.08.2026`, `16.08.2026 (Sa)`,
  `Sat 14:30 16 Aug 2026`, `Sat 14:30`). An abbreviation on its own stays, since
  it is as often something else: `Sun` and `Sat` are words, `SAT` and `THU`
  airport codes (though `SAT` right before a time goes as a weekday:
  `KAUS to SAT 14:30` becomes `KAUS to`), `Do 27` a Dornier, and a letter or a
  hyphen before it makes it a part of a registration (`D-EFRI`, `OE-SAT`).
  Aircraft types (`C172`, `PA28`, `DA20`, `SR22`) and ICAO codes (`EDMO`) are
  never touched. The places named after a weekday keep it (`Friday Harbor`,
  `Thursday Island`, `Sunday Creek`); a family name such as `Freitag` does not
- Holidays in placemark and file names, as the check knows them
  (`Christmas Eve`, `Heiligabend bei Oma`, `Tag der Einheit`), and Unix times of
  past flights (`Kaffee 1755350000`); a place named after a holiday keeps it
  (`Whitsunday Islands`, `Weihnachtsinsel`), but the Scottish `Easter` (eastern)
  of `Easter Nether Cabra` and the first name `Silvester` go as well
- Dates with the month in Roman numerals (`16.VII.2026`, `16. VII. 2026`,
  `2026. VII. 16.`, `16.VII.`, `VII/2026`), as Poland, Czechia or Hungary write
  them. Without the day or the year only a numeral in capitals of two letters or
  more counts, with a space after the dot only with a dot after the numeral, and
  never with a space alone: `Section 2. IV`, `Part 2 II`, `Gate 12 VI`,
  `16 VIII`, `16. V.`, `I/2026` and `v.2024` stay
- A registration that holds a date, a time of day or a weekday
  (`1_16AUG26_DA40.kml`, `1_MONDAY_DA40.kml`), or starts with no nationality
  mark (`1_ANNA_DA40.kml`), with a warning

The CARTO key is a public client-side tile key. It is embedded in the generated
`map_config.js` and in the two base map URLs `index.html` preloads, and
published with the site by design, because the browser needs it to load the base
map. The generated site is not committed; the key lives in the repository
secrets and in the deployed site only.
