"""오류 본문은 OPMS 와 같은 {"error": {"code", "message", "details"}} 모양이다."""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from onto_pdm.contracts import ApiError, ErrorBody

ERROR_RESPONSES: dict[int | str, dict[str, Any]] = {status: {"model": ApiError} for status in (400, 403, 404, 409, 422)}


class ApiException(Exception):
    def __init__(self, status: int, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.body = ApiError(error=ErrorBody(code=code, message=message, details=details))


# 자주 쓰는 오류 (웹 목 API 의 ApiError(message, status)와 같은 상황)
def not_found(code: str, message: str) -> ApiException:
    return ApiException(404, code, message)


def forbidden(code: str, message: str) -> ApiException:
    return ApiException(403, code, message)


def conflict(code: str, message: str) -> ApiException:
    return ApiException(409, code, message)


def bad_request(code: str, message: str) -> ApiException:
    return ApiException(400, code, message)


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiException)
    async def _api(_: Request, exc: ApiException) -> JSONResponse:
        return JSONResponse(exc.body.model_dump(mode="json"), status_code=exc.status)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        body = ApiError(error=ErrorBody(
            code="INVALID_REQUEST", message="요청 형식이 계약과 맞지 않습니다",
            details={"errors": [{"loc": [str(x) for x in e["loc"]], "msg": e["msg"]} for e in exc.errors()]},
        ))
        return JSONResponse(body.model_dump(mode="json"), status_code=422)
