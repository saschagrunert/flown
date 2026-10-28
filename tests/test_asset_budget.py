"""Size budgets of the stylesheets that ship with the generated site.

The JavaScript bundles have their budgets in build.js, which every production
build enforces. The stylesheets are minified by the Python side instead (see
``site_assets._copy_and_minify_css``), and failing a user's site generation
over a project policy would be the wrong place for it, so their budgets are a
test: it fails in CI on a regression and leaves ``flown`` itself alone.

The measurement goes through site_assets rather than minifying the sources
here, so that the budgets keep covering the files the site actually serves
however the generator produces them.

Raise a budget on purpose when a change needs the room, not to make the suite
pass. They are separate on purpose: only styles.css is on the critical path,
so room taken there is not the same as room taken in features.css or
wrapped.css.
"""

import gzip

import pytest

from flown.site_assets import CSS_FILES, STATIC_DIR, _copy_and_minify_css

# Bytes of each minified stylesheet as the generator writes it into a site.
#
# styles.css is what every visit loads before the map can be drawn. It was one
# 68 KB sheet until replay and Wrapped moved into features.css, which cut it to
# about 39 KB; the budget keeps that win rather than letting it drain back.
# Raised from 42 KB for the UI fixes of the review of 2026-09-25 (41,093 B
# before, 43,345 B after): the states of the controls drawn from their
# attributes (and the system's highlight for one that is on, in forced
# colours), the toast that stays with its Retry and Dismiss, the note on
# the map when the first year fails to load, the dimmed parts of an
# unavailable sheet row and the phone's two line credit. Lowered from 44 KB
# when the content of the statistics panel moved to wrapped.css with its code
# (38,394 B after). Raised from 40 KB to 40.75 KB for share mode: the Select
# or Remove under the values of a tapped flight, the checkboxes of the
# airport popup's flights, the chip's buttons that come and go and its
# shorter form on a phone (40,844 B before, 41,622 B after). Raised from
# 40.75 KB to 43.25 KB, and from 7.875 KB to 8.375 KB gzipped, for the
# airport codes back in the markers: the chip on its arm that glides round
# the dot, its stem, its home, hover and raised contrast looks (41,677 B
# and 7,897 B gzipped before, 43,336 B and 8,236 B after). Lowered to 40 KB,
# and to 8 KB gzipped, when the phone's sheet moved to extras.css with the
# code that builds it (44,117 B and 8,381 B gzipped before, 38,689 B and
# 7,603 B after). The airport popup's list of flights went to extras.css
# and the sheet's gradient chip to phone.css, with the code that draws
# them (39,093 B and 7,665 B gzipped before, 37,801 B and 7,452 B after).
# The tabs of the phone's bar went to phone.css too, which only phones
# fetch (37,857 B and 7,464 B gzipped before, 37,033 B and 7,352 B after).
#
# features.css and wrapped.css are fetched with their lazy bundles, not by a
# first visit, so they are the more forgiving. The two were one 28.8 KB sheet
# until Wrapped got a bundle of its own; split, they minify to 5.0 KB (replay)
# and 23.2 KB (Wrapped), and each budget keeps about 2 KB over that.
# wrapped.css was raised from 26 KB for the statistics panel, which comes with
# the Wrapped bundle (28,811 B after), and from 30 KB for the flight list and
# the tabs of the statistics rail, which show once it is in (28,603 B before,
# 31,495 B after), and from 33 KB for the rework of the intro of Wrapped
# (the map over the whole dialog and its way back into its panel, the
# title it opens on, and the page's chrome hidden under the dialog; 32,304 B
# before, 34,244 B after). features.css was raised from 7 KB for the panel of the
# replay of all flights (6,298 B before, 7,551 B after), and from 8 KB for
# the flight profile, whose strip, chart, chip toggle and place in the replay
# panel it carries (7,551 B before, 11,596 B after), and from 13.5 KB for the
# slider of the heat cloud's band of heights, a row of the Map group or a
# panel over the map on a phone (11,596 B before, 13,608 B after), and from
# 15.5 KB for the cross-section, its panel, chart, the ends of its line on
# the map and its place beside the legends and the toasts (13,608 B before,
# 17,471 B after), and from 19 KB for the panel of the hotspot tour, its
# caption, its place over the phone's bar and the toasts above it (18,582 B
# before, 20,992 B after). search.css, the panel of the search of airports
# and places, fetched with its bundle, was set at 4,004 B with the same 2 KB
# of room. extras.css, the phone's sheet, fetched with the extras bundle, was
# set at 5,651 B. The sheet moved to phone.css with the phone's bundle, set
# at 5,994 B with its gradient chip, and extras.css kept the airport popup's
# list of flights, set at 1,158 B. phone.css was raised from 6.25 KB for the
# tabs of the bar, which left styles.css (6,818 B after), and from 7 KB for
# the toasts centred on the map beside a landscape phone's sheet (7,141 B
# before, 7,415 B after).
STYLESHEET_BUDGET_BYTES = {
    "styles.css": 40 * 1024,
    "features.css": int(21.5 * 1024),
    "wrapped.css": 36 * 1024,
    "search.css": int(5.75 * 1024),
    "local.css": int(6.5 * 1024),
    "phone.css": int(7.25 * 1024),
    "extras.css": int(1.5 * 1024),
}

