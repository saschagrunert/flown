"""Tests for the link previews: the images and the pages that carry them."""

import os
import re
import struct
import time
import zlib
from array import array
from concurrent.futures import Future
from concurrent.futures.process import BrokenProcessPool
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from lxml import html as lxml_html

import flown.workers as workers_module
from flown import previews
from flown.previews import (
    PREVIEW_HEIGHT,
    PREVIEW_WIDTH,
    DrawnPath,
    PreviewJob,
    encode_path_id,
    normalize_site_url,
    page_preview_tags,
    prune_preview_cache,
    render_images,
    render_preview,
    track_of,
    write_previews,
)
from flown.types import TrackPoint

SITE = "https://example.org/flights"


def _chunks(png):
    """The (type, data) of every chunk, with the CRCs checked."""
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    chunks = []
    offset = 8
    while offset < len(png):
        (length,) = struct.unpack(">I", png[offset : offset + 4])
        kind = png[offset + 4 : offset + 8]
        data = png[offset + 8 : offset + 8 + length]
        (crc,) = struct.unpack(">I", png[offset + 8 + length : offset + 12 + length])
        assert crc == zlib.crc32(kind + data)
        chunks.append((kind, data))
        offset += 12 + length
    return chunks


def _pixels(png):
    """The palette and the palette index of every pixel, row by row."""
    chunks = dict(_chunks(png))
    raw = zlib.decompress(chunks[b"IDAT"])
    stride = PREVIEW_WIDTH + 1
    rows = [raw[start : start + stride] for start in range(0, len(raw), stride)]
    assert all(row[0] == 0 for row in rows)
    return chunks[b"PLTE"], [row[1:] for row in rows]


def _path(*points, start=1_000_000.0, step=5.0):
    """A timed path through (lat, lon) points, ``step`` seconds apart."""
    return [
        TrackPoint(lat, lon, 300.0, start + index * step)
        for index, (lat, lon) in enumerate(points)
    ]


def _circuit():
    return _path(
        (51.55, 12.05), (51.56, 12.10), (51.58, 12.10), (51.58, 12.03), (51.55, 12.05)
    )


def _cross_country():
    return _path((51.55, 12.05), (51.40, 12.50), (51.13, 13.76), step=120)


@pytest.fixture(autouse=True)
def preview_cache(tmp_path_factory, monkeypatch):
    """A cache of its own for every test, and no process pool."""
    cache = tmp_path_factory.mktemp("previews") / "cache"
    monkeypatch.setattr(previews, "PREVIEW_CACHE_DIR", cache)
    monkeypatch.setattr(os, "process_cpu_count", lambda: 1)
    return cache


class TestNormalizeSiteUrl:
    @pytest.mark.parametrize("unset", [None, "", "  "])
    def test_unset(self, unset):
        assert normalize_site_url(unset) is None

    @pytest.mark.parametrize(
        ("given", "expected"),
        [
            ("https://example.org/flights/", "https://example.org/flights"),
            (" http://127.0.0.1:8000 ", "http://127.0.0.1:8000"),
            (
                "https://user.github.io/flown",
                "https://user.github.io/flown",
            ),
        ],
    )
    def test_absolute_urls(self, given, expected):
        assert normalize_site_url(given) == expected

    @pytest.mark.parametrize(
        "given",
        [
            "/flights",
            "example.org",
            "ftp://example.org",
            "https://example.org/?x=1",
            "https://example.org/#top",
            # Empty, but a path appended to them would be a query or fragment
            "https://example.org/?",
            "https://example.org/#",
            "https://example.org/a\x00b",
            'https://example.org/"><script>',
            "https://exa mple.org",
        ],
    )
    def test_anything_else_is_refused(self, given):
        with pytest.raises(ValueError, match="absolute http"):
            normalize_site_url(given)


class TestEncodePathId:
    @pytest.mark.parametrize("path_id", [0, 35, 36, 411100833082, 2**40 - 1])
    def test_base_36_as_the_page_writes_it(self, path_id):
        text = encode_path_id(path_id)
        assert int(text, 36) == path_id
        assert text == text.lower()

    def test_zero(self):
        assert encode_path_id(0) == "0"


