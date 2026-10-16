# Frontend

The interactive map interface is built with TypeScript and has comprehensive
test coverage. This page describes its modules, the bundles the build makes of
them and what they load, the stylesheets and the build output. How the map draws
the flights is in [Rendering](rendering.md) and [Heat](heat.md), the tests in
[Testing](testing.md) and the size budgets in [Size budgets](budgets.md).

## Architecture

- **TypeScript modules** in `flown/frontend/`
  - `mapApp.ts` - The entry point of the first visit and the app itself: it owns
    the map and its life, runs the first load, dispatches clicks on the map and
    fetches the lazy bundles. What it sets up once and then leaves to the store
    lives beside it: the base style and its fallback (`baseStyle.ts`), the saved
    state put back at start (`ui/stateRestore.ts`), the controls that follow the
    store (`ui/appChrome.ts`) and what the app says when a lazy bundle cannot be
    fetched (`ui/lazyBundles.ts`), with the parts of the lazy features each app
    keeps once made (`featurePart`). `features.ts`, `wrapped.ts`, `search.ts`,
    `extras.ts` and `local.ts` are the entry points of the lazy bundles
  - `calculations/` - Statistics and data processing
  - `features/` - Airports, layers, replay, wrapped
  - `services/` - Data loading and caching
  - `state/` - The store, the table of toggles (`toggles.ts`, from which the
    saved state, the link, the buttons, the actions and the phone's sheet rows
    are derived), the URL encoding and the site data (`airports.json`,
    `metadata.json`) once loaded
  - `ui/` - UI managers for controls and interactions. The colour layers of the
    altitude and speed modes are `ui/layerManager.ts`, which decides what is
    written when, with the modes and the cut into runs in `ui/pathRuns.ts`, the
    look of a selection, the colour ranges and the legends in `ui/pathLook.ts`,
    the cut of the ribbons of the 3D view in `ui/pathRibbons.ts`, which comes
    with the feature bundle, and what is under the pointer in `ui/pathHover.ts`
  - `utils/` - Formatters, colour scales, geometry helpers and the icon set.
    Every mark in the interface is an inline SVG: an icon font is out (the
    page's CSP allows no external font), and emoji render at a different weight,
    colour and baseline on every platform. The shapes come from Lucide, imported
    by name so the bundler keeps only the ones the page draws, and the build
    writes each icon's plain paths as one (`lucidePathsPlugin` in `build.js`);
    the GitHub mark and the top-down aircraft are drawn in `utils/icons.ts`
    because Lucide carries neither
- **Stylesheets** in `flown/static/` (`styles.css`, `features.css`,
  `wrapped.css`, `search.css`, `local.css` and `extras.css`, see
  [Stylesheets](#stylesheets))
- **Build output** in `flown/static/` (`mapApp.bundle.js`, `features.bundle.js`,
  `wrapped.bundle.js`, `search.bundle.js`, `extras.bundle.js`,
  `local.bundle.js`, `shared.bundle.js`, `yearWorker.bundle.js`,
  `localWorker.bundle.js`, their source maps, `vendor/` and `flags/`)
- **Build scripts** `build.js` and `scripts/*.js`, plain JavaScript with JSDoc
  types that `tsconfig.node.json` checks (`npm run typecheck`). The type checks
  run TypeScript 7 (the `typescript7` alias of `package.json`, called by path
  because both TypeScript packages ship a `tsc`). `typescript` 6.x stays only
  for typescript-eslint, which does not support 7 yet; it goes once it does.
  Until then `node_modules/.bin/tsc`, an editor's workspace TypeScript and the
  type-aware ESLint rules run 6.x, so check types with `npm run typecheck`, not
  a bare `tsc`. Dependabot skips npm aliases, so `typescript7` is bumped by hand
  (`npm install -D --save-exact typescript7@npm:typescript@<version>`).
  `scripts/build-helpers.js` finds the shaders and the popup markup it tightens
  with `@babel/parser` and `@babel/types`, as TypeScript 7 only exports its
  compiler API as an unstable preview
- **Tests** in `tests/frontend/` and `tests/e2e/` (see [Testing](testing.md))

## State and links

The store in `state/` holds what the page shows, and the table of toggles
(`state/toggles.ts`) is where every switch gets its key in the saved state, its
slot or parameter in the link, its button and its row in the phone's sheets. The
parameters a link carries, and how older links are read, are listed under
[Shareable URLs](../features.md#shareable-urls). A link's zoom levels are one
higher than MapLibre's own (see `ZOOM_OFFSET` in `utils/constants.ts`). What a
link and the saved state carry is checked as it is read (`state/urlState.ts`,
`sanitizeSavedState` in `ui/stateManager.ts`), in the first visit's code, so the
store never holds what the page cannot show, such as a line of the cross-section
that is not two places (`isSectionLine`; the store's `crossSectionLine`, which
the tool writes and opens on as the page does).

## Bundles

`npm run build` produces the bundles `BUNDLE_FILES` in `flown/site_assets.py`
lists. `mapApp.bundle.js` starts the map, `features.bundle.js` holds Replay, the
relief, the heat cloud and the ribbons of the 3D view (of every flight and of a
selection: the 3D view cuts the flights once it has arrived, and draws them flat
when it cannot be loaded), the satellite imagery, the profile of the selected
flights, the cross-section (`ui/crossSection.ts`, with its corridor, chart,
words and elements in the `ui/crossSection*.ts` modules beside it; the first
visit carries only its control in the View group and its row in the phone's More
sheet) and the hotspot tour (`ui/hotspotTour.ts`, with its places found in
`calculations/hotspots.ts`, carried the same way), and `wrapped.bundle.js` holds
Wrapped, the content of the statistics panel and the flight list of its Flights
tab (the rail itself is part of the app, and says it is loading until the bundle
is in; see `ui/statsPanel.ts`); the page imports each of the last two the first
time one of its features is opened, and both as soon as Wrapped's button is
pointed at or focused, for its intro (`ui/wrappedIntro.ts`), unless the system
asks for reduced motion. `search.bundle.js` holds the search of airports and
places (`ui/locationSearch.ts`, with the matching of the site's airports in
`calculations/airportSearch.ts` and the client of Photon in
`services/photon.ts`); the first visit carries only its button, its row in the
phone's More sheet and the `/` key (`followSearchKey` in `ui/lazyBundles.ts`),
and the page imports it the first time the search opens. `extras.bundle.js`
holds what no desktop's first visit needs: the phone's bar and its sheet
(`ui/mobileBar.ts`, `ui/mobileSheet.ts`), which a phone asks for as its page
starts and mounts once the managers are there (`MapApp.followMobileBar`), the
columns hidden in the phone layout meanwhile; the packing of the tokens of
shared links for Copy link (`state/shareTokenPack.ts`), which every page fetches
once it has a moment and pointing at a share control fetches ahead (a press
before it hands the clipboard a promise of the link with its token); and the
export of the map as an image (`ui/mapExport.ts`), which the first export
fetches; the Export control's busy state stays in the app. The reading of a
token (`state/shareToken.ts`) is the first visit's: a link with one is read
before anything else reads it. `local.bundle.js` holds Your flights
(`ui/localFlights.ts`): the panel that takes the KML files a visitor drops on
the page, the store of those files and of what is built from them in the browser
(`services/localStore.ts`), the page's side of the build
(`services/localBuild.ts`), the sheet over the map while files are dragged
across it (`ui/fileDrop.ts`) and the configuration a page that shows those
flights starts with; the app carries the button, its row in the More sheet, the
watch for a drag of files (`ui/fileDropWatch.ts`), the start that asks for that
configuration (`startApp` in `mapApp.ts`) and the flags both share
(`state/localFlags.ts`). `shared.bundle.js` is the app itself and everything the
lazy bundles use of it. `yearWorker.bundle.js` is a build of its own, which
decodes the year files and writes the heat sources off the main thread (see
[The year worker](data.md#the-year-worker)). `localWorker.bundle.js` is another,
the worker that builds the visitor's flights: it imports Pyodide from its CDN,
loads lxml and the package's own Python from `flown-src.zip` next to the page
(`site_assets.py` writes it), and runs `flown.browser.build` on the files, with
the airport database and the elevation tiles it fetches kept in a directory
mounted on IndexedDB. The page's Content Security Policy does not reach a worker
started from a file of the site, which gets the policy of that file's response;
a host that sends one would have to allow the CDN in it.

### Shared chunk

The bundler moves the modules the entry points share into a chunk that each of
them imports, because several of them hold state that has to be a single
instance. It makes one chunk for every set of entry points that reach a module,
so every lazy entry point imports `mapApp.ts`: everything the app reaches is
then reached by all of them and lands in the one chunk, which has a fixed name
that the site publishes and the page preloads. A module two lazy bundles share
without the app would still get a chunk of its own, and the build fails if it
ever writes another file (`assertExpectedOutputs` in `build.js`); such a module
belongs where the app reaches it (`segmentBounds` in `utils/geometry.ts` is one,
`countryDisplayName` in `utils/formatters.ts`, for Wrapped and the search,
another), or in the feature bundle, which hands it to Wrapped's code through
`FeatureModule`: the camera moves Wrapped's intro and the hotspot tour share
(`ui/cameraScript.ts`) do that, as the intro waits for the feature bundle
anyway.

### Vendored libraries

The same command takes MapLibre GL JS and html-to-image out of `node_modules`
into `flown/static/vendor/`, which is what the published page loads them from
(html-to-image with `import()`, on the first export, as one module that
`scripts/vendor.js` bundles from the package's own), and the country flags of
`flag-icons` into `flown/static/flags/` (`scripts/vendor.js`). All of it is
gitignored, and `make clean` removes it. MapLibre is copied with six fixes made
to its minified code (`VENDOR_PATCHES`): two for bugs of 6.10, where tiles under
a camera that looks at a point above the relief (the chase view) were culled and
a GeoJSON tile that loads empty kept the raw data of before, one for WebKit on
Linux (WebKitGTK and WPE, the WebKit of the e2e tests), whose page process
crashed or hung as MapLibre's worker took apart an elevation tile it was sent as
an ImageBitmap: there the tile is read into plain pixels on the main thread
first, as MapLibre does where OffscreenCanvas is missing (every other browser
keeps the bitmap), one that starts the worker from the URL the page preloads,
without the `?v=` version MapLibre adds since 6.13, and two that let MapLibre's
worker read a GeoJSON source from a `blob:` URL without the main thread (see
[The heat sources and the year worker](heat.md#the-heat-sources-and-the-year-worker)).
Each fix has to find its code exactly once, or the build fails: after a bump of
MapLibre, drop the fix it has made unnecessary, or match its code again. Its
stylesheet loses the rules of the controls the app never adds (navigation,
fullscreen, globe, terrain, geolocate, logo and scale; `VENDOR_CSS_STRIPS`),
three quarters of it their icons as `data:` URIs, and the build fails unless
exactly the expected number of rules goes.

### Country flags

The flags are the one asset the wheel leaves out: 271 of them are two megabytes,
and any one export visits a handful, so `site_assets.py` publishes only the
countries the flights touched and lists them in `metadata.json`. A site
generated from a `pip install`, which has no `static/flags/`, publishes none and
the statistics rail falls back to the ISO country code.

## Stylesheets

The styles are split the same way as the bundles and travel with them:
`flown/static/styles.css` is linked in the page, `features.css`, `wrapped.css`,
`search.css`, `local.css` and `extras.css` are fetched alongside their bundles
(see `services/featureLoader.ts`), and each has its own budget in
`tests/test_asset_budget.py` (see [Size budgets](budgets.md#stylesheets)). A
rule belongs in `features.css` when its selector names replay, in `wrapped.css`
when it names Wrapped or what the statistics rail renders, its tabs and the
flight list included, in `search.css` when it names the search panel or its
pulse on the map, in `local.css` when it names the panel of Your flights or the
sheet over the map while files are dragged, and in `extras.css` when it names
the phone's sheet (`.mobile-sheet`, `.sheet-*`); the file headers spell out the
rest, including the one-way dependency on `styles.css`.

A surface across the whole width of the map on a phone (the tab bar, its sheet)
takes `--color-bg-edge`, the secondary surface at an alpha of 0.99: Chrome
leaves out the part of the map's canvas an opaque one covers and the same strip
at the opposite edge, and the top of the map showed the page background as high
as the bar (`tests/frontend/unit/edgeSurfaces.test.ts`). The statistics sheet is
opaque, since the labels of the map showed through it at 0.99, and its rounded
top corners keep Chrome from taking it for such an edge.

Whatever has the keyboard's focus is ringed with `--focus-ring`, a token of
`styles.css` that the other stylesheets use as well.

## Build output

- **Format**: ES modules with code splitting; the page has to be served over
  HTTP (`make serve`), it does not work when opened from disk, and the map needs
  WebGL 2
- **Production**: Minified bundles for optimal performance, with the GLSL of the
  custom layers (`ui/*Layer.ts` and `ui/*Shaders.ts`) written without comments,
  indentation and the spaces around most punctuation, line for line
  (`shaderPlugin` in `build.js`); the build fails when a bundle exceeds its size
  budget (see [Size budgets](budgets.md))
- **Development**: Unminified for debugging
- Both write a source map next to the bundle; it holds the mappings and file
  names only, not the TypeScript sources