# The same sheets gzipped at level 9, as build.js measures the bundles: the
# raw budget rewards what saves bytes by compressing worse, and a visit
# downloads the compressed sheet. The policy is build.js's, in the same
# shape: about 5 % of room over the size when a budget is set, raised on
# purpose in the change that needs it, with the sizes before and after
# here. Set at 7,672 B (styles.css), 3,777 B (features.css) and 5,878 B
# (wrapped.css), with the print styles taken out of the first two, and at
# 1,192 B for search.css and 1,514 B for extras.css, which became phone.css
# at 1,585 B, and extras.css again at 524 B for the popup's list of flights.
# phone.css raised to 1.75 KB for the tabs of the bar (1,685 B after), and
# to 1.8125 KB for the toasts beside a landscape phone's sheet (1,752 B
# before, 1,842 B after).
STYLESHEET_GZIP_BUDGET_BYTES = {
    "styles.css": 8 * 1024,
    "features.css": int(3.875 * 1024),
    "wrapped.css": int(6.125 * 1024),
    "search.css": int(1.25 * 1024),
    "local.css": int(1.5 * 1024),
    "phone.css": int(1.8125 * 1024),
    "extras.css": int(0.625 * 1024),
}


@pytest.fixture(scope="module")
def minified_stylesheets(tmp_path_factory):
    out = tmp_path_factory.mktemp("site")
    _copy_and_minify_css(out, STATIC_DIR)
    return {name: (out / name).read_bytes() for name in CSS_FILES}


@pytest.fixture(scope="module")
def stylesheet_sizes(minified_stylesheets):
    return {name: len(css) for name, css in minified_stylesheets.items()}


def test_every_stylesheet_has_a_budget():
    """A new stylesheet is measured rather than quietly shipping unbounded."""
    assert set(CSS_FILES) == set(STYLESHEET_BUDGET_BYTES)
    assert set(CSS_FILES) == set(STYLESHEET_GZIP_BUDGET_BYTES)


@pytest.mark.parametrize("name", CSS_FILES)
def test_stylesheet_is_within_budget(name, stylesheet_sizes):
    size = stylesheet_sizes[name]
    budget = STYLESHEET_BUDGET_BYTES[name]

    assert size <= budget, (
        f"{name} minifies to {size:,} bytes, over the {budget:,} byte "
        f"budget in {__file__}"
    )


@pytest.mark.parametrize("name", CSS_FILES)
def test_stylesheet_is_within_gzip_budget(name, minified_stylesheets):
    size = len(gzip.compress(minified_stylesheets[name], compresslevel=9))
    budget = STYLESHEET_GZIP_BUDGET_BYTES[name]

    assert size <= budget, (
        f"{name} gzips to {size:,} bytes, over the {budget:,} byte budget in {__file__}"
    )
