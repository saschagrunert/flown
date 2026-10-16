"""Link previews: an image of the site, of each year and of each flight.

A link shared in a chat or a post unfolds from the Open Graph tags of the
page it points to. Scrapers run no JavaScript and ignore the query string,
so ``?y=2025&p=...`` cannot bring an image of its own: every year and every
flight gets a small page of its own instead (``y/2025.html``,
``f/<id>.html``), which carries its tags and sends a browser on to the map
with a meta refresh. The map's CSP allows no inline script and no
``<base>``, and a stub has no script at all. The paths are flat, so a
flight that leaves the input takes its page and its image with it (see
``PREVIEW_FILE_PATTERNS`` and ``SiteOutput``).

``og:image`` takes an absolute URL, and nothing in the build knows where
the site is published: the images are only drawn, and named in the tags,
when the site's URL is given (``--site-url`` or ``SITE_URL_ENV``). The
stubs are written either way.

The images are drawn with the standard library alone: the tracks as a glow
weighted by the time spent on them, on the page's background, in the
colours of the heat cloud of the 3D view (``CLOUD_COLOUR`` in
ui/heatCloudShaders.ts), written as a palette PNG. They carry no text, no
date and no build stamp, and only exported flights are drawn. The same
tracks always give the same bytes, so an image is cached under a hash of
what it draws and of this module (see ``PreviewJob.key``).
"""

import contextlib
import hashlib
import heapq
import html
import math
import os
import struct
import time
import zlib
from array import array
from bisect import bisect_right
from dataclasses import dataclass
from functools import partial
from itertools import accumulate, chain
from operator import add, sub
from pathlib import Path
from typing import TYPE_CHECKING
from urllib.parse import quote, urlsplit

from .cache import CACHE_DIR, atomic_bytes_write
from .export_pipeline import build_path_info
from .geometry import web_mercator
from .logger import logger
from .png import PNG_SIGNATURE, chunk
from .workers import WorkerPool, default_worker_count

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping, Sequence

    from .types import FlightPath, FlightPathGroup, PathInfo, PathMetadata

__all__ = [
    "PREVIEW_FILES",
    "PREVIEW_FILE_PATTERNS",
    "PREVIEW_HEIGHT",
    "PREVIEW_WIDTH",
    "SITE_PREVIEW",
    "SITE_URL_ENV",
    "STATE_SCHEMA_VERSION",
    "DrawnPath",
    "PreviewJob",
    "encode_path_id",
    "normalize_site_url",
    "page_preview_tags",
    "render_preview",
    "track_of",
    "write_previews",
]

#: The public address of the site, which the absolute URLs of the images
#: and pages are made from
SITE_URL_ENV = "FLOWN_SITE_URL"

#: The size Open Graph and the large Twitter card ask for (1.91:1)
PREVIEW_WIDTH = 1200
PREVIEW_HEIGHT = 630

#: The image of the whole site, next to the page
SITE_PREVIEW = "preview.png"
YEAR_DIR = "y"
FLIGHT_DIR = "f"
#: What a run writes next to the page with names that depend on the flights;
#: the ones it does not write again are removed (see ``SiteOutput``)
PREVIEW_FILE_PATTERNS = tuple(
    f"{directory}/*.{suffix}"
    for directory in (YEAR_DIR, FLIGHT_DIR)
    for suffix in ("html", "png")
)
PREVIEW_FILES = (SITE_PREVIEW,)
#: The version of the link's selection a flight's page sends the browser on
#: with: from 4 on, the path ids are in base 36 (``STATE_SCHEMA_VERSION`` in
#: state/urlState.ts)
STATE_SCHEMA_VERSION = 4

