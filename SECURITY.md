# Security Policy

## Supported versions

Security fixes target the default branch and the most recent version tag. Older tags are not maintained
unless explicitly documented in a release.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability
reporting or Security Advisories for this repository. Include the affected version or commit, a concise
description, reproducible steps, and the potential impact. Do not include real user data or credentials.

If private reporting is unavailable, contact the repository maintainer through GitHub before disclosing the
issue publicly.

## Automation API and CSRF

Routes under `/api/v1` authenticate only through an `Authorization: Bearer` header carrying an API key and
ignore the session cookie. A browser never attaches that header on its own, so a foreign page cannot borrow
an ambient credential there; it would need the key itself, and a CSRF token would protect nothing. In turn, no
other route and no realtime connection reads that header, so a key never reaches the cookie-protected
surface.

## Disclosure

Reports are reviewed before a fix, mitigation, or disclosure date is agreed. Security fixes should be
released through the normal CI and version-tag process; production VPS deployment remains an explicit
operator action.
