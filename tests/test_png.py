"""Tests for the PNG decoder (flown.png).

The PNGs are written by the small encoder of tests/tiles.py, with every
filter type, or broken on purpose for the ones the decoder has to refuse.
"""

import struct
import zlib

import pytest

import flown.png as png_module
from flown.png import PngError, decode_png
from tests.tiles import encode_png, png_chunk


def _noise(count, seed=7):
    """Bytes that exercise every predictor, reproducibly."""
    value = seed
    out = bytearray()
    for _ in range(count):
        value = (value * 1103515245 + 12345) & 0x7FFFFFFF
        out.append(value >> 16 & 0xFF)
    return bytes(out)


class TestDecodePng:
    @pytest.mark.parametrize("channels", [3, 4])
    @pytest.mark.parametrize("kind", [0, 1, 2, 3, 4])
    def test_every_filter_type(self, kind, channels):
        width, height = 7, 5
        pixels = _noise(width * height * channels)
        data = encode_png(width, height, pixels, channels=channels, filters=(kind,))

        assert decode_png(data) == (width, height, channels, bytearray(pixels))

    @pytest.mark.parametrize("channels", [3, 4])
    def test_filter_types_mixed_line_by_line(self, channels):
        width, height = 9, 11
        pixels = _noise(width * height * channels, seed=3)
        data = encode_png(width, height, pixels, channels=channels)

        assert decode_png(data)[3] == bytearray(pixels)

    @pytest.mark.parametrize(
        ("header", "message"),
        [
            ((2, 2, 16, 2, 0, 0, 0), "bit depth 16"),
            ((2, 2, 8, 3, 0, 0, 0), "colour type 3"),
            ((2, 2, 8, 0, 0, 0, 0), "colour type 0"),
            ((2, 2, 8, 2, 0, 0, 1), "interlaced"),
            ((2, 2, 8, 2, 1, 0, 0), "compression or filter"),
            ((2, 2, 8, 2, 0, 1, 0), "compression or filter"),
            ((0, 2, 8, 2, 0, 0, 0), "no pixels"),
        ],
    )
    def test_refuses_what_it_does_not_read(self, header, message):
        data = encode_png(2, 2, bytes(12), header=header)

        with pytest.raises(PngError, match=message):
            decode_png(data)

    def test_refuses_what_is_not_a_png(self):
        with pytest.raises(PngError, match="not a PNG"):
            decode_png(b"GIF89a")

    def test_refuses_a_corrupt_chunk(self):
        data = bytearray(encode_png(2, 2, bytes(12)))
        # A byte of the IHDR body, which its CRC no longer matches
        data[20] ^= 0xFF

        with pytest.raises(PngError, match="corrupt"):
            decode_png(bytes(data))

    @pytest.mark.parametrize("cut", [1, 12, 40])
    def test_refuses_a_cut_off_file(self, cut):
        data = encode_png(2, 2, bytes(12))

        with pytest.raises(PngError, match="IEND"):
            decode_png(data[:-cut])

    def test_refuses_an_unknown_filter_type(self):
        data = encode_png(1, 1, None, raw=b"\x05\x00\x00\x00")

        with pytest.raises(PngError, match="filter type 5"):
            decode_png(data)

    def test_refuses_image_data_of_the_wrong_length(self):
        data = encode_png(2, 2, None, raw=b"\x00" * 7)

        with pytest.raises(PngError, match="wrong length"):
            decode_png(data)

    def test_refuses_a_header_too_large_for_a_tile(self):
        side = png_module.MAX_PNG_SIDE + 1
        data = encode_png(2, 2, bytes(12), header=(side, 1, 8, 2, 0, 0, 0))

        with pytest.raises(PngError, match="too large"):
            decode_png(data)

    def test_inflates_no_further_than_the_image(self, monkeypatch):
        """A small bomb of zeros must not inflate beyond the header's size."""
        bomb = zlib.compress(bytes(64 * 1024 * 1024), 9)
        data = (
            b"\x89PNG\r\n\x1a\n"
            + png_chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 2, 8, 2, 0, 0, 0))
            + png_chunk(b"IDAT", bomb)
            + png_chunk(b"IEND", b"")
        )
        inflated = []
        real = zlib.decompressobj

        class Recording:
            def __init__(self):
                self.inner = real()

            def decompress(self, data, max_length=0):
                out = self.inner.decompress(data, max_length)
                inflated.append(len(out))
                return out

        monkeypatch.setattr(zlib, "decompressobj", Recording)

        with pytest.raises(PngError, match="wrong length"):
            decode_png(data)
        # Two lines of a filter byte and two RGB pixels, and one byte more
        assert inflated == [2 * (2 * 3 + 1) + 1]

    def test_refuses_image_data_that_does_not_inflate(self):
        signature = b"\x89PNG\r\n\x1a\n"
        data = (
            signature
            + png_chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
            + png_chunk(b"IDAT", b"not zlib")
            + png_chunk(b"IEND", b"")
        )

        with pytest.raises(PngError, match="image data is corrupt"):
            decode_png(data)

    def test_refuses_a_png_without_or_with_a_short_header(self):
        signature = b"\x89PNG\r\n\x1a\n"
        without = signature + png_chunk(b"IEND", b"")
        short = signature + png_chunk(b"IHDR", b"\x00" * 12) + png_chunk(b"IEND", b"")

        with pytest.raises(PngError, match="no header"):
            decode_png(without)
        with pytest.raises(PngError, match="header has the wrong length"):
            decode_png(short)
