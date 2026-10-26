# Security Policy

## Supported versions

Only the `main` branch is supported. There are no releases or release branches;
fixes land on `main` and are deployed with the next site build.

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's private
vulnerability reporting instead:

https://github.com/saschagrunert/flown/security/advisories/new

Include the affected component (Python pipeline, frontend, container image or
CI), steps to reproduce and, if possible, a suggested fix. You will get a
response within a few days.

## Public tile API key

The generated site embeds the CARTO tile API key in its `map_config.js`, and in
the URLs of the two requests `index.html` preloads for the base map. It is a
public client-side key that the browser needs to load the base map, so it is
published with the site by design. The `site` job of the `test` workflow reads
it from the repository secrets (see
[Usage](doc/usage.md#with-an-api-key-optional) for how to pass it to a local
build). Reports about this key being visible on the site are not security
issues. The aviation overlay (open flightmaps) and the satellite imagery (EOX)
need no key.

## Automated checks

Every push to main runs `pip-audit` against what `uv.lock` pins, `npm audit`,
and a gitleaks scan of the commits since the last commit of main whose run
ended, passed or failed, so a push whose run was dropped for a newer one is
scanned too (the whole history when the clone lacks the commit main had before,
as after a force push). A pull request scans the commits it adds, with the
`.gitleaks.toml` of its base so that its own allowlist cannot pass a secret it
adds (a `.gitleaksignore` or a `gitleaks:allow` comment it adds can, in plain
sight in its diff), and runs the two audits when it changes a lock file or
`package.json`, failing only on an advisory its base does not have. A secret the
scan finds fails the checks a pull request needs to merge, and keeps main from
being published; a new advisory does not, so it cannot hold back every pull
request. Both run weekly, and on a manual run, with a scan of the whole history,
so new advisories show up without a push. Every GitHub Action is pinned by
commit SHA and every container image by digest, and every job that checks out
the repository leaves no credentials in the checkout. Dependabot keeps the
dependencies current, and `make lock` regenerates the Python lock file with the
newest releases the ranges allow.

## Content Security Policy

The generated page carries a CSP in a `<meta>` tag. Scripts, styles, fonts and
workers load only from the site itself; there is no `'unsafe-inline'` for
scripts or styles. Only `connect-src` names foreign hosts: CARTO
(`basemaps.cartocdn.com` for the style, `*.basemaps.cartocdn.com` for the tiles,
glyphs and sprite of the base map), the open flightmaps tile server
(`nwy-tiles-api.prod.newaydata.com`), the elevation tiles on AWS (the
`elevation-tiles-prod` bucket on `s3.amazonaws.com`, not the whole host) the 3D
view draws its relief from, EOX's satellite imagery (`tiles.maps.eox.at`), which
the browser asks for only while the Satellite switch is on, and which then sees
the visitor's address and the area in view, and Photon (`photon.komoot.io`),
which the search asks for the places a visitor types (see
[Privacy](doc/privacy.md#requests-to-other-servers)). Besides those
`connect-src` allows `blob:`: MapLibre's worker reads the heatmap's sources from
Blob URLs of the GeoJSON the page's year worker wrote. Chrome holds that worker
to the policy its own script is served with (GitHub Pages sends none), a browser
may hold it to the page's, and the e2e tests read those URLs from the page. A
Blob URL names data a script made in that browser and is read by its own origin
alone, so `blob:` reaches no server and nothing another site made. MapLibre
fetches every tile, so `img-src` allows only the site itself, `data:` and
`blob:`. MapLibre GL JS is published with the site as ES modules and starts its
worker from one of them, so `worker-src 'self'` is enough and no `blob:` worker
is allowed. Colours computed at runtime are applied through the CSSOM, and a
test fails on any CSP violation the page reports.

The page enforces Trusted Types (`require-trusted-types-for 'script'`): a string
reaches no sink that parses HTML or starts a script unless a policy made it, and
the CSP allows two (`flown/frontend/utils/trustedHtml.ts`). The app's markup
goes through `trustedHtml`, whose markup builders escape every name they put in
(a name in a dropped KML file or in `aircraft.json` is anyone's text), and a
lint rule fails a sink of the frontend that does not use it. The default policy
is for the code that is not the app's: it starts a script of the page's own
directory only (MapLibre's worker and the app's two), and of any other HTML
keeps the links whose attributes can run nothing (an `href` of the web or of
mail, no event handler) and turns every other `<` into text, which is all
MapLibre needs for the close button of a popup and the credits it parses with
`DOMParser` and then cleans itself. A unit test
(`tests/frontend/unit/csp.test.ts`) checks every URL the frontend fetches
against `connect-src`, and every foreign source there against those URLs. A meta
CSP cannot set `frame-ancestors`, and GitHub Pages sends no such header, so the
site can be framed. The one state of the site an embedding page could act on,
with clicks it lures onto the frame, is Your flights: the files a visitor keeps
in the browser, which Remove all deletes and a drop builds. So a framed page
starts on the site's flights whatever the visitor last chose, and Your flights
does not open in it; it says to open the site itself.

### Your flights

The build of the files a visitor drops on the page runs in a worker the page
starts from its own `localWorker.bundle.js`, and that worker loads more than the
page does: Pyodide from `cdn.jsdelivr.net` (its module, the interpreter, the
standard library and the lock file, then the lxml package), the OurAirports
database from `davidmegginson.github.io`, and the elevation tiles from AWS
unless the visitor asks for the flights without the ground. The page's meta CSP
does not reach a worker started by URL: it follows the policy its own script is
served with, and GitHub Pages sends none. So the worker can fetch and run what
the page's policy would refuse, and it runs with the page's origin, the
visitor's files in the browser's storage among what it can read.

What it runs is checked instead. The worker pins one Pyodide release and the
SHA-384 of each file of it (`PYODIDE_INTEGRITY` in
`flown/frontend/services/localWorker.ts`): the worker checks every file it
fetches against its hash before Pyodide gets a byte of it, the two modules are
imported from the bytes it checked rather than from their URL, and the lock
file, checked like them, carries the hash each package is checked against the
same way. The check fails closed: an answer that is no success is refused
whatever its body (Pyodide reads the lock file without looking at the status, so
a 404 or a 500 carrying a lock file of its own would otherwise hand it other
hashes for the packages), and so is any file under the release's URL with no
hash, pinned or given by the lock file. A CDN that served other files stops the
build (it says the runtime could not be loaded), and so does a download that
stalls for a minute or a runtime that does not start within two minutes of its
last file; it cannot run code with the site's origin. The package's own Python
comes from `flown-src.zip` next to the page. The airport database and the tiles
are data the build parses, or the browser decodes as images, never code.

A host that sends a CSP header of its own for every file holds the worker to it
as well (see [Hosting](doc/hosting.md#headers-and-compression)): it has to allow
those hosts in `connect-src`, `'wasm-unsafe-eval'` in `script-src`, and `blob:`
in `script-src` for the two modules, or Your flights says the runtime could not
be loaded.
