"""
Flown

Turns KML flight logs into a static site of where you have flown.

The modules are imported by name (``flown.cli``, ``flown.renderer`` and so
on); the package itself imports none of them, so ``python -m flown --help``
and ``--version`` start without loading lxml or numpy.
"""

__version__ = "1.0.0"