#: The page's background (--color-bg-primary in static/styles.css), which
#: the glow is laid over
BACKGROUND = 0x14
#: How fast each channel fills with heat, as in the heat cloud: blue first,
#: then green, then red (``CLOUD_COLOUR`` in ui/heatCloudShaders.ts)
CLOUD_COLOUR = (0.04, 0.26, 0.62)
#: The heat at which red, the last channel to fill, is 95% full: white
WHITE_HEAT = -math.log(0.05) / CLOUD_COLOUR[0]
#: The heat of the last palette entry, where red is 99% full
MAX_HEAT = -math.log(0.01) / CLOUD_COLOUR[0]
#: The part of the lit pixels that reaches white. The exposure follows the
#: image: one flight fills it as well as a hundred do.
WHITE_SHARE = 0.005
#: The glow is three box blurs of this radius each way, about a Gaussian
#: of sqrt(r * (r + 1)) = 4.5 px
GLOW_RADIUS = 4
GLOW_PASSES = 3
#: Around it a wide halo: two box blurs of this radius on top of it, at
#: half the resolution (about 14 px at the full one). It makes up
#: HALO_PARTS of CORE_PARTS + HALO_PARTS of the glow.
HALO_RADIUS = 5
HALO_PASSES = 2
CORE_PARTS = 2
HALO_PARTS = 1
#: Room left around the flights, in pixels
MARGIN_PX = 60
#: A short local flight is not zoomed in further than this
MIN_METRES_PER_PX = 8.0
#: A gap between two fixes longer than this is no time spent on the stretch
#: between them (a logger paused, a stop); it counts as a cruise instead
MAX_FIX_GAP_S = 60.0
#: A cruise of 100 kt, the pace of a stretch without a usable time
REFERENCE_SPEED_MS = 51.4
EARTH_CIRCUMFERENCE_M = 40_075_016.686
#: Heat is added up in whole milliseconds per pixel, which keeps the blur
#: exact
HEAT_UNIT = 1000
#: The floats of a point in a track: x and y in Web Mercator (0 to 1, x
#: beyond that where the track crosses the antimeridian) and the seconds
#: spent on the stretch that ends at it
TRACK_STRIDE = 3

#: Preview images that were not used for this long are removed
CACHE_MAX_AGE_DAYS = 30
PREVIEW_CACHE_DIR = CACHE_DIR / "previews"

_PALETTE_SIZE = 256


def normalize_site_url(url: str | None) -> str | None:
    """The site's address without a trailing slash, None when it is not set.

    Raises ValueError for anything but an absolute http(s) URL without a
    query or fragment (not even an empty one, which a path would be appended
    to): a scraper cannot resolve a relative ``og:image``.
    """
    url = (url or "").strip()
    if not url:
        return None
    parts = urlsplit(url)
    if (
        parts.scheme not in ("http", "https")
        or not parts.netloc
        or any(
            char.isspace() or not char.isprintable() or char in "\"'<>?#"
            for char in url
        )
    ):
        raise ValueError(
            f"The site URL must be an absolute http(s) address, such as "
            f"https://example.org/flights, not {url!r}"
        )
    return url.rstrip("/")


def encode_path_id(path_id: int) -> str:
    """A path id in base 36, as the page writes it into a link."""
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    text = ""
    while True:
        path_id, digit = divmod(path_id, 36)
        text = digits[digit] + text
        if not path_id:
            return text


def track_of(path: FlightPath) -> array[float]:
    """A path as the images draw it (see ``TRACK_STRIDE``).

    The seconds of a stretch come from the timestamps of its ends; without
    them, or across a gap, from its length at a cruise's pace. A point is
    kept on the world copy of the one before, so a flight across the
    antimeridian runs on past 1 (or below 0) rather than back across the
    whole map.
    """
    track: array[float] = array("d")
    previous: tuple[float, float, float | None] | None = None
    for point in path:
        x, y = web_mercator(point.lat, point.lon)
        seconds = 0.0
        if previous is not None:
            x0, y0, ts0 = previous
            x += round(x0 - x)
            gap = None if ts0 is None or point.ts is None else point.ts - ts0
            if gap is not None and 0 < gap <= MAX_FIX_GAP_S:
                seconds = gap
            else:
                metres = (
                    math.hypot(x - x0, y - y0)
                    * EARTH_CIRCUMFERENCE_M
                    * math.cos(math.radians(point.lat))
                )
                seconds = metres / REFERENCE_SPEED_MS
        track.extend((x, y, seconds))
        previous = (x, y, point.ts)
    return track


