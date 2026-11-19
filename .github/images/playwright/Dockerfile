# The image the e2e, visual and pyodide jobs of .github/workflows/test.yml
# run the browsers in, and the one the commands of CONTRIBUTING.md and
# doc/development/testing.md run: they all read the reference from the FROM
# line below, and nothing builds this file. The tag has to match the
# @playwright/test version package-lock.json pins, and the digest has to be
# the one of that tag's multi-arch index: scripts/check_pins.py fails the
# lint job until both do, and `python scripts/check_pins.py --fix` writes
# them. Dependabot leaves this file alone (see dependabot.yml).
FROM mcr.microsoft.com/playwright:v1.65.1-noble@sha256:1507cbfc550a63a6b7396791ca4f00df17beb56342d2447b3f106c306f525579
