"""Testes do serviço de IA:  python -m pytest -q"""
from fastapi.testclient import TestClient

from main import app
from reviewer import introduces_new_facts, review

client = TestClient(app)


def rev(text, anchors=None):
    return review([{"id": "b1", "title": "Abertura", "text": text}], anchors or [])


def test_health():
    assert client.get("/health").json() == {"ok": True}


def test_contrato_do_endpoint():
    r = client.post("/review", json={"scriptId": "r1", "blocks": [{"id": "b1", "title": "A", "text": "Houveram registros em 12 bairros."}], "anchors": []})
    assert r.status_code == 200
    s = r.json()["suggestions"][0]
    assert s == {"blockId": "b1", "original": "Houveram", "suggestion": "Houve", "category": "Gramática", "confidence": "alta", "message": s["message"]}


def test_gramatica():
    sugs = {s["original"]: s["suggestion"] for s in rev("Fazem 3 anos que a obra parou. Concerteza vai ter menas vagas.")}
    assert sugs["Fazem 3 anos"] == "Faz 3 anos"
    assert sugs["Concerteza"] == "Com certeza"
    assert sugs["menas"] == "menos"


def test_palavra_repetida_e_espacos():
    sugs = rev("O  prefeito disse que que vai vai investir .")
    cats = [s["category"] for s in sugs]
    assert cats.count("Repetição") >= 2
    assert "Pontuação" in cats


def test_frase_longa_sugere_divisao():
    longa = ("O governo anunciou hoje um novo pacote de investimentos para as cidades do interior do estado, "
             "e prefeitos de várias regiões comemoraram a notícia durante a reunião que aconteceu na capital nesta tarde de muito calor.")
    s = [x for x in rev(longa) if x["category"] == "Leitura oral"][0]
    assert s["suggestion"].startswith(". ")


def test_sigla_e_numero_longo_so_alertam():
    sugs = rev("O IBGE contou 1.234.567 pessoas. O IBGE confirmou.")
    alertas = [s for s in sugs if s["category"] == "Termo difícil"]
    assert len(alertas) == 2
    assert all(s["suggestion"] is None for s in alertas)


def test_nao_sugere_fato_novo():
    assert introduces_new_facts("O pacote prevê recursos.", "recursos", "R$ 5 bilhões")
    assert not introduces_new_facts("Houveram 12 casos.", "Houveram", "Houve")


def test_ignora_marcacoes_tecnicas():
    assert rev("[CÂMERA 2] Boa noite. [PAUSA] Tudo certo.") == []