def _world_shifts(tracks: Sequence[array[float]]) -> list[int]:
    """The whole worlds to move each track by, so they span the least.

    Each track starts out on the first world copy. Flights either side of
    the antimeridian are nearer to each other with the western ones moved
    a world east; that is taken when it spans less.
    """
    spans = [
        (min(track[0::TRACK_STRIDE]), max(track[0::TRACK_STRIDE])) for track in tracks
    ]
    near = [-math.floor(low) for low, _ in spans]
    east = [
        shift + int((low + high) / 2 + shift < 0.5)
        for shift, (low, high) in zip(near, spans, strict=True)
    ]

    def width(shifts: list[int]) -> float:
        placed = [
            (low + shift, high + shift)
            for shift, (low, high) in zip(shifts, spans, strict=True)
        ]
        return max(high for _, high in placed) - min(low for low, _ in placed)

    return east if width(east) < width(near) else near


def _view(
    tracks: Sequence[array[float]], shifts: Sequence[int]
) -> tuple[float, float, float]:
    """Scale and offset from Web Mercator to the pixels of the image."""
    xs = [
        [x + shift for x in track[0::TRACK_STRIDE]]
        for track, shift in zip(tracks, shifts, strict=True)
    ]
    ys = [track[1::TRACK_STRIDE] for track in tracks]
    x0, x1 = min(map(min, xs)), max(map(max, xs))
    y0, y1 = min(map(min, ys)), max(map(max, ys))
    middle_lat = math.atan(math.sinh(math.pi * (1 - (y0 + y1))))
    closest = EARTH_CIRCUMFERENCE_M * math.cos(middle_lat) / MIN_METRES_PER_PX
    scale = min(
        (PREVIEW_WIDTH - 2 * MARGIN_PX) / max(x1 - x0, 1e-12),
        (PREVIEW_HEIGHT - 2 * MARGIN_PX) / max(y1 - y0, 1e-12),
        closest,
    )
    return (
        scale,
        PREVIEW_WIDTH / 2 - (x0 + x1) / 2 * scale,
        PREVIEW_HEIGHT / 2 - (y0 + y1) / 2 * scale,
    )


def _rasterize(tracks: Sequence[array[float]]) -> list[int]:
    """The time spent on every pixel, in ``HEAT_UNIT`` (row by row).

    Each stretch spreads its seconds evenly over the pixels it crosses, so
    a slow stretch (a circuit, the taxiing) is hotter than a fast one.
    """
    width, height = PREVIEW_WIDTH, PREVIEW_HEIGHT
    heat = [0] * (width * height)
    if not tracks:
        return heat
    shifts = _world_shifts(tracks)
    scale, offset_x, offset_y = _view(tracks, shifts)
    for track, shift in zip(tracks, shifts, strict=True):
        x0 = y0 = 0.0
        for index in range(0, len(track), TRACK_STRIDE):
            x = (track[index] + shift) * scale + offset_x
            y = track[index + 1] * scale + offset_y
            if index:
                dx, dy = x - x0, y - y0
                steps = int(max(abs(dx), abs(dy))) + 1
                weight = round(track[index + 2] * HEAT_UNIT / steps)
                if weight:
                    for step in range(steps):
                        along = (step + 0.5) / steps
                        column = int(x0 + dx * along)
                        row = int(y0 + dy * along)
                        if 0 <= column < width and 0 <= row < height:
                            heat[row * width + column] += weight
            x0, y0 = x, y
    return heat


def _box_blur(lines: Iterable[Sequence[int]], radius: int) -> list[Sequence[int]]:
    """Every line blurred by a box of ``radius``, as running sums.

    The sums are exact integers and not divided by the box: the exposure
    takes the scale out again.
    """
    width = 2 * radius + 1
    before, after = [0] * (radius + 1), [0] * radius
    blurred: list[Sequence[int]] = []
    for line in lines:
        if not any(line):
            blurred.append(line)
            continue
        sums = list(accumulate(chain(before, line, after)))
        blurred.append(list(map(sub, sums[width:], sums[:-width], strict=True)))
    return blurred


def _blur(lines: list[Sequence[int]], radius: int, passes: int) -> list[Sequence[int]]:
    """``passes`` box blurs of ``radius`` along the lines, then across."""
    for _ in range(passes):
        lines = _box_blur(lines, radius)
    across: list[Sequence[int]] = list(zip(*lines, strict=True))
    for _ in range(passes):
        across = _box_blur(across, radius)
    return list(zip(*across, strict=True))