class TestTrackOf:
    def test_timed_stretches_take_their_time(self):
        track = track_of(_path((51.0, 12.0), (51.0, 12.01), step=4))
        assert len(track) == 6
        assert track[2] == 0.0
        assert track[5] == 4.0
        assert 0 < track[0] < 1
        assert 0 < track[1] < 1

    def test_north_is_up(self):
        track = track_of(_path((51.0, 12.0), (52.0, 12.0)))
        assert track[4] < track[1]

    @pytest.mark.parametrize("gap", [0.0, -3.0, 600.0])
    def test_a_gap_counts_at_a_cruise_pace(self, gap):
        path = [TrackPoint(51.0, 12.0, 300.0, 100.0), TrackPoint(51.0, 12.01, 300.0)]
        untimed = track_of(path)[5]
        path[1] = path[1]._replace(ts=100.0 + gap)
        # 0.01 degrees of longitude at 51 N are about 700 m, 14 s at 100 kt
        assert track_of(path)[5] == pytest.approx(untimed)
        assert untimed == pytest.approx(13.6, abs=0.3)

    def test_a_flight_across_the_antimeridian_runs_on(self):
        path = [TrackPoint(-17.5, 179.95, 300.0), TrackPoint(-17.5, -179.95, 300.0)]
        track = track_of(path)

        assert track[3] == pytest.approx(track[0] + 0.1 / 360)
        # 0.1 degrees of longitude at 17.5 S are about 10.6 km, not the world
        assert track[5] == pytest.approx(10_600 / previews.REFERENCE_SPEED_MS, rel=0.01)

    def test_the_poles_stay_on_the_map(self):
        track = track_of(_path((89.9, 0.0), (-89.9, 0.0)))
        assert track[1] == pytest.approx(0, abs=1e-6)
        assert track[4] == pytest.approx(1, abs=1e-6)


