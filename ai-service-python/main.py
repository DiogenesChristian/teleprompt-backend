"""Globo Flow — serviço de revisão textual por regras (Python + FastAPI).

Este serviço não usa IA generativa: aplica padrões, expressões regulares e
regras locais de gramática e leitura em voz alta.

Chamado SOMENTE pelo backend Node.js (o frontend nunca fala direto com este serviço):
    Frontend → Backend Node.js (POST /api/ai/review) → este serviço (POST /review)

Rodar:  uvicorn main:app --port 8000
"""
from __future__ import annotations

from typing import Literal, Optional

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator, model_validator

from reviewer import review

app = FastAPI(title="Globo Flow — revisão textual por regras", version="1.0.0")


class Block(BaseModel):
    id: str
    title: str = ""
    text: str

    @field_validator("id", "text")
    @classmethod
    def nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Campo vazio")
        return value


class Anchor(BaseModel):
    id: str
    blockId: str
    text: str = ""
    label: str = ""
    type: str = "obrigatoria"
    priority: str = "essencial"


class ReviewRequest(BaseModel):
    scriptId: Optional[str] = None
    blocks: list[Block] = Field(min_length=1)
    anchors: list[Anchor] = Field(default_factory=list)


    @model_validator(mode="after")
    def validate_links(self):
        ids = {b.id for b in self.blocks}
        if len(ids) != len(self.blocks):
            raise ValueError("Identificadores de blocos duplicados")
        if any(not a.id.strip() or a.blockId not in ids for a in self.anchors) or len({a.id for a in self.anchors}) != len(self.anchors):
            raise ValueError("Âncora inválida ou duplicada")
        return self


@app.exception_handler(RequestValidationError)
async def invalid_request(request: Request, exc: RequestValidationError):
    return JSONResponse(status_code=422, content={"error": "Dados de revisão inválidos. Verifique os blocos e as âncoras."})


class Suggestion(BaseModel):
    blockId: str
    original: str
    suggestion: Optional[str]
    category: str
    confidence: Literal["alta", "media", "baixa"]
    message: str


class ReviewResponse(BaseModel):
    suggestions: list[Suggestion]


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/review", response_model=ReviewResponse)
def post_review(req: ReviewRequest) -> ReviewResponse:
    blocks = [b.model_dump() for b in req.blocks]
    anchors = [a.model_dump() for a in req.anchors]
    return ReviewResponse(suggestions=review(blocks, anchors))