def _halved(lines: Sequence[Sequence[int]]) -> list[Sequence[int]]:
    """The lines at half the resolution, each pixel the sum of four."""
    return [
        list(map(add, pairs[0::2], pairs[1::2], strict=True))
        for pairs in (
            list(map(add, first, second, strict=True))
            for first, second in zip(lines[0::2], lines[1::2], strict=True)
        )
    ]


def _doubled(lines: Sequence[Sequence[int]]) -> list[Sequence[int]]:
    """The lines at twice the resolution, each pixel repeated."""
    wide = [list(chain.from_iterable(zip(line, line, strict=True))) for line in lines]
    return list(chain.from_iterable(zip(wide, wide, strict=True)))


def _glow(heat: list[int]) -> list[Sequence[int]]:
    """The heat blurred into a glow, row by row: a core and a wide halo.

    The halo is blurred at half the resolution, where it takes a quarter of
    the time and, as soft as it is, looks the same.
    """
    width = PREVIEW_WIDTH
    core = _blur(
        [heat[start : start + width] for start in range(0, len(heat), width)],
        GLOW_RADIUS,
        GLOW_PASSES,
    )
    halo = _doubled(_blur(_halved(core), HALO_RADIUS, HALO_PASSES))
    # The halo's sums are the core's times four pixels and its boxes, which
    # the core is scaled by to match
    core_weight = CORE_PARTS * 4 * (2 * HALO_RADIUS + 1) ** (2 * HALO_PASSES)
    # map rather than a comprehension: a pixel costs a C call, not a loop
    return [
        list(
            map(
                add,
                map(core_weight.__mul__, c_row),
                map(HALO_PARTS.__mul__, h_row),
                strict=True,
            )
        )
        if any(h_row)
        else h_row
        for c_row, h_row in zip(core, halo, strict=True)
    ]


def _palette() -> bytes:
    """256 colours from the background to white.

    Entry i is the heat ``MAX_HEAT * (i / 255)**2`` screened over the
    background, each channel filled at its rate: the square root spends
    the entries where the colour changes fastest, on the faint glow.
    """
    background = BACKGROUND / 255
    palette = bytearray()
    for entry in range(_PALETTE_SIZE):
        heat = MAX_HEAT * (entry / (_PALETTE_SIZE - 1)) ** 2
        for rate in CLOUD_COLOUR:
            filled = 1 - math.exp(-heat * rate)
            palette.append(round(255 * (filled + background * (1 - filled))))
    return bytes(palette)


def _indices(rows: Sequence[Sequence[int]]) -> list[bytes]:
    """The palette entry of every pixel, row by row.

    Exposed so that the busiest ``WHITE_SHARE`` of the lit pixels reach
    ``WHITE_HEAT``; an image without a lit pixel is the background.
    """
    lit = list(chain.from_iterable(map(partial(filter, None), rows)))
    blank = bytes(PREVIEW_WIDTH)
    if not lit:
        return [blank] * PREVIEW_HEIGHT
    reference = heapq.nlargest(max(1, int(len(lit) * WHITE_SHARE)), lit)[-1]
    # The glow a pixel needs for each entry, halfway from the one before
    top = _PALETTE_SIZE - 1
    thresholds = [
        reference / WHITE_HEAT * MAX_HEAT * ((entry - 0.5) / top) ** 2
        for entry in range(1, _PALETTE_SIZE)
    ]
    entry_of = partial(bisect_right, thresholds)
    return [bytes(map(entry_of, row)) if any(row) else blank for row in rows]


def _encode_png(rows: Sequence[bytes]) -> bytes:
    """An 8-bit palette PNG of the rows; no time, text or other chunk."""
    header = struct.pack(">IIBBBBB", PREVIEW_WIDTH, PREVIEW_HEIGHT, 8, 3, 0, 0, 0)
    # Filter type 0 on every row, the one the PNG book advises for palettes
    raw = b"".join(b"\x00" + row for row in rows)
    return b"".join(
        (
            PNG_SIGNATURE,
            chunk(b"IHDR", header),
            chunk(b"PLTE", _palette()),
            chunk(b"IDAT", zlib.compress(raw, 9)),
            chunk(b"IEND", b""),
        )
    )


