.DEFAULT_GOAL := help

.PHONY: help install extension-build extension-source extension-test

help: ## Show available commands
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z_-]+:.*## / {printf "  %-20s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install development dependencies (Node.js 22+)
	npm ci

extension-build: ## Build dist/extension/ and ZIP (optional: platform_url=https://your-host)
	python3 scripts/build_extension.py $(if $(platform_url),--platform-url "$(platform_url)")
	@echo "Chrome Load unpacked folder: $(CURDIR)/dist/extension"

extension-source: ## Build the standalone source archive and runtime package
	python3 scripts/build_extension.py --source $(if $(platform_url),--platform-url "$(platform_url)")

extension-test: ## Run extension tests, bridge typecheck and packaging checks (make install first)
	npm run check
