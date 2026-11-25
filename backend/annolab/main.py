"""FastAPI application factory."""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from . import schemas as S
from .config import Settings, get_settings
from .db import Database
from .routers import auth, exports, items, projects, workflow

VERSION = "0.1.0"


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    app = FastAPI(title="annolab", version=VERSION, docs_url="/api/docs", openapi_url="/api/openapi.json")
    app.state.settings = settings
    app.state.db = Database(settings.db_path)
    app.state.db.create_all()

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError):
        errs = exc.errors()
        first = errs[0] if errs else {}
        where = ".".join(str(p) for p in first.get("loc", []) if p != "body")
        detail = f"{where}: {first.get('msg', 'invalid request')}" if where else first.get("msg", "invalid request")
        return JSONResponse(status_code=422, content={"detail": detail, "errors": jsonable(errs)})

    @app.get("/api/health", response_model=S.Health, tags=["meta"])
    def health():
        return S.Health(status="ok", version=VERSION)

    for r in (auth.router, projects.router, items.router, workflow.router, exports.router):
        app.include_router(r, prefix="/api")
    return app


def jsonable(errs):
    from fastapi.encoders import jsonable_encoder

    return jsonable_encoder(errs, custom_encoder={Exception: str})

