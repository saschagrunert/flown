"""Tests for the lazily resolved package exports."""

import ast
from pathlib import Path

import pytest

import flown


class TestLazyExports:
    def test_every_export_resolves(self):
        for name in flown.__all__:
            assert getattr(flown, name) is not None

    def test_all_lists_exactly_the_lazy_names_and_the_version(self):
        assert set(flown.__all__) == {"__version__", *flown._LAZY_EXPORTS}
        assert flown.__all__[0] == "__version__"
        assert flown.__all__[1:] == sorted(flown.__all__[1:])

    def test_pipeline_entry_points_are_exported(self):
        from flown.obfuscate import check_kml_obfuscated, obfuscate_kml_files
        from flown.renderer import create_progressive_heatmap

        assert flown.create_progressive_heatmap is create_progressive_heatmap
        assert flown.obfuscate_kml_files is obfuscate_kml_files
        assert flown.check_kml_obfuscated is check_kml_obfuscated

    def test_the_type_checker_sees_every_lazy_export(self):
        """The imports under TYPE_CHECKING name what __getattr__ resolves."""
        tree = ast.parse(Path(flown.__file__).read_text(encoding="utf-8"))
        block = next(
            node
            for node in tree.body
            if isinstance(node, ast.If)
            and isinstance(node.test, ast.Name)
            and node.test.id == "TYPE_CHECKING"
        )
        imported = {
            alias.name: "." + (node.module or "")
            for node in block.body
            if isinstance(node, ast.ImportFrom)
            for alias in node.names
            # Only an alias of the same name re-exports it
            if alias.asname == alias.name
        }
        assert imported == flown._LAZY_EXPORTS

    def test_renderer_internals_are_not_exported(self):
        assert "minify_html" not in flown.__all__
        assert "load_template" not in flown.__all__

    def test_unknown_attribute_raises(self):
        with pytest.raises(AttributeError, match="has no attribute 'nope'"):
            flown.nope  # noqa: B018

    def test_version(self):
        assert flown.__version__ == "1.0.0"