def render_preview(tracks: Sequence[array[float]]) -> bytes:
    """The PNG of the tracks (see ``track_of``), fitted into the image."""
    return _encode_png(_indices(_glow(_rasterize(tracks))))


# The modules whose code decides the bytes of an image: this one draws it,
# png writes it, and geometry projects its tracks
_DRAWING_MODULES = ("previews", "png", "geometry")


def _module_digest() -> bytes:
    """A hash of the modules that draw the images (_DRAWING_MODULES)."""
    digest = hashlib.blake2b(digest_size=16)
    package = Path(__file__).parent
    for module in _DRAWING_MODULES:
        digest.update(module.encode())
        with contextlib.suppress(OSError):
            digest.update((package / f"{module}.py").read_bytes())
    return digest.digest()


class DrawnPath:
    """A path an image draws: what it holds, and its track when it is drawn.

    The cache key comes from the points (``digest``), so a build whose
    images are all cached projects none of them; the track is made once
    for every image the path is in (its own, its year's and the site's).
    Only a digest of the points is kept, not the packed points themselves,
    which would double what the images hold in memory until all are drawn.
    """

    __slots__ = ("_path", "_track", "digest")

    def __init__(self, path: FlightPath) -> None:
        """Keep the path and a digest of what ``track_of`` reads of it."""
        self._path = path
        self._track: array[float] | None = None
        content = array(
            "d",
            [
                value
                for point in path
                for value in (
                    point.lat,
                    point.lon,
                    math.nan if point.ts is None else point.ts,
                )
            ],
        ).tobytes()
        #: A digest of the latitude, longitude and time of every point
        self.digest = hashlib.blake2b(content, digest_size=16).digest()

    def __len__(self) -> int:
        """How many points it has."""
        return len(self._path)

    @property
    def track(self) -> array[float]:
        """The path as the images draw it (see ``track_of``)."""
        if self._track is None:
            self._track = track_of(self._path)
        return self._track


@dataclass(frozen=True)
class PreviewJob:
    """An image to draw: where it is published and what it shows."""

    #: The published path, relative to the page
    name: str
    paths: tuple[DrawnPath, ...]

    def key(self, module_digest: bytes) -> str:
        """The cache key: what it draws and how."""
        digest = hashlib.blake2b(module_digest, digest_size=20)
        for path in self.paths:
            # Digests are of one size, so a run of them reads one way only
            digest.update(path.digest)
        return digest.hexdigest()

    @property
    def tracks(self) -> tuple[array[float], ...]:
        """The tracks it draws (see ``track_of``)."""
        return tuple(path.track for path in self.paths)

    @property
    def points(self) -> int:
        """How many points it draws, which is about how long it takes."""
        return sum(len(path) for path in self.paths)


def _write_file(path: Path, data: bytes) -> None:
    """Write ``data`` atomically, making its directory first."""
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_bytes_write(path, data)


def _cached(entry: Path) -> bytes | None:
    """An image from the cache, renewed for ``prune_preview_cache``."""
    try:
        data = entry.read_bytes()
    except OSError:
        return None
    with contextlib.suppress(OSError):
        os.utime(entry)
    return data if data.startswith(PNG_SIGNATURE) else None


def _store(entry: Path, data: bytes) -> None:
    try:
        _write_file(entry, data)
    except OSError as e:
        logger.debug("Could not cache the preview %s: %s", entry, e)


def prune_preview_cache(cache_dir: Path | None = None) -> int:
    """Remove the cached images not used for ``CACHE_MAX_AGE_DAYS``."""
    cache_dir = cache_dir if cache_dir is not None else PREVIEW_CACHE_DIR
    try:
        entries = list(cache_dir.iterdir())
    except OSError:
        return 0
    oldest = time.time() - CACHE_MAX_AGE_DAYS * 24 * 3600
    removed = 0
    for entry in entries:
        with contextlib.suppress(OSError):
            if entry.is_file() and entry.stat().st_mtime < oldest:
                entry.unlink()
                removed += 1
    return removed


