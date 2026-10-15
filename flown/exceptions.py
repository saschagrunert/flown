"""Custom exceptions for Flown.

The command line tells three kinds of failure apart by its exit status (see
``cli.main``): a problem with what it was given (``InvalidInputError``,
``OutputRefusedError``: 2), a build that failed on the way (``ExportError``
and every other ``FlownError``: 1).
"""

__all__ = [
    "AirportDatabaseError",
    "ExportError",
    "FlownError",
    "InvalidInputError",
    "KMLParseError",
    "OutputRefusedError",
    "TerrainUnavailableError",
]


class FlownError(Exception):
    """Base exception for all Flown errors."""


class InvalidInputError(FlownError):
    """The inputs cannot make a site: a missing, invalid or empty KML file."""


class OutputRefusedError(FlownError):
    """The output directory must not be written (see ``validation``)."""


class ExportError(FlownError):
    """Writing the site failed on the way (a full disk, a worker that died)."""


class AirportDatabaseError(FlownError):
    """Raised when a required airport database cannot be loaded."""


class TerrainUnavailableError(FlownError):
    """Raised when required elevation tiles cannot be fetched or decoded."""


class KMLParseError(FlownError):
    """Raised when KML parsing fails.

    The file and the line are kept as attributes, and the message does not
    repeat them: whoever reports the error names the file (see
    ``pipeline``), and the message of lxml already holds both.
    """

    def __init__(
        self,
        message: str,
        file_path: str | None = None,
        line_number: int | None = None,
    ):
        self.file_path = file_path
        self.line_number = line_number
        super().__init__(message)
