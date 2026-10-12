"""Tests for logger module."""

import io
import logging
import sys

import pytest

from flown.logger import logger, set_debug_mode, set_log_level, setup_logger


@pytest.fixture(autouse=True)
def _restore_level():
    yield
    set_debug_mode(False)


class TestSetupLogger:
    def test_default_logger(self):
        test_logger = setup_logger("test_logger_default")
        assert test_logger.level == logging.INFO
        assert len(test_logger.handlers) == 2

    def test_stdout_and_stderr_handlers(self):
        test_logger = setup_logger("test_logger_streams")
        stdout_handler, stderr_handler = test_logger.handlers
        assert isinstance(stdout_handler, logging.StreamHandler)
        assert isinstance(stderr_handler, logging.StreamHandler)
        assert stdout_handler.stream is sys.stdout
        assert stdout_handler.level == logging.INFO
        assert stderr_handler.stream is sys.stderr
        assert stderr_handler.level == logging.WARNING

    def test_logger_with_debug(self):
        test_logger = setup_logger("test_logger_debug", debug=True)
        assert test_logger.level == logging.DEBUG
        assert test_logger.handlers[0].level == logging.DEBUG
        assert test_logger.handlers[1].level == logging.WARNING

    def test_logger_with_custom_level(self):
        assert (
            setup_logger("test_logger_custom", level=logging.WARNING).level
            == logging.WARNING
        )

    def test_logger_avoids_duplicate_handlers(self):
        test_logger = setup_logger("test_logger_duplicate")
        handler_count = len(test_logger.handlers)
        assert len(setup_logger("test_logger_duplicate").handlers) == handler_count

    def test_logger_handler_format(self):
        handler = setup_logger("test_logger_format").handlers[0]
        assert handler.formatter is not None
        assert handler.formatter._fmt == "%(levelname)s: %(message)s"

    def test_debug_overrides_level(self):
        test_logger = setup_logger(
            "test_logger_override", level=logging.WARNING, debug=True
        )
        assert test_logger.level == logging.DEBUG


class TestOutputStreams:
    def test_info_goes_to_stdout_only(self, capsys):
        logger.info("hello info")
        captured = capsys.readouterr()
        assert "INFO: hello info" in captured.out
        assert "hello info" not in captured.err

    def test_warning_and_error_go_to_stderr_only(self, capsys):
        logger.warning("hello warning")
        logger.error("hello error")
        captured = capsys.readouterr()
        assert "WARNING: hello warning" in captured.err
        assert "ERROR: hello error" in captured.err
        assert "hello" not in captured.out

    def test_debug_hidden_unless_enabled(self, capsys):
        logger.debug("hidden")
        assert "hidden" not in capsys.readouterr().out
        set_debug_mode(True)
        logger.debug("visible")
        assert "DEBUG: visible" in capsys.readouterr().out


class TestGlobalLogger:
    def test_global_logger_name(self):
        assert isinstance(logger, logging.Logger)
        assert logger.name == "flown"


class TestSetDebugMode:
    def test_enable_debug_mode_only_touches_stdout_handler(self):
        set_debug_mode(True)
        assert logger.level == logging.DEBUG
        assert logger.handlers[0].level == logging.DEBUG
        assert logger.handlers[1].level == logging.WARNING

    def test_disable_debug_mode(self):
        set_debug_mode(True)
        set_debug_mode(False)
        assert logger.level == logging.INFO
        assert logger.handlers[0].level == logging.INFO
        assert logger.handlers[1].level == logging.WARNING


class TestSetLogLevel:
    def test_quiet_hides_the_info_lines(self, capsys):
        set_log_level(logging.WARNING)
        logger.info("progress")
        logger.warning("problem")
        captured = capsys.readouterr()
        assert captured.out == ""
        assert captured.err == "WARNING: problem\n"
        # The stdout handler stays ready for INFO once the level is back
        assert logger.handlers[0].level == logging.INFO


class TestSymbols:
    def test_ascii_where_the_stream_is_no_terminal(self, capsys):
        logger.info("✓ Loaded 3 points; ⚠ no model; ✗ failed")
        assert capsys.readouterr().out == (
            "INFO: [ok] Loaded 3 points; [!] no model; [x] failed\n"
        )

    def test_as_they_are_on_a_terminal(self, monkeypatch):
        stream = io.StringIO()
        monkeypatch.setattr(stream, "isatty", lambda: True, raising=False)
        monkeypatch.setattr(sys, "stdout", stream)
        logger.info("✓ Loaded")
        assert stream.getvalue() == "INFO: ✓ Loaded\n"

    def test_a_stream_without_isatty_counts_as_none(self, monkeypatch):
        class Plain:
            def __init__(self):
                self.text = ""

            def write(self, text):
                self.text += text

            def flush(self):
                pass

        stream = Plain()
        monkeypatch.setattr(sys, "stdout", stream)
        logger.info("✓ Loaded")
        assert stream.text == "INFO: [ok] Loaded\n"