def _draw(missing: Mapping[Path, list[PreviewJob]], site_dir: Path) -> None:
    """Draw the images, cache them and write them into ``site_dir``.

    ``missing`` are the jobs by their cache entry: the jobs of one entry
    draw the same (a year of one flight) and are drawn once. In a process
    pool, the largest first, or here when there is only one. Raises
    RuntimeError when an image cannot be drawn.
    """
    order = sorted(missing, key=lambda entry: missing[entry][0].points, reverse=True)
    workers = min(len(order), default_worker_count())

    def finish(entry: Path, data: bytes) -> None:
        _store(entry, data)
        for job in missing[entry]:
            _write_file(site_dir / job.name, data)

    def fail(entry: Path, exc: Exception) -> RuntimeError:
        return RuntimeError(
            f"Failed to draw the link preview {missing[entry][0].name}: {exc}"
        )

    if workers <= 1:
        for entry in order:
            try:
                data = render_preview(missing[entry][0].tracks)
            except Exception as exc:
                raise fail(entry, exc) from exc
            finish(entry, data)
        return
    # A pool that cannot start, or breaks, draws here (see WorkerPool)
    with WorkerPool(
        workers, "drawing the link previews", (logger.getEffectiveLevel(),)
    ) as executor:
        futures = [
            (entry, executor.submit(render_preview, missing[entry][0].tracks))
            for entry in order
        ]
        for entry, future in futures:
            try:
                data = executor.result(future, render_preview, missing[entry][0].tracks)
            except Exception as exc:
                # The images still queued would only be thrown away
                executor.shutdown(wait=True, cancel_futures=True)
                raise fail(entry, exc) from exc
            finish(entry, data)


def render_images(
    jobs: Sequence[PreviewJob], site_dir: Path, cache_dir: Path | None = None
) -> None:
    """Write the image of every job into ``site_dir``, drawn or from the cache.

    The cache is pruned afterwards, when the images of this run were renewed
    (see ``prune_preview_cache``).
    """
    cache_dir = cache_dir if cache_dir is not None else PREVIEW_CACHE_DIR
    digest = _module_digest()
    missing: dict[Path, list[PreviewJob]] = {}
    cached = 0
    for job in jobs:
        entry = cache_dir / f"{job.key(digest)}.png"
        data = None if entry in missing else _cached(entry)
        if data is None:
            missing.setdefault(entry, []).append(job)
        else:
            _write_file(site_dir / job.name, data)
            cached += 1
    logger.info("  Preview images: %d drawn, %d from the cache", len(missing), cached)
    if missing:
        _draw(missing, site_dir)
    prune_preview_cache(cache_dir)


def _tag(attribute: str, name: str, content: str) -> str:
    return f'<meta {attribute}="{name}" content="{html.escape(content)}" />'


def _image_tags(
    site_url: str | None, page: str, image: str, image_alt: str
) -> list[str]:
    """The tags that name a page's own URL and its image, and the card.

    ``page`` and ``image`` are relative to the site. Both are only named
    when the site's URL is known: the card is a large image then, and a
    plain summary without one.
    """
    if site_url is None:
        return [_tag("name", "twitter:card", "summary")]
    return [
        _tag("property", "og:url", f"{site_url}/{page}"),
        _tag("property", "og:image", f"{site_url}/{image}"),
        _tag("property", "og:image:type", "image/png"),
        _tag("property", "og:image:width", str(PREVIEW_WIDTH)),
        _tag("property", "og:image:height", str(PREVIEW_HEIGHT)),
        _tag("property", "og:image:alt", image_alt),
        _tag("name", "twitter:card", "summary_large_image"),
    ]


def page_preview_tags(site_url: str | None) -> str:
    """The tags of the map's own page that depend on the site's URL.

    Its title and description are in the template.
    """
    return "".join(
        _image_tags(site_url, "", SITE_PREVIEW, "A glowing heatmap of the flown tracks")
    )


