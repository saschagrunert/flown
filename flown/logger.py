"""Centralized logging configuration for flown.

DEBUG and INFO records go to stdout, WARNING and above go to stderr. The
handlers look up ``sys.stdout``/``sys.stderr`` when a record is emitted, so
redirected or captured streams are honored. The status symbols of the
messages (a check mark, a warning sign) are written as they are to a
terminal and in plain ASCII to anything else, such as a CI log or a file.
"""

import logging
import sys
from typing import Any

__all__ = [
    "logger",
    "set_debug_mode",
    "set_info_stream",
    "set_log_level",
    "setup_logger",
]

# What the symbols of the messages become where the stream is no terminal
_ASCII_SYMBOLS = str.maketrans({"✓": "[ok]", "⚠": "[!]", "✗": "[x]", "📥": ">>"})


class _BelowLevelFilter(logging.Filter):
    """Only pass records below a given level."""

    def __init__(self, max_level: int) -> None:
        super().__init__()
        self.max_level = max_level

    def filter(self, record: logging.LogRecord) -> bool:
        return record.levelno < self.max_level


class _SysStreamHandler(logging.StreamHandler):  # type: ignore[type-arg]
    """StreamHandler bound to the *current* sys.stdout or sys.stderr."""

    def __init__(self, stream_name: str) -> None:
        self.stream_name = stream_name
        super().__init__()

    @property
    def stream(self) -> Any:
        return getattr(sys, self.stream_name)

    @stream.setter
    def stream(self, _value: Any) -> None:
        # The stream is always resolved dynamically; ignore assignments.
        return

    def format(self, record: logging.LogRecord) -> str:
        """The record as text, its symbols in ASCII unless on a terminal."""
        text = super().format(record)
        try:
            tty = bool(self.stream.isatty())
        except AttributeError, ValueError:
            tty = False
        return text if tty else text.translate(_ASCII_SYMBOLS)


def setup_logger(
    name: str = "flown", level: int = logging.INFO, debug: bool = False
) -> logging.Logger:
    """Configure and return a logger instance."""
    logger = logging.getLogger(name)

    logger.setLevel(logging.DEBUG if debug else level)

    if logger.handlers:
        return logger

    formatter = logging.Formatter("%(levelname)s: %(message)s")

    stdout_handler = _SysStreamHandler("stdout")
    stdout_handler.setLevel(logging.DEBUG if debug else logging.INFO)
    stdout_handler.addFilter(_BelowLevelFilter(logging.WARNING))
    stdout_handler.setFormatter(formatter)

    stderr_handler = _SysStreamHandler("stderr")
    stderr_handler.setLevel(logging.WARNING)
    stderr_handler.setFormatter(formatter)

    logger.addHandler(stdout_handler)
    logger.addHandler(stderr_handler)

    return logger


logger = setup_logger()


def set_log_level(level: int) -> None:
    """Log from ``level`` up: DEBUG, INFO (the default) or WARNING (--quiet)."""
    logger.setLevel(level)
    for handler in logger.handlers:
        if handler.level < logging.WARNING:
            handler.setLevel(min(level, logging.INFO))


def set_info_stream(stream_name: str) -> None:
    """Write DEBUG and INFO records to ``stream_name``, stdout or stderr.

    ``--list`` prints its table to stdout and moves them to stderr, so a
    pipe or a file gets the table alone.
    """
    for handler in logger.handlers:
        if isinstance(handler, _SysStreamHandler) and handler.level < logging.WARNING:
            handler.stream_name = stream_name


def set_debug_mode(enabled: bool) -> None:
    """Enable or disable debug logging globally."""
    set_log_level(logging.DEBUG if enabled else logging.INFO)
