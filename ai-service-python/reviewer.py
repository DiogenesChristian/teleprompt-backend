"""Globo Flow — revisor de roteiro para leitura em voz alta (US03, US04).

Aponta erros gramaticais comuns, repetições, problemas de pontuação, frases
longas demais para ler em voz alta, siglas, números longos e parênteses.

Regras editoriais (documentação, seção 3.2):
  - o serviço só SUGERE; quem aplica é o editor (US05);
  - nunca sugere texto com número, data ou nome novo (o frontend e este
    serviço bloqueiam isso);
  - números, datas e nomes nunca são reescritos, só sinalizados.
"""
from __future__ import annotations

import re
from typing import Iterable

L = "A-Za-zÀ-ÖØ-öø-ÿ"
UP = "A-ZÀ-ÖØ-Þ"
CUE_RE = re.compile(r"\[(PAUSA|ÊNFASE|ENFASE|CÂMERA \d|CAMERA \d|VINHETA|ENTRA VT|SOBE SOM|CORTA)\]", re.I)

STOP = set((
    "a o e é as os um uma uns umas de do da dos das no na nos nas em ao aos à às por para com sem que se "
    "mais mas como foi ser são está estão isso esse essa este esta aquele aquela também já não sim seu sua seus suas "
    "ele ela eles elas nós você vocês muito pouco onde quando qual quais entre sobre até desde após antes depois "
    "pelo pela pelos pelas cada todo toda todos todas outro outra outros outras mesmo mesma ainda apenas hoje boa noite "
    "bom dia tarde gente nossa nosso porque pode deve vai vão foram tem têm teve aqui ali então"
).split())
MONTHS = "janeiro fevereiro março abril maio junho julho agosto setembro outubro novembro dezembro".split()
SIGLA_IGNORE = {"BR", "VT", "TV", "OK", "II", "III", "IV", "VI", "VII", "VIII", "IX", "XI", "XX", "XXI", "R"}
MAX_WORDS = 28


def _keep_case(model: str, repl: str) -> str:
    return repl[:1].upper() + repl[1:] if model[:1].isupper() else repl


GRAMMAR = [
    (re.compile(r"\b[Hh]ouveram\b"), lambda m: _keep_case(m.group(0), "houve"), "alta",
     "“Haver” no sentido de existir não vai para o plural: use “houve”."),
    (re.compile(r"\b[Aa] nível de\b"), lambda m: _keep_case(m.group(0), "em termos de"), "media",
     "“A nível de” é considerado inadequado. Prefira “em termos de” ou reformule."),
    (re.compile(r"\b([Ff])azem (\d+|dois|duas|três|quatro|cinco|seis|sete|oito|nove|dez) (anos|meses|dias|semanas|horas)\b"),
     lambda m: f"{m.group(1)}az {m.group(2)} {m.group(3)}", "alta",
     "“Fazer” indicando tempo decorrido é impessoal: use “faz”."),
    (re.compile(r"\bmenas\b"), lambda m: "menos", "alta", "“Menas” não existe na norma padrão: use “menos”."),
    (re.compile(r"\b[Ss]eje\b"), lambda m: _keep_case(m.group(0), "seja"), "alta", "Forma correta: “seja”."),
    (re.compile(r"\b[Ee]steje\b"), lambda m: _keep_case(m.group(0), "esteja"), "alta", "Forma correta: “esteja”."),
    (re.compile(r"\b[Cc]oncerteza\b"), lambda m: _keep_case(m.group(0), "com certeza"), "alta", "Escreve-se separado: “com certeza”."),
    (re.compile(r"\b[Dd]errepente\b"), lambda m: _keep_case(m.group(0), "de repente"), "alta", "Escreve-se separado: “de repente”."),
    (re.compile(r"\b[Pp]orisso\b"), lambda m: _keep_case(m.group(0), "por isso"), "alta", "Escreve-se separado: “por isso”."),
    (re.compile(r"\b[Aa]fim de\b"), lambda m: _keep_case(m.group(0), "a fim de"), "media",
     "Com sentido de finalidade, escreve-se “a fim de”."),
    (re.compile(r"\bmais melhor\b"), lambda m: "melhor", "alta", "“Melhor” já é comparativo."),
    (re.compile(r"\bentre eu e\b"), lambda m: "entre mim e", "alta", "Depois de preposição, use “mim”."),
]


def _strip_cues(t: str) -> str:
    return CUE_RE.sub(" ", t or "")


def _words(t: str) -> list[str]:
    return re.findall(f"[{L}0-9][{L}0-9-]*", _strip_cues(t))


def _cue_ranges(text: str) -> list[tuple[int, int]]:
    return [(m.start(), m.end()) for m in CUE_RE.finditer(text)]


def _in_ranges(i: int, ranges: Iterable[tuple[int, int]]) -> bool:
    return any(a <= i < b for a, b in ranges)


# ---------------- trava editorial ----------------
def protected_tokens(text: str) -> list[str]:
    """Números, valores, meses, siglas e nomes próprios do texto."""
    t = _strip_cues(text)
    out = [re.sub(r"\s+", " ", m.group(0)).strip() for m in re.finditer(
        r"(R\$\s?)?\d[\d.,]*(\s?%|\s(mil|milhão|milhões|bilhão|bilhões|trilhão|trilhões))?", t)]
    for m in re.finditer(f"[{L}][{L}-]*", t):
        w, lw = m.group(0), m.group(0).lower()
        if lw in MONTHS:
            out.append(lw)
        elif re.fullmatch(f"[{UP}]{{2,}}", w) and len(w) <= 8:
            out.append(w)
        elif re.match(f"[{UP}]", w) and lw not in STOP:
            before = t[: m.start()].rstrip()
            if before and not re.search(r"[.!?:\"“]$", before):
                out.append(w)
    return out


