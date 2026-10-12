# Flown

> Where you have flown: your KML flight logs as a static site.

[![Demo](https://img.shields.io/badge/live-demo-blue.svg)](https://saschagrunert.github.io/flown)
[![Coverage](https://codecov.io/gh/saschagrunert/flown/badge.svg?token=AxIuoWeFSy)](https://codecov.io/gh/saschagrunert/flown)

Flown turns the KML flight logs of SkyDemon, Charterware and other aviation apps
into a static site: a map of where the time was spent, with the flights coloured
by altitude or groundspeed, the airports visited, statistics, replays, a 3D view
and a year-in-review summary. The
[live demo](https://saschagrunert.github.io/flown) shows the flights of this
repository.

To publish your own flights the same way, fork this repository and follow
[Your own site on GitHub Pages](doc/hosting.md#your-own-site-on-github-pages);
[Adding flights](#adding-flights) takes each new flight from the export to the
site.

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [KML files](#kml-files)
- [Adding flights](#adding-flights)
- [Privacy](#privacy)
- [Documentation](#documentation)
- [Development](#development)
- [Contributing and security](#contributing-and-security)

## Features

- Interactive density heatmap showing where the time was spent, with a one-line
  legend from less time to more
- Altitude and groundspeed coloured flight paths
- Airport markers with ICAO codes and visit counts
- A search of the map's airports and of any place on earth (through Photon),
  which takes the map there
- Statistics panel (distance, altitude, flight time), with a sortable,
  searchable list of the flights next to it
- Year and aircraft filtering
- Flight replay with an animated airplane marker, of up to eight selected
  flights one after another
- Replay of all flights at once, each from its own start, at up to 1000x, at
  their height, with a time slider and the heat building up behind them
- A hotspot tour: a short flight in the 3D view over the busiest places of the
  heat, each named and captioned with the time spent there
- An altitude profile of the selected flights, over the ground they flew over,
  linked to the map and to the replay
- A cross-section along a line drawn on the map: where the time was spent within
  a corridor either side of it, by distance and height above the ground or sea
  level, for the heights of circuits, approaches and climb-outs
- A map that turns and tilts, and a globe for flights that span a continent
- A 3D view that lifts the flights to their altitude above the ground they flew
  over, sampled from an elevation model when the site is built, and draws the
  heatmap as a glowing cloud in the air where they flew
- Satellite imagery as the ground under the flights, keyless
- Year-in-review "Wrapped" summary
- Shareable URLs that encode the exact map state
- Privacy protection: no flight date finer than the year reaches the generated
  site
- Mobile-friendly with year-based data organization
- Export map as JPG image

[Map features](doc/features.md) describes each of them.

## Requirements

- Python 3.14 (see `.python-version`) and Node.js 26 or newer (see `.nvmrc`)
- podman or docker for `make build`/`serve` (auto-detected, podman first)
- To view the site: a current browser with ES modules, `fetch()` and WebGL 2,
  and an HTTP server (`make serve`); the page does not work opened from disk

## Quick start

Place your KML files in a `data/` directory in the repository root (the
`Makefile` requires it to exist; in this repository it holds the published
flights, see [Adding flights](doc/adding-flights.md)), then:

```bash
# Build the container image and generate docs/ from data/
make

# Serve it over HTTP (does not rebuild)
make serve
# Then open http://127.0.0.1:8000/
```

The page loads its code as ES modules and its data with `fetch()`, so it has to
be served over HTTP; opening `docs/index.html` from disk shows an empty map and,
after a few seconds, a note that says how to serve it. The map is drawn with
WebGL 2, which every current browser has; where it is missing or switched off,
the page says so in place of the map. `make serve` only serves the existing
`docs/` directory; run `make build` (or `make serve-build`) to regenerate it
first. `docs/` is a local build output and is not committed: the published site
is built from the sources in CI once all tests pass (see
[Your own site on GitHub Pages](doc/hosting.md#your-own-site-on-github-pages)).

Your KML files are read and left alone, and nothing has to be stripped from them
first (see [Privacy](#privacy)). To scrub the files themselves as well, pass
`--obfuscate-inputs` or run `make obfuscate`; that rewrites them in place and
cannot be undone, so keep a copy of the originals. `make obfuscate` runs on the
host when `python` is Python 3.14: it needs nothing beyond its standard library,
so nothing has to be installed for it. Without it, the target runs in the
container image instead.

Without podman or docker, build the frontend and run the generator from the
checkout (see [Python usage](doc/usage.md#python-usage)). The Makefile
variables, the container image, every command-line option and the optional tile
API key are described in [Usage](doc/usage.md).

## KML files

The tool reads two filename formats, and any other KML file with a track:

- SkyDemon exports, named `N_REGISTRATION_TYPE.kml` (`1_DEHYL_DA40.kml`)
- Charterware files, with the name they come with
  (`2026-01-12_1513h_OE-AKI_LOAV-LOAV.kml`)
- A `.kmz` archive is read like the `.kml` file in it (unzip it before
  committing it, since the obfuscator cannot rewrite inside an archive)

The registration in the name decides which aircraft a flight belongs to, and an
`aircraft.json` next to the files names the model of each registration. Files
named otherwise are still shown and counted, but belong to no aircraft. See
[KML file naming convention](doc/usage.md#kml-file-naming-convention) and
[Aircraft model data](doc/usage.md#aircraft-model-data) for the rules.

## Adding flights

A new flight takes seven steps, each described in
[Adding flights](doc/adding-flights.md):

1. [Export the flight](doc/adding-flights.md#1-export-the-flight) as KML
2. [Name the file and put it into `data/`](doc/adding-flights.md#2-name-the-file-and-put-it-into-data)
3. [Add the aircraft](doc/adding-flights.md#3-add-the-aircraft-if-it-is-new) to
   `data/aircraft.json` if it is new
4. [Obfuscate the new files](doc/adding-flights.md#4-obfuscate-the-new-files)
   with `make obfuscate`
5. [Build and preview the site](doc/adding-flights.md#5-build-and-preview-the-site)
   with `make build` and `make serve`
6. [Check the result](doc/adding-flights.md#6-check-the-result)
7. [Commit and publish](doc/adding-flights.md#7-commit-and-publish)

When a flight does not come out as expected, see
[Troubleshooting](doc/usage.md#troubleshooting).

## Privacy

The generated site carries no flight date finer than the year, whatever the KML
files contain: a flight keeps its year and the seconds since its start.
[Privacy](doc/privacy.md) says what reaches the site, which servers the build
and the page ask for what, and how to scrub the KML files themselves.

## Documentation

- [Usage](doc/usage.md): the KML file names, aircraft models, several input
  directories, the tile API key, the Makefile, Docker and Python usage, every
  command-line option and troubleshooting
- [Adding flights](doc/adding-flights.md): the seven steps from an export to the
  published site
- [Map features](doc/features.md): the heat and the layers, the controls,
  filtering, shareable URLs and what the generator works out on its own
- [Privacy](doc/privacy.md): what the site carries, what the page and the build
  ask other servers for, and obfuscating the KML files
- [Output and technical details](doc/output.md): the files a run writes and
  their format, link previews, the data export, the cache directory, the airport
  database, the elevation data and the satellite imagery
- [Hosting](doc/hosting.md): your own site on GitHub Pages, serving the site
  from any static host, in a subdirectory, the cache headers and compression,
  link previews, a login and search engines
- [Development](DEVELOPMENT.md): the developer guide, with its pages in
  [doc/development/](doc/development/)

## Development

`make help` lists all targets. See [DEVELOPMENT.md](DEVELOPMENT.md) for the
frontend and backend workflows, the test commands, the build output and the test
data generator, and [CONTRIBUTING.md](CONTRIBUTING.md) for the local setup and
the commit conventions.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and
[SECURITY.md](SECURITY.md) for how to report vulnerabilities.
