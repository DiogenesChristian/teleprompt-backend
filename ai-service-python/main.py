"""Globo Flow — serviço de IA (Python + FastAPI).

Chamado SOMENTE pelo backend Node.js (o frontend nunca fala direto com a IA):
    Frontend → Backend Node.js (POST /api/ai/review) → este serviço (POST /review)

Rodar:  uvicorn main:app --port 8000
"""
from __future__ import annotations

from typing import Literal, Optional

from fastapi import FastAPI
from pydantic import BaseModel, Field

from reviewer import review

app = FastAPI(title="Globo Flow — serviço de IA", version="1.0.0")


class Block(BaseModel):
    id: str
    title: str = ""
    text: str = ""


class Anchor(BaseModel):
    id: str
    blockId: str
    text: str = ""
    label: str = ""
    type: str = "obrigatoria"
    priority: str = "essencial"


class ReviewRequest(BaseModel):
    scriptId: Optional[str] = None
    blocks: list[Block] = Field(default_factory=list)
    anchors: list[Anchor] = Field(default_factory=list)


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
