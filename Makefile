# annolab: backend targets here; web targets are grouped further down.

HOST     ?= 127.0.0.1
API_PORT ?= 8000
UV       ?= uv
RUN      := cd backend && $(UV) run

.PHONY: help install seed dev test openapi eval-prelabel \
        backend-install backend-dev backend-test backend-smoke clean-data \
        web-install web-dev web-test web-typecheck web-e2e screenshots

help:
	@echo "install        install backend (and web, if present) dependencies"
	@echo "seed           wipe data/ and generate the demo database and media"
	@echo "dev            run the API on $(HOST):$(API_PORT) (and Vite, if web/ exists)"
	@echo "test           backend pytest, web vitest, tsc and Playwright e2e"
	@echo "openapi        regenerate backend/openapi.json"
	@echo "eval-prelabel  precision/recall of pre-labels on the seeded data"
	@echo "screenshots    Playwright screenshots into docs/images (web)"

# ---------------------------------------------------------------- backend

backend-install:
	cd backend && $(UV) sync

seed: backend-install
	$(RUN) python -m annolab.seed

backend-dev:
	$(RUN) uvicorn annolab.main:create_app --factory --host $(HOST) --port $(API_PORT) --reload

backend-test:
	$(RUN) pytest

backend-smoke:
	./scripts/smoke.sh $(API_PORT)

openapi:
	$(RUN) python ../scripts/openapi.py

eval-prelabel:
	$(RUN) python ../scripts/eval_prelabel.py

clean-data:
	rm -rf data/annolab.db data/annolab.db-wal data/annolab.db-shm data/media

# ---------------------------------------------------------------- web

HAS_WEB := $(wildcard web/package.json)

web-install:
	cd web && npm install

web-dev:
	cd web && npm run dev

web-typecheck:
	cd web && npm run typecheck

web-test:
	cd web && npm test

# e2e and screenshots seed a throwaway data dir and start their own API and Vite on free ports,
# so they never touch data/ or a running `make dev`.
web-e2e:
	./scripts/with-stack.sh "cd web && npx playwright test --grep-invert screenshots"

screenshots:
	./scripts/with-stack.sh "cd web && npx playwright test --grep screenshots"
	$(RUN) python ../scripts/shrink_png.py ../docs/images

# ---------------------------------------------------------------- combined

install: backend-install $(if $(HAS_WEB),web-install)

test: backend-test $(if $(HAS_WEB),web-test web-typecheck web-e2e)

dev:
ifneq ($(HAS_WEB),)
	@trap 'kill 0' INT TERM; \
	$(MAKE) --no-print-directory backend-dev & \
	$(MAKE) --no-print-directory web-dev & \
	wait
else
	$(MAKE) --no-print-directory backend-dev
endif
