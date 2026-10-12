# Hosting

Where to put the generated site and what the server has to do: nothing beyond
serving files, with a few headers worth setting. The site of this repository
goes to GitHub Pages from CI (see
[Commit and publish](adding-flights.md#7-commit-and-publish)); the next section
sets up the same for a copy of the repository, and the rest of this page is for
any other host.

## Your own site on GitHub Pages

The `test` workflow builds the site from `data/` and publishes it to GitHub
Pages on every push to `main`, once every test has passed. To get the same for
your own flights:

1. Fork the repository on GitHub (or create a repository from a clone of it).
2. Enable the workflows: GitHub turns them off in a fork until you confirm them
   on its Actions tab.
3. Set Settings > Pages > Source to "GitHub Actions". The workflow cannot set it
   itself: its token is not allowed to change the Pages settings.
4. Replace the flights: delete the KML files in `data/` and
   `data/aircraft.json`, then add your own as
   [Adding flights](adding-flights.md) describes, obfuscated before they are
   committed (`make obfuscate`, and `make hooks` so a push with a real date is
   refused). Your files may sit in subdirectories of `data/`.
5. Add the repository variable `FLOWN_OWN_FLIGHTS` with the value `1`
   (Settings > Secrets and variables > Actions > Variables), see below.
6. Optionally add a CARTO tile API key as the repository secret `CARTO_API_KEY`
   (same page, Secrets). The base map loads without one (see
   [With an API key](usage.md#with-an-api-key-optional)).
7. Push to `main`. Once the run is green the site is at
   `https://<owner>.github.io/<repository>/`; the deploy job's summary names the
   address.

Some tests are written against the flights of this repository: the golden
pipeline test (`GOLDEN_FILES` in `tests/test_pipeline_golden.py`), the landing
and segment tests that read named files of `data/` (marked `repo_data`), and the
e2e specs, which drive a site built from `data/` and expect a few flights in its
latest year. With other flights they fail, and then nothing is published.
`FLOWN_OWN_FLIGHTS=1` skips them: pytest leaves out the tests marked
`repo_data`, and the workflow skips its e2e jobs, which the `checks` job then
accepts as skipped. Everything else still runs, the build of your site, the unit
tests and the visual snapshots of the fixture site among them. Set it in the
environment for a local `make test` as well.

The other repository settings are optional for a site of your own; the ones this
repository uses are in [Repository rules](../CONTRIBUTING.md#repository-rules).

## Any static host

The output directory is a set of plain files: the page, its bundles and
stylesheets, the vendored libraries, the icons, the link preview pages and the
`data/` directory (see [Output directory](output.md#output-directory)). No
server-side code runs. Copy the directory to any web server, object store or CDN
that serves files over HTTP and the page works. Every reference in it is
relative (`./styles.css`, `data/2025/data.json`, and `start_url` is `./` in
`manifest.json`), so the site works from whatever directory it is served at, and
the page allows no `<base>` element (`base-uri 'none'` in its CSP), so it has to
be served at its files rather than rewritten. It needs HTTP: opened from disk it
shows an empty map (see the [README](../README.md#quick-start)), and the map
needs WebGL 2 in the browser.

The page keeps its saved state (the year, the view, the selection and the
switches) in the browser's localStorage under a key that names the directory the
page is served from, so two copies of the site side by side on one host
(`example.org/2025/` and `example.org/2026/`) do not restore each other's state.
A copy at the root of its origin keeps the key it has always used.

## In a subdirectory

Nothing has to be configured for a subdirectory: the relative references cover
it, and the link preview pages in `y/` and `f/` send a browser to `../` with the
year or flight in the query. Only `--site-url` has to name the directory
(`https://example.org/flights`), since the previews name their images by
absolute URL (see below). A site moved to another directory of the same host
starts with a fresh saved state, since the key names the directory.

## Headers and compression

The file names never change between builds: the bundles are `mapApp.bundle.js`
and so on in every build, and the hash of the sources is written inside them
(the first line of a bundle), not into their names; `map_config.js` carries the
build date and commit under the same name in every build too. So nothing may be
cached as if it were immutable, and a rebuild has to reach the browser through
revalidation:

| Path                                                                                | Cache policy                                                                                                                              |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `index.html`, `map_config.js`, `data/**`                                            | `no-cache`, or a `max-age` of minutes: what a rebuild changes first. With `no-cache` the browser keeps a copy and asks whether it changed |
| `*.bundle.js`, `styles.css`, `features.css`, `wrapped.css`, `search.css`, `vendor/` | A modest `max-age` (an hour to a day), never `immutable`: they change with a rebuild under the same names                                 |
| `flags/`, the favicons, `manifest.json`, `preview.png`, `y/`, `f/`, `*.map`         | The same modest `max-age`                                                                                                                 |

Revalidation works with `ETag` or `Last-Modified`. A server that derives its
ETags from the modification times, as GitHub Pages does, keeps them for the
files a new build did not change when the site is built with
`FLOWN_STABLE_MTIMES=1` (see
[How the output directory is written](usage.md#how-the-output-directory-is-written)).

The build writes no compressed copies: switch on gzip or brotli at the server
for the text files (`.html`, `.js`, `.mjs`, `.css`, `.json`, `.map`, `.svg`),
which cuts the bundles and the year files to a fraction of their size. The PNGs
are compressed already.

The MIME types are the usual ones. The one a server may lack is `.mjs`, which
the vendored MapLibre and html-to-image modules use: it has to be served as
`text/javascript`, since a browser refuses an ES module with any other type.
`.json` is `application/json`. Nothing else is special: the page ships no fonts,
asks for no byte ranges and needs no CORS headers from its own server, since
everything it fetches across origins comes from the tile hosts. `serve.py`,
which `make serve` runs, sends `Cache-Control: no-store` on every file. That is
for development, where every reload must show the newest build, not a policy for
a published site.

The page brings its own Content-Security-Policy and referrer policy as meta tags
(see [SECURITY.md](../SECURITY.md)); GitHub Pages lets you set no headers. A
host that does can add what a meta tag cannot do:

| Header                    | Value                                                          | Why                                                                                                                                                                         |
| ------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Content-Security-Policy` | `frame-ancestors 'none'`                                       | No other site can frame the page (`'self'` to allow your own); a meta CSP cannot say it                                                                                     |
| `X-Content-Type-Options`  | `nosniff`                                                      | A data file is never read as a script or a page by type sniffing                                                                                                            |
| `Referrer-Policy`         | `strict-origin-when-cross-origin`                              | The same as the meta tag, and for the MapLibre worker as well, which takes its policy from the header of its script: a CARTO key restricted to your domain needs the origin |
| `Permissions-Policy`      | `camera=(), microphone=(), geolocation=(), payment=(), usb=()` | The page uses none of them; leave `web-share` and `clipboard-write` allowed, which sharing a link needs                                                                     |

A second `Content-Security-Policy` header adds to the meta tag rather than
replacing it: a request has to pass both, so `frame-ancestors` alone is enough.

## Link previews need --site-url

A link to the site, a year or a flight unfolds in a chat or a post from Open
Graph tags (see [Link previews](output.md#link-previews)). The pages behind them
(`y/2025.html`, `f/<id>.html`) are written by every build, but their images only
when the build knows the address of the site, since an `og:image` has to be an
absolute URL: pass `--site-url https://example.org/flights` (or set
`FLOWN_SITE_URL`) with the directory the site is served from. Without it the
previews unfold as a plain summary without an image. CI fills the address in
from the Pages configuration.

## Behind a login

The page uses no cookies and no session of its own, so any login the server puts
in front of it works as long as the files reach the browser once logged in: HTTP
basic authentication, or a proxy that sets its own cookie, which the browser
sends with the page's same-origin requests for the data and the bundles. What
does not work is a login form inside the page or in a frame of it: the page's
CSP has `form-action 'none'`, so a form in it submits nowhere. The login has to
live on a page of its own, before the site is served. The site itself can be
framed (see [SECURITY.md](../SECURITY.md#content-security-policy)), and it
fetches its tiles from CARTO, AWS, EOX and open flightmaps whatever the login,
so a network that blocks those hosts shows the flights over a black map (see
[Troubleshooting](usage.md#the-flights-show-but-the-map-behind-them-is-black)).

## Keeping it out of search engines

A site built with `--private` carries
`<meta name="robots" content="noindex, nofollow">` in its page, which asks a
search engine that fetches the page not to list it; the link preview pages carry
`noindex` in every build. The tool writes no `robots.txt`: crawlers read it only
at the root of the origin, so one next to a site in a subdirectory does nothing.
A server that wants to keep crawlers out entirely can add its own `robots.txt`
at the origin root or send an `X-Robots-Tag: noindex` header. A `Disallow` in
`robots.txt` keeps crawlers from fetching the page, so they never see its
`noindex`, and a disallowed address can still be listed from links to it; the
header or the meta tag is what keeps it out of an index. It is a request, not a
lock: a page anyone can fetch can still be read and linked, and keeping it
private takes a login (above). The option is described under
[Command-line options](usage.md#command-line-options).
