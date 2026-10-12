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

Every push to main runs `pip-audit` against the hashed lock files, `npm audit`,
and a gitleaks scan of the whole commit history. A pull request or an entry of
the merge queue scans the commits it adds, and runs the two audits when it
changes a lock file or `package.json`. The same job runs weekly, with the whole
history, so new advisories show up without a push. Every GitHub Action is pinned
by commit SHA and every container image by digest, and every job that checks out
the repository leaves no credentials in the checkout. Dependabot keeps the
dependencies current, and `make lock` recompiles the Python lock files with the
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
test fails on any CSP violation the page reports. A unit test
(`tests/frontend/unit/csp.test.ts`) checks every URL the frontend fetches
against `connect-src`, and every foreign source there against those URLs. A meta
CSP cannot set `frame-ancestors`, and GitHub Pages sends no such header, so the
site can be framed; it holds no state an embedding page could change.