class TestRenderPreview:
    def test_a_palette_png_without_a_time_or_text_chunk(self):
        png = render_preview([track_of(_circuit())])

        kinds = [kind for kind, _ in _chunks(png)]
        assert kinds == [b"IHDR", b"PLTE", b"IDAT", b"IEND"]
        header = dict(_chunks(png))[b"IHDR"]
        assert struct.unpack(">IIBBBBB", header) == (
            PREVIEW_WIDTH,
            PREVIEW_HEIGHT,
            8,
            3,
            0,
            0,
            0,
        )
        assert b"tIME" not in png

    def test_the_same_tracks_give_the_same_bytes(self):
        tracks = [track_of(_circuit()), track_of(_cross_country())]
        assert render_preview(tracks) == render_preview(
            [array("d", track) for track in tracks]
        )

    def test_the_background_is_the_page_and_the_last_entry_white(self):
        palette, rows = _pixels(render_preview([track_of(_circuit())]))

        assert palette[:3] == b"\x14\x14\x14"
        assert all(value >= 245 for value in palette[-3:])
        # The corners are far from any track
        assert rows[0][0] == rows[-1][-1] == 0

    def test_nothing_to_draw_is_the_background(self):
        _, rows = _pixels(render_preview([]))
        assert set(b"".join(rows)) == {0}

    def test_a_stretch_without_time_adds_no_heat(self):
        standing = _path((51.0, 12.0), (51.0, 12.0), step=0)
        _, rows = _pixels(render_preview([track_of(standing)]))
        assert set(b"".join(rows)) == {0}

    def test_the_busiest_pixels_reach_white(self):
        _, rows = _pixels(render_preview([track_of(_cross_country())]))

        lit = sorted((value for row in rows for value in row if value), reverse=True)
        busiest = lit[: len(lit) // 200]
        white = previews._PALETTE_SIZE * (
            (previews.WHITE_HEAT / previews.MAX_HEAT) ** 0.5
        )
        assert busiest
        assert min(busiest) >= int(white) - 1
        # The rest stays below: the exposure follows the busiest pixels
        assert lit[len(lit) // 10] < int(white)

    def test_the_tracks_are_fitted_into_the_image(self):
        _, rows = _pixels(render_preview([track_of(_cross_country())]))

        lit_rows = [index for index, row in enumerate(rows) if any(row)]
        lit_columns = [
            column
            for column in range(PREVIEW_WIDTH)
            if any(row[column] for row in rows)
        ]
        # Filled to the margin one way, centered the other
        assert lit_columns[0] < previews.MARGIN_PX
        assert lit_columns[-1] > PREVIEW_WIDTH - previews.MARGIN_PX
        assert lit_rows[0] > 0
        assert lit_rows[-1] < PREVIEW_HEIGHT - 1
        assert abs((lit_rows[0] + lit_rows[-1]) / 2 - PREVIEW_HEIGHT / 2) < 5

    def test_a_short_flight_is_not_zoomed_in_without_end(self):
        tiny = track_of(_path((51.0, 12.0), (51.0, 12.0001)))
        _, rows = _pixels(render_preview([tiny]))

        lit_columns = [
            column
            for column in range(PREVIEW_WIDTH)
            if any(row[column] for row in rows)
        ]
        # 7 m are a pixel at the closest zoom, and the glow reaches ~50 px
        assert lit_columns[-1] - lit_columns[0] < 200

    @staticmethod
    def _lit_columns(png):
        _, rows = _pixels(png)
        return [
            column
            for column in range(PREVIEW_WIDTH)
            if any(row[column] for row in rows)
        ]

    def test_a_flight_across_the_antimeridian_is_drawn_as_anywhere_else(self):
        def flight(east):
            return _path(
                (-17.8, east - 2.6), (-17.5, east - 0.1), (-16.7, east + 0.1), step=600
            )

        # Over Fiji, and the same flight shifted half the world to Greenwich
        fiji = flight(180.0)
        fiji = [point._replace(lon=(point.lon + 180) % 360 - 180) for point in fiji]
        assert any(point.lon < 0 for point in fiji)
        greenwich = flight(0.0)

        assert self._lit_columns(render_preview([track_of(fiji)])) == (
            self._lit_columns(render_preview([track_of(greenwich)]))
        )

    def test_flights_either_side_of_the_antimeridian_are_fitted_together(self):
        west = track_of(_path((-17.0, 179.5), (-17.2, 179.8)))
        east = track_of(_path((-16.9, -179.6), (-17.1, -179.3)))
        apart = track_of(_path((-17.0, -0.5), (-17.2, -0.2)))
        together = track_of(_path((-16.9, 0.4), (-17.1, 0.7)))

        for tracks in ([west, east], [east, west]):
            assert self._lit_columns(render_preview(tracks)) == (
                self._lit_columns(render_preview([apart, together]))
            )


class TestRenderImages:
    def test_drawn_once_then_taken_from_the_cache(
        self, tmp_path, preview_cache, monkeypatch
    ):
        job = PreviewJob("f/a.png", (DrawnPath(_circuit()),))
        render_images([job], tmp_path / "first")
        drawn = (tmp_path / "first" / "f" / "a.png").read_bytes()
        assert drawn == render_preview(job.tracks)
        assert len(list(preview_cache.iterdir())) == 1

        def refuse(tracks):
            raise AssertionError("drawn again")

        monkeypatch.setattr(previews, "render_preview", refuse)
        render_images([job], tmp_path / "second")
        assert (tmp_path / "second" / "f" / "a.png").read_bytes() == drawn

    def test_a_cached_image_projects_no_track(
        self, tmp_path, preview_cache, monkeypatch
    ):
        render_images([PreviewJob("a.png", (DrawnPath(_circuit()),))], tmp_path / "a")

        def refuse(path):
            raise AssertionError("projected")

        monkeypatch.setattr(previews, "track_of", refuse)
        render_images([PreviewJob("a.png", (DrawnPath(_circuit()),))], tmp_path / "b")
        assert (tmp_path / "b" / "a.png").is_file()

    def test_a_path_is_projected_once_for_all_its_images(self, monkeypatch):
        projected = []

        def project(path):
            projected.append(path)
            return track_of(path)

        monkeypatch.setattr(previews, "track_of", project)
        path = DrawnPath(_circuit())
        for job in (PreviewJob("f/a.png", (path,)), PreviewJob("y/1.png", (path,))):
            assert job.tracks == (track_of(_circuit()),)
        assert len(projected) == 1

    def test_an_image_in_use_outlives_the_pruning(self, tmp_path, preview_cache):
        used = PreviewJob("a.png", (DrawnPath(_circuit()),))
        render_images([used], tmp_path / "first")
        (entry,) = preview_cache.iterdir()
        stale = preview_cache / "stale.png"
        stale.write_bytes(b"\x89PNG")
        long_ago = time.time() - 31 * 24 * 3600
        for path in (entry, stale):
            os.utime(path, (long_ago, long_ago))

        render_images([used], tmp_path / "second")

        assert list(preview_cache.iterdir()) == [entry]

    def test_the_key_follows_the_tracks_and_the_module(self):
        one = PreviewJob("a.png", (DrawnPath(_circuit()),))
        other = PreviewJob("a.png", (DrawnPath(_cross_country()),))
        both = PreviewJob("b.png", (*one.paths, *other.paths))

        keys = {job.key(b"x") for job in (one, other, both)}
        assert len(keys) == 3
        assert one.key(b"x") != one.key(b"y")
        # Where it is published plays no part
        assert PreviewJob("c.png", one.paths).key(b"x") == one.key(b"x")

    def test_the_key_follows_every_value_a_track_is_drawn_from(self):
        """The latitude, the longitude and the time of each point change the
        key; the altitude, which the images do not draw, does not."""
        base = _circuit()

        def key(points):
            return PreviewJob("a.png", (DrawnPath(points),)).key(b"x")

        first = base[1]
        changed = [
            first._replace(lat=first.lat + 1e-9),
            first._replace(lon=first.lon + 1e-9),
            first._replace(ts=first.ts + 1),
            first._replace(ts=None),
        ]
        keys = {key([base[0], point, *base[2:]]) for point in changed}
        assert len(keys | {key(base)}) == len(changed) + 1
        assert key([base[0], first._replace(alt=9999.0), *base[2:]]) == key(base)

    def test_a_drawn_path_keeps_a_digest_not_its_points(self):
        path = DrawnPath(_circuit())
        assert not hasattr(path, "content")
        assert len(path.digest) == 16

    def test_the_module_digest_follows_every_module_that_draws(
        self, tmp_path, monkeypatch
    ):
        """A change to the PNG encoder draws the images again, not only one
        to this module."""
        package = tmp_path / "flown"
        package.mkdir()
        for module in previews._DRAWING_MODULES:
            (package / f"{module}.py").write_text(f"# {module}\n")
        monkeypatch.setattr(previews, "__file__", str(package / "previews.py"))

        first = previews._module_digest()
        (package / "png.py").write_text("# changed\n")
        second = previews._module_digest()
        (package / "geometry.py").unlink()

        assert len({first, second, previews._module_digest()}) == 3

    def test_a_broken_cache_entry_is_drawn_again(self, tmp_path, preview_cache):
        job = PreviewJob("a.png", (DrawnPath(_circuit()),))
        render_images([job], tmp_path / "first")
        (entry,) = preview_cache.iterdir()
        entry.write_bytes(b"not a png")

        render_images([job], tmp_path / "second")

        assert (tmp_path / "second" / "a.png").read_bytes() == render_preview(
            job.tracks
        )
        assert entry.read_bytes().startswith(b"\x89PNG")

    def test_a_failed_write_leaves_no_temp_file(self, tmp_path, monkeypatch):
        def fail(source, target):
            raise OSError("disk full")

        monkeypatch.setattr(os, "replace", fail)
        with pytest.raises(OSError, match="disk full"):
            previews._write_file(tmp_path / "a.png", b"data")
        assert list(tmp_path.iterdir()) == []

    def test_a_failed_write_of_the_data_leaves_no_temp_file(
        self, tmp_path, monkeypatch
    ):
        class Full:
            def __init__(self, *args, **kwargs):
                self.name = str(tmp_path / ".a.png.x.tmp")
                Path(self.name).write_bytes(b"")

            def __enter__(self):
                return self

            def __exit__(self, *exc_info):
                return False

            def write(self, data):
                raise OSError("disk full")

        monkeypatch.setattr("flown.cache.tempfile.NamedTemporaryFile", Full)
        with pytest.raises(OSError, match="disk full"):
            previews._write_file(tmp_path / "a.png", b"data")
        assert list(tmp_path.iterdir()) == []

    def test_the_same_image_is_drawn_once(self, tmp_path, monkeypatch):
        """A year of one flight draws what the flight draws."""
        drawn = []

        def render(tracks):
            drawn.append(tracks)
            return b"\x89PNG fake"

        monkeypatch.setattr(previews, "render_preview", render)
        tracks = (DrawnPath(_circuit()),)

        render_images(
            [PreviewJob("y/2025.png", tracks), PreviewJob("f/a.png", tracks)],
            tmp_path / "site",
        )

        assert len(drawn) == 1
        for name in ("y/2025.png", "f/a.png"):
            assert (tmp_path / "site" / name).read_bytes() == b"\x89PNG fake"

    def test_a_failed_drawing_names_the_image(self, tmp_path, monkeypatch):
        def fail(tracks):
            raise MemoryError

        monkeypatch.setattr(previews, "render_preview", fail)

        with pytest.raises(RuntimeError, match=r"link preview f/a\.png"):
            render_images([PreviewJob("f/a.png", (DrawnPath(_circuit()),))], tmp_path)

    def test_a_failed_drawing_in_the_pool_names_the_image(self, tmp_path, monkeypatch):
        monkeypatch.setattr(os, "process_cpu_count", lambda: 2)
        # A position that is no number cannot be placed in the image
        broken = DrawnPath(_cross_country())
        broken._track = array("d", [float("nan")] * 6)
        jobs = [
            PreviewJob("f/a.png", (DrawnPath(_circuit()),)),
            PreviewJob("f/b.png", (broken,)),
        ]

        with pytest.raises(RuntimeError, match=r"link preview f/b\.png"):
            render_images(jobs, tmp_path / "site")

    @pytest.mark.parametrize("cannot_start", [True, False])
    def test_a_pool_that_fails_draws_here(
        self, tmp_path, monkeypatch, caplog, cannot_start
    ):
        """No semaphores in a sandbox, or a worker killed for its memory."""
        monkeypatch.setattr(os, "process_cpu_count", lambda: 2)
        if cannot_start:
            pool = MagicMock(side_effect=OSError("no semaphores"))
        else:
            pool = MagicMock()
            broken: Future[bytes] = Future()
            broken.set_exception(BrokenProcessPool("a worker died"))
            pool.return_value.submit.return_value = broken
        monkeypatch.setattr(workers_module, "ProcessPoolExecutor", pool)
        jobs = [
            PreviewJob("f/a.png", (DrawnPath(_circuit()),)),
            PreviewJob("f/b.png", (DrawnPath(_cross_country()),)),
        ]

        render_images(jobs, tmp_path / "site")

        for name in ("f/a.png", "f/b.png"):
            assert (tmp_path / "site" / name).read_bytes().startswith(b"\x89PNG")
        warnings = [r.getMessage() for r in caplog.records]
        assert sum("going on in this process" in w for w in warnings) == 1

    def test_an_unwritable_cache_still_draws(self, tmp_path, preview_cache):
        preview_cache.write_text("a file where the directory should be")
        job = PreviewJob("a.png", (DrawnPath(_circuit()),))

        render_images([job], tmp_path / "site")

        assert (tmp_path / "site" / "a.png").is_file()

    def test_several_images_are_drawn_in_a_pool(self, tmp_path, monkeypatch):
        monkeypatch.setattr(os, "process_cpu_count", lambda: 2)
        jobs = [
            PreviewJob("f/a.png", (DrawnPath(_circuit()),)),
            PreviewJob("f/b.png", (DrawnPath(_cross_country()),)),
        ]

        render_images(jobs, tmp_path / "site")

        for job in jobs:
            assert (tmp_path / "site" / job.name).read_bytes() == render_preview(
                job.tracks
            )


class TestPrunePreviewCache:
    def test_removes_what_was_not_used_for_a_month(self, tmp_path):
        old = tmp_path / "old.png"
        fresh = tmp_path / "fresh.png"
        old.write_bytes(b"")
        fresh.write_bytes(b"")
        long_ago = time.time() - 31 * 24 * 3600
        os.utime(old, (long_ago, long_ago))

        assert prune_preview_cache(tmp_path) == 1
        assert not old.exists()
        assert fresh.exists()

    def test_no_cache_yet(self, tmp_path):
        assert prune_preview_cache(tmp_path / "missing") == 0


def _meta(page, key):
    """The content of the meta tags named ``key`` (property or name)."""
    tree = lxml_html.fromstring(page)
    return [
        element.get("content")
        for element in tree.iter("meta")
        if key in (element.get("property"), element.get("name"))
    ]


def _write(
    tmp_path,
    site_url,
    paths=None,
    metadata=None,
    ids=None,
    airport_names=frozenset({"EDAQ Halle-Oppin", "EDDC Dresden"}),
):
    paths = paths or [_circuit(), _cross_country()]
    metadata = metadata or [
        {
            "year": 2025,
            "airport_name": "EDAQ Halle-Oppin",
            "start_point": [51.55, 12.05, 90.0],
            "aircraft_registration": "D-EAGJ",
            "aircraft_type": "DA20",
        },
        {
            "year": 2026,
            "airport_name": "EDAQ Halle-Oppin - EDDC Dresden",
            "start_point": [51.55, 12.05, 90.0],
        },
    ]
    ids = ids if ids is not None else {0: 411100833082, 1: 36}
    write_previews(
        tmp_path,
        paths,
        metadata,
        ids,
        airport_names,
        site_url,
    )
    return sorted(
        path.relative_to(tmp_path).as_posix()
        for path in tmp_path.rglob("*")
        if path.is_file()
    )


@pytest.fixture
def fake_images(monkeypatch):
    """Images that take no time to draw, for the tests of the pages."""
    monkeypatch.setattr(previews, "render_preview", lambda tracks: b"\x89PNG fake")


class TestWritePreviews:
    def test_a_page_and_an_image_for_every_year_and_flight(self, tmp_path):
        files = _write(tmp_path, SITE)

        flight = encode_path_id(411100833082)
        assert files == sorted(
            [
                "preview.png",
                "y/2025.html",
                "y/2025.png",
                "y/2026.html",
                "y/2026.png",
                f"f/{flight}.html",
                f"f/{flight}.png",
                "f/10.html",
                "f/10.png",
            ]
        )

    @pytest.mark.usefixtures("fake_images")
    def test_a_flight_page_sends_the_browser_to_the_flight(self, tmp_path):
        _write(tmp_path, SITE)
        flight = encode_path_id(411100833082)
        page = (tmp_path / "f" / f"{flight}.html").read_text()

        target = f"../?y=2025&p={flight}&sv=4"
        tree = lxml_html.fromstring(page)
        assert tree.xpath('//meta[@http-equiv="refresh"]/@content') == [
            f"0; url={target}"
        ]
        assert tree.xpath("//a/@href") == [target]
        assert _meta(page, "og:url") == [f"{SITE}/f/{flight}.html"]
        assert _meta(page, "og:image") == [f"{SITE}/f/{flight}.png"]
        assert _meta(page, "og:image:width") == ["1200"]
        assert _meta(page, "og:image:height") == ["630"]
        assert _meta(page, "twitter:card") == ["summary_large_image"]
        assert _meta(page, "og:title") == ["EDAQ Halle-Oppin (2025) · Flown"]
        assert _meta(page, "og:description") == [
            "Flown in 2025 in D-EAGJ DA20, on the flight heatmap"
        ]
        # No script, and nothing loaded
        assert "<script" not in page
        assert tree.xpath('//meta[@http-equiv="Content-Security-Policy"]/@content') == [
            "default-src 'none'; base-uri 'none'; form-action 'none'"
        ]

    @pytest.mark.usefixtures("fake_images")
    def test_a_route_is_named_by_both_airports(self, tmp_path):
        _write(tmp_path, SITE)
        page = (tmp_path / "f" / "10.html").read_text()
        assert _meta(page, "og:title") == [
            "EDAQ Halle-Oppin → EDDC Dresden (2026) · Flown"
        ]

    @pytest.mark.usefixtures("fake_images")
    def test_a_year_page_sends_the_browser_to_the_year(self, tmp_path):
        _write(tmp_path, SITE)
        page = (tmp_path / "y" / "2026.html").read_text()

        tree = lxml_html.fromstring(page)
        assert tree.xpath('//meta[@http-equiv="refresh"]/@content') == [
            "0; url=../?y=2026"
        ]
        assert _meta(page, "og:image") == [f"{SITE}/y/2026.png"]
        assert _meta(page, "og:description") == [
            "1 flight of 2026 on the flight heatmap"
        ]

    def test_without_a_site_url_no_image_and_no_url(self, tmp_path):
        files = _write(tmp_path, None)

        assert not [name for name in files if name.endswith(".png")]
        for name in files:
            page = (tmp_path / name).read_text()
            assert _meta(page, "og:image") == []
            assert _meta(page, "og:url") == []
            assert _meta(page, "twitter:card") == ["summary"]
            assert _meta(page, "og:title")

    @pytest.mark.usefixtures("fake_images")
    def test_names_from_the_input_are_escaped(self, tmp_path):
        start = 'EDAQ "><script>alert(1)</script>'
        metadata = [
            {
                "year": 2025,
                "airport_name": f"{start} - EDDC Dresden",
                "start_point": [51.55, 12.05, 90.0],
                "aircraft_registration": "D-<b>",
            }
        ]
        # The start is a marker of the site, so the title names it
        _write(
            tmp_path,
            SITE,
            [_circuit()],
            metadata,
            {0: 1},
            airport_names={start, "EDDC Dresden"},
        )

        page = (tmp_path / "f" / "1.html").read_text()
        assert "<script" not in page
        assert "<b>" not in page
        title = f"{start} → EDDC Dresden (2025) · Flown"
        assert _meta(page, "og:title") == [title]
        assert lxml_html.fromstring(page).findtext(".//title") == title
        assert _meta(page, "og:description") == [
            "Flown in 2025 in D-<b>, on the flight heatmap"
        ]

    def test_a_flight_without_airports(self, tmp_path):
        metadata = [{"year": 2025, "airport_name": "", "start_point": [0, 0, 0]}]
        _write(tmp_path, None, [_circuit()], metadata, {0: 1})

        page = (tmp_path / "f" / "1.html").read_text()
        assert _meta(page, "og:title") == ["A flight of 2025 · Flown"]
        assert _meta(page, "og:description") == ["Flown in 2025, on the flight heatmap"]

    @pytest.mark.usefixtures("fake_images")
    def test_no_date_finer_than_the_year(self, tmp_path):
        metadata = [
            {
                "year": 2025,
                "airport_name": "EDAQ Halle-Oppin 2025-03-15",
                "start_point": [51.55, 12.05, 90.0],
                "aircraft_type": "2025-03-15",
                "timestamp": "2025-03-15T10:00:00Z",
            }
        ]
        _write(tmp_path, SITE, [_circuit()], metadata, {0: 1})

        for name in ("f/1.html", "y/2025.html"):
            page = (tmp_path / name).read_text()
            assert "03-15" not in page
            assert "10:00" not in page

    def test_a_path_without_a_year_gets_no_page(self, tmp_path):
        metadata = [{"airport_name": "", "start_point": [0, 0, 0]}]
        files = _write(tmp_path, None, [_circuit()], metadata, {0: 1})
        assert files == []


class TestPagePreviewTags:
    def test_with_a_site_url(self):
        tags = page_preview_tags(SITE)
        assert _meta(f"<head>{tags}</head>", "og:image") == [f"{SITE}/preview.png"]
        assert _meta(f"<head>{tags}</head>", "og:url") == [f"{SITE}/"]
        assert _meta(f"<head>{tags}</head>", "twitter:card") == ["summary_large_image"]

    def test_without_one(self):
        tags = page_preview_tags(None)
        assert "og:image" not in tags
        assert _meta(f"<head>{tags}</head>", "twitter:card") == ["summary"]


FRONTEND = Path(__file__).parents[1] / "flown" / "frontend"


def _ts_source(relative):
    return (FRONTEND / relative).read_text(encoding="utf-8")


class TestParityWithThePage:
    def test_the_selection_of_a_flight_page_is_one_the_page_reads(self):
        match = re.search(
            r"\bconst STATE_SCHEMA_VERSION = (\d+);",
            _ts_source("state/urlState.ts"),
        )
        assert match
        assert int(match.group(1)) == previews.STATE_SCHEMA_VERSION

    def test_the_colours_are_the_heat_cloud_s(self):
        match = re.search(
            r"\bconst CLOUD_COLOUR = \[([^\]]+)\] as const;",
            _ts_source("ui/heatCloudShaders.ts"),
        )
        assert match
        rates = tuple(float(rate) for rate in match.group(1).split(","))
        assert rates == previews.CLOUD_COLOUR

    def test_the_background_is_the_page_s(self):
        styles = (
            Path(__file__).parents[1] / "flown" / "static" / "styles.css"
        ).read_text(encoding="utf-8")
        grey = f"{previews.BACKGROUND:02x}"
        assert f"--color-bg-primary: #{grey * 3};" in styles
