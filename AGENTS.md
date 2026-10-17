# Contributor guide for coding agents

Check `git status --short` before editing and preserve existing work. Read the implementation and nearby tests before changing behavior.

Runtime code is in `extension/src/`; tests are in `extension/test/`. Keep the JavaScript and TypeScript bridge clients consistent. Generate the OpenAPI subset using `scripts/extension_openapi.py` from a trusted platform spec.

Run `npm run check` and `npm run build` for relevant changes. Browser integration coverage lives in the platform repository; do not describe unit checks as browser validation.

Preserve human submission, confirmation evidence, per-account isolation, and background-only credential access. Never commit credentials, local settings, real application data, resumes or private repository history. Do not introduce LinkedIn automation or Google scraping.