def introduces_new_facts(block_text: str, original: str, suggestion: str) -> bool:
    i = block_text.find(original)
    if i < 0:
        return True
    after = block_text[:i] + suggestion + block_text[i + len(original):]
    a, b = protected_tokens(block_text), protected_tokens(after)
    return any(b.count(k) > a.count(k) for k in set(b))


# ---------------- análise ----------------
def analyze_block(block: dict, anchors: list[dict], seen_siglas: set[str]) -> list[dict]:
    text = block.get("text") or ""
    cues = _cue_ranges(text)
    anchor_text = " ".join(a.get("text", "") for a in anchors).lower()
    out: list[dict] = []

    def push(index: int, category: str, confidence: str, message: str, original: str, suggestion: str | None):
        if _in_ranges(index, cues):
            return
        if suggestion is not None and introduces_new_facts(text, original, suggestion):
            return  # a IA nunca insere fato novo
        out.append({"blockId": block.get("id"), "original": original, "suggestion": suggestion,
                    "category": category, "confidence": confidence, "message": message, "index": index})

    for rx, fix, conf, msg in GRAMMAR:
        for m in rx.finditer(text):
            push(m.start(), "Gramática", conf, msg, m.group(0), fix(m))

    for m in re.finditer(f"(^|[^{L}])([{L}]+)\\s+\\2(?![{L}])", text, re.I):
        start = m.start(2)
        push(start, "Repetição", "alta", "Palavra repetida em sequência.", text[start:m.end()], m.group(2))

    for m in re.finditer(r"([^\s]) {2,}([^\s])", text):
        push(m.start(), "Pontuação", "alta", "Espaço duplo entre palavras.", m.group(0), f"{m.group(1)} {m.group(2)}")
    for m in re.finditer(r"([^\s]) +([,.;:!?])", text):
        push(m.start(), "Pontuação", "alta", "Espaço antes da pontuação.", m.group(0), m.group(1) + m.group(2))

    # Frases longas para leitura em voz alta (US04)
    for m in re.finditer(r"[^.!?]+[.!?]+", text):
        sentence = m.group(0)
        n = len(_words(sentence))
        if n <= MAX_WORDS:
            continue
        mid = len(sentence) / 2
        splits = list(re.finditer(r", (e|mas) ([a-zà-ÿ]+)", sentence))
        if splits:
            best = min(splits, key=lambda s: abs(s.start() - mid))
            nxt = best.group(2)
            conj = "Mas " + nxt if best.group(1) == "mas" else nxt[:1].upper() + nxt[1:]
            push(m.start() + best.start(), "Leitura oral", "media",
                 f"Frase com {n} palavras é difícil de ler em voz alta. Sugestão: dividir em duas.",
                 best.group(0), ". " + conj)
        else:
            s = sentence.strip()
            push(m.start(), "Leitura oral", "media",
                 f"Frase com {n} palavras. Considere dividir para facilitar a leitura em voz alta.",
                 s[:80] + ("…" if len(s) > 80 else ""), None)

    # Repetição da mesma palavra em trecho curto
    tokens = [(m.group(0), m.start()) for m in re.finditer(f"[{L}][{L}-]*", text)]
    seen: set[str] = set()
    for i, (w, idx) in enumerate(tokens):
        lw = w.lower()
        if len(lw) < 5 or lw in STOP or lw in seen or _in_ranges(idx, cues):
            continue
        for j in range(i + 1, min(len(tokens), i + 26)):
            if tokens[j][0].lower() == lw:
                seen.add(lw)
                proper = bool(re.match(f"[{UP}]", tokens[j][0]))
                protected = proper or lw in anchor_text
                push(tokens[j][1], "Repetição", "baixa" if protected else "media",
                     f"“{tokens[j][0]}” aparece duas vezes em sequência curta. "
                     + ("Como é nome ou informação protegida, mantenha se for importante para a clareza."
                        if protected else "Considere um sinônimo ou um pronome."),
                     tokens[j][0], None)
                break

    # Siglas, números longos e parênteses
    for m in re.finditer(f"(?<![{L}])[{UP}]{{2,6}}(?![{L}])", text):
        s = m.group(0)
        if s in SIGLA_IGNORE or s in seen_siglas or text[m.end():m.end() + 1] == "-":
            continue
        seen_siglas.add(s)
        push(m.start(), "Termo difícil", "media",
             f"Sigla “{s}”: confira como deve ser lida e, se o público não conhecer, diga o nome por extenso na primeira menção.",
             s, None)
    for m in re.finditer(r"\d{1,3}(\.\d{3}){2,}", text):
        push(m.start(), "Termo difícil", "media",
             "Número longo é difícil de ler em voz alta. Números são protegidos: se quiser simplificar a forma, edite manualmente.",
             m.group(0), None)
    for m in re.finditer(r"\([^)]{1,80}\)", text):
        push(m.start(), "Leitura oral", "baixa",
             "Parênteses não são percebidos na fala. Avalie transformar em frase ou retirar.", m.group(0), None)

    out.sort(key=lambda s: s["index"])
    for s in out:
        s.pop("index")
    return out


def review(blocks: list[dict], anchors: list[dict]) -> list[dict]:
    seen_siglas: set[str] = set()
    result: list[dict] = []
    for b in blocks:
        result.extend(analyze_block(b, [a for a in anchors if a.get("blockId") == b.get("id")], seen_siglas))
    return result