_SITE_NAME = "Flown"
# A stub loads nothing and runs nothing; the refresh is no fetch
_STUB_CSP = "default-src 'none'; base-uri 'none'; form-action 'none'"
_STUB = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="{csp}" />
<meta name="referrer" content="strict-origin-when-cross-origin" />
<meta name="robots" content="noindex" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="color-scheme" content="dark" />
<meta http-equiv="refresh" content="0; url={target}" />
<title>{title}</title>
{tags}
</head>
<body>
<p><a href="{target}">{title}</a></p>
</body>
</html>
"""


def _stub(
    title: str,
    description: str,
    site_url: str | None,
    page: str,
    target: str,
    image_alt: str,
) -> str:
    """A page that carries the tags of a view and sends a browser on to it.

    ``target`` is the map with the view in its query, relative to the stub.
    """
    tags = [
        _tag("property", "og:title", title),
        _tag("property", "og:description", description),
        _tag("property", "og:type", "website"),
        *_image_tags(site_url, page, page.removesuffix(".html") + ".png", image_alt),
    ]
    return _STUB.format(
        csp=_STUB_CSP,
        target=html.escape(target),
        title=html.escape(title),
        tags="\n".join(tags),
    )


def _route(info: PathInfo) -> str | None:
    start = info.get("start_airport")
    end = info.get("end_airport")
    if start and end and start != end:
        return f"{start} → {end}"
    return start or end or None


def _flight_texts(info: PathInfo, year: int) -> tuple[str, str]:
    """The title and description of a flight's page: its route, aircraft
    and year, all of which the year file publishes anyway."""
    route = _route(info)
    title = f"{route} ({year})" if route else f"A flight of {year}"
    aircraft = " ".join(
        part
        for part in (info.get("aircraft_registration"), info.get("aircraft_type"))
        if part
    )
    description = f"Flown in {year}"
    if aircraft:
        description += f" in {aircraft}"
    return f"{title} · {_SITE_NAME}", f"{description}, on the map"


def _year_texts(year: int, flights: int) -> tuple[str, str]:
    plural = "flight" if flights == 1 else "flights"
    return (
        f"{year} · {_SITE_NAME}",
        f"{flights} {plural} of {year} on the map",
    )


def write_previews(
    site_dir: Path,
    all_path_groups: FlightPathGroup,
    all_path_metadata: Sequence[PathMetadata],
    path_ids: Mapping[int, int],
    airport_names: frozenset[str] | None,
    site_url: str | None,
) -> None:
    """Write the pages of every year and flight, and their images.

    ``path_ids`` are the ids of the exported paths by input index (see
    ``ExportResult``), ``airport_names`` the exported airport markers (see
    ``build_path_info``). The images, the site's among them, are only
    drawn with a ``site_url`` (see the module).
    """
    logger.info("\nWriting link previews...")
    by_year: dict[int, list[int]] = {}
    for index in sorted(path_ids):
        year = all_path_metadata[index].get("year")
        if year is not None:
            by_year.setdefault(year, []).append(index)

    drawn = (
        {index: DrawnPath(all_path_groups[index]) for index in path_ids}
        if site_url is not None
        else {}
    )
    jobs: list[PreviewJob] = []
    for year, indices in sorted(by_year.items()):
        page = f"{YEAR_DIR}/{year}.html"
        title, description = _year_texts(year, len(indices))
        _write_file(
            site_dir / page,
            _stub(
                title,
                description,
                site_url,
                page,
                f"../?y={year}",
                f"A glowing heatmap of the tracks flown in {year}",
            ).encode(),
        )
        if site_url is not None:
            jobs.append(
                PreviewJob(f"{YEAR_DIR}/{year}.png", tuple(drawn[i] for i in indices))
            )
        for index in indices:
            path_id = encode_path_id(path_ids[index])
            page = f"{FLIGHT_DIR}/{path_id}.html"
            info = build_path_info(
                all_path_groups[index],
                all_path_metadata[index],
                path_ids[index],
                year,
                airport_names,
            )
            title, description = _flight_texts(info, year)
            query = f"y={year}&p={quote(path_id)}&sv={STATE_SCHEMA_VERSION}"
            _write_file(
                site_dir / page,
                _stub(
                    title,
                    description,
                    site_url,
                    page,
                    f"../?{query}",
                    "The glowing track of the flight",
                ).encode(),
            )
            if site_url is not None:
                jobs.append(PreviewJob(f"{FLIGHT_DIR}/{path_id}.png", (drawn[index],)))
    if site_url is not None:
        jobs.append(PreviewJob(SITE_PREVIEW, tuple(drawn[i] for i in sorted(drawn))))
        render_images(jobs, site_dir)
    logger.info(
        "  Link previews: %d year and %d flight page(s)%s",
        len(by_year),
        len(path_ids),
        "" if site_url is not None else " without images (no site URL)",
    )
