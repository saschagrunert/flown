# The image the secrets job of .github/workflows/test.yml scans the commits
# with, which reads the reference from the FROM line below; nothing builds
# this file. It is the release of the gitleaks hook of
# .pre-commit-config.yaml: Dependabot bumps the two in the same pull request
# (see dependabot.yml), scripts/check_pins.py fails the lint job when they
# drift apart, and `python scripts/check_pins.py --fix` writes the tag of the
# hook's release with its digest.
FROM ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f
