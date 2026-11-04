"""Globo Flow — revisor de roteiro para leitura em voz alta (US03, US04).

Aponta erros gramaticais comuns (concordância, crase, vírgula), repetições,
problemas de pontuação, frases longas demais para ler em voz alta, palavras
difíceis de falar no ar, e escreve números e siglas como se falam.

Regras editoriais (documentação, seção 3.2):
  - o serviço só SUGERE; quem aplica é o editor (US05);
  - nunca sugere texto com número, data ou nome novo (o frontend e este
    serviço bloqueiam isso);
  - números, datas e nomes nunca mudam de VALOR. Quando a leitura em voz alta
    pede, o revisor escreve o MESMO valor por extenso ("R$ 12 bi" → "doze
    bilhões de reais"); fora isso, só sinaliza.
"""
from __future__ import annotations

import re
from decimal import Decimal
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
# Abreviações de tratamento: o ponto delas NÃO encerra frase (o nome que vem depois continua sendo nome).
ABREV_RE = re.compile(r"\b(?:Sr|Sra|Dr|Dra|Prof|Profa)\.$")


def _keep_case(model: str, repl: str) -> str:
    return repl[:1].upper() + repl[1:] if model[:1].isupper() else repl


# ---------------- gramática: regras antigas ----------------
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

# ---------------- gramática: concordância ----------------
# Quantidades no plural (o "1" sozinho fica de fora de propósito: "existe 1 caso" está certo).
_QUANT = (r"(?:muit[oa]s|vári[oa]s|poucos|poucas|dois|duas|três|quatro|cinco|seis|sete|oito|nove|dez|"
          r"centenas|milhares|1\d+|[2-9]\d*)")
_HAVER_SING = {"devem": "deve", "podem": "pode", "vão": "vai", "iam": "ia", "deviam": "devia", "podiam": "podia"}
_ACENTO_PL = {"tem": "têm", "vem": "vêm", "mantem": "mantêm", "contem": "contêm"}

CONCORDANCIA = [
    (re.compile(r"\b(devem|podem|vão|iam|deviam|podiam) haver\b", re.I),
     lambda m: _keep_case(m.group(0), _HAVER_SING[m.group(1).lower()] + " haver"), "alta",
     "“Haver” no sentido de existir é impessoal: o verbo que vem antes dele fica no singular (“deve haver”, “pode haver”)."),
    (re.compile(r"\b([Hh])aviam(?= " + _QUANT + r"\b)"),
     lambda m: f"{m.group(1)}avia", "media",
     "“Haver” no sentido de existir não vai para o plural: use “havia”."),
    (re.compile(r"\b([Ee])xiste(?= " + _QUANT + r"\b)"),
     lambda m: f"{m.group(1)}xistem", "alta",
     "O verbo concorda com o que existe: com quantidade no plural, use “existem”."),
    (re.compile(r"\b([Ff])alta(?= " + _QUANT + r" (?:dias|horas|minutos|segundos|semanas|meses|anos|pessoas|votos|vagas|jogos|rodadas|casos)\b)"),
     lambda m: f"{m.group(1)}altam", "alta",
     "O verbo concorda com o que falta: com quantidade no plural, use “faltam”."),
    (re.compile(r"\b(eles|elas) (tem|vem|mantem|contem)\b", re.I),
     lambda m: f"{m.group(1)} {_ACENTO_PL[m.group(2).lower()]}", "alta",
     "Com sujeito no plural, a forma tem acento circunflexo: “têm”, “vêm”."),
    (re.compile(r"\b((?:[Oo]s|[Aa]s) (?!vezes\b)[a-zà-ÿ]+s) (tem|vem)\b"),
     lambda m: f"{m.group(1)} {_ACENTO_PL[m.group(2)]}", "media",
     "Se o sujeito é plural, o verbo leva circunflexo: “têm”, “vêm”. Confira o sujeito."),
    (re.compile(r"\b([Pp])ara mim (fazer|ver|dizer|falar|ler|comprar|ir|ter|ser|estar|saber|entender|chegar|ajudar|tentar|explicar)\b"),
     lambda m: f"{m.group(1)}ara eu {m.group(2)}", "alta",
     "“Mim” não faz nada: quem pratica a ação é “eu”. Use “para eu” + verbo."),
    (re.compile(r"\b([Ss]e|[Qq]uando) (eu|ele|ela|você|a gente|ninguém) (ver|fazer|dizer|trazer)\b"),
     lambda m: f"{m.group(1)} {m.group(2)} " + {"ver": "vir", "fazer": "fizer", "dizer": "disser", "trazer": "trouxer"}[m.group(3)],
     "alta", "Depois de “se” e “quando”, com ideia de futuro, o verbo vai para o futuro do subjuntivo."),
    (re.compile(r"\b(Vende|Aluga|Compra|Precisa|Fala|Estima|Calcula|Registra)-se(?= (?:os|as|dois|duas|três|quatro|cinco|seis|sete|oito|nove|dez|"
                r"1\d+|[2-9]\d*|muitos|muitas|vários|várias|centenas|milhares)\b)", re.I),
     lambda m: f"{m.group(1)}m-se", "media",
     "Com “se” apassivador, o verbo concorda com o que vem depois: “vendem-se”, “estimam-se”."),
]

# ---------------- gramática: crase ----------------
_FEM = ("chuva|greve|falta|queda|alta|crise|seca|obra|doença|pandemia|situação|decisão|mudança|onda|tempestade|"
        "ausência|demora|ação|operação|investigação|pressão|inflação")
_MOVIMENTO = "vou|vai|vamos|vão|iremos|irá|irão|ir|chegou|chegaram|chegar|voltou|voltaram|voltar|retornou|retornaram|retornar"
_LUGARES = ("escola|cidade|prefeitura|feira|praia|igreja|capital|universidade|reunião|festa|delegacia|redação|sede|"
            "câmara|assembleia|fazenda|loja|farmácia|padaria|biblioteca|empresa")

# Depois destas palavras o "as" é só artigo ("até as 22h", "entre as 19h e as 21h"): não tem crase.
_SEM_CRASE_ANTES = {"até", "desde", "entre", "após", "sobre", "com", "por", "para", "de", "em", "sem", "sob",
                    "contra", "perante", "durante", "e", "ou"}


def _crase_hora(m: re.Match) -> str:
    anteriores = re.findall("[" + L + "]+", m.string[: m.start()])
    if anteriores and anteriores[-1].lower() in _SEM_CRASE_ANTES:
        return m.group(0)  # igual ao original: não vira sugestão
    return ("Às" if m.group(1) == "A" else "às") + f" {m.group(2)}"


CRASE = [
    (re.compile(r"\b(devido|graças|referente|relativo|junto|frente|em relação) as\b", re.I),
     lambda m: f"{m.group(1)} às", "alta",
     "Preposição “a” + artigo “as” pede crase: “às”."),
    (re.compile(r"\b(devido|graças|referente|relativo|em relação) a (" + _FEM + r")\b", re.I),
     lambda m: f"{m.group(1)} à {m.group(2)}", "alta",
     "Preposição “a” + artigo “a” diante de palavra feminina pede crase: “à”."),
    (re.compile(r"\b([Àà]) (partir|respeito|pé|domicílio|seguir)\b"),
     lambda m: ("A" if m.group(1) == "À" else "a") + f" {m.group(2)}", "alta",
     "Aqui não há crase: antes de palavra masculina ou de verbo, escreve-se apenas “a”."),
    (re.compile(r"\b(para|após|desde|sem|sob|sobre|contra|perante|durante|entre|com|por|de|em|ante) à\b", re.I),
     lambda m: f"{m.group(1)} a", "alta",
     "Não há crase depois de preposição: escreve-se apenas “a”."),
    (re.compile(r"\b(" + _MOVIMENTO + r") a (" + _LUGARES + r")\b(?! (?:que|quem|onde)\b)", re.I),
     lambda m: f"{m.group(1)} à {m.group(2)}", "media",
     "Verbo de movimento + lugar feminino pede crase: “à”."),
    (re.compile(r"(?<!todas )(?<!Todas )\b([Aa])s vezes\b(?! (?:que|em que)\b)"),
     lambda m: ("Às" if m.group(1) == "A" else "às") + " vezes", "media",
     "No sentido de “de vez em quando”, escreve-se “às vezes”, com crase."),
    (re.compile(r"\b([Aa])s (\d{1,2}(?:h\d{0,2}|:\d{2}| ?horas?))\b(?! (?:seguintes|anteriores|restantes|de|do|da|que|são|foram|serão)\b)"),
     lambda m: _crase_hora(m), "media",
     "Hora marcada pede crase: “às”."),
]

# ---------------- pontuação: vírgula ----------------
VIRGULA = [
    (re.compile("([" + L + "0-9]+) (mas)\\b(?! também)"),
     lambda m: f"{m.group(1)}, mas", "alta",
     "Coloque vírgula antes de “mas”."),
    (re.compile("([" + L + "0-9]+) (ou seja)\\b"),
     lambda m: f"{m.group(1)}, ou seja", "media",
     "Coloque vírgula antes de “ou seja”."),
    (re.compile("([" + L + "0-9]+) (porém|contudo|todavia|entretanto|no entanto)\\b"),
     lambda m: f"{m.group(1)}, {m.group(2)}", "baixa",
     "Costuma haver vírgula antes de “porém”, “contudo”, “todavia”, “entretanto” e “no entanto”. "
     "Se ele estiver no meio da oração, feche também com vírgula depois."),
    (re.compile("\\b(Bom dia|Boa tarde|Boa noite) ([" + UP + "][" + L + "]*)"),
     lambda m: f"{m.group(1)}, {m.group(2)}", "alta",
     "Vírgula para separar o cumprimento de quem está sendo chamado (vocativo)."),
]

# ---------------- palavras difíceis de falar no ar ----------------
# Só entram palavras que não mudam de forma (advérbios, conectivos) e cuja troca não pede outro ajuste na frase.
_TROCAS = [
    ("mormente", "principalmente"), ("outrossim", "além disso"), ("destarte", "assim"),
    ("porquanto", "pois"), ("conquanto", "embora"), ("hodiernamente", "hoje em dia"),
    ("concomitantemente", "ao mesmo tempo"), ("subsequentemente", "depois"), ("posteriormente", "depois"),
    ("anteriormente", "antes"), ("aproximadamente", "cerca de"), ("paulatinamente", "aos poucos"),
    ("precipuamente", "principalmente"), ("sobremaneira", "muito"), ("quiçá", "talvez"),
    ("alhures", "em outro lugar"), ("porventura", "por acaso"), ("acerca de", "sobre"),
]
_TITULOS = {"sr": "senhor", "sra": "senhora", "dr": "doutor", "dra": "doutora", "prof": "professor", "profa": "professora"}


def _titulo_falado(m: re.Match) -> str:
    """"Sr." → "senhor" (minúscula no meio da frase; maiúscula só se abrir a frase)."""
    falado = _TITULOS[m.group(1).lower()]
    antes = m.string[: m.start()].rstrip()
    return falado[:1].upper() + falado[1:] if not antes or antes[-1] in ".!?" else falado

VOCABULARIO = [
    (re.compile(r"\b" + re.escape(dificil) + r"\b(?! (?:a|ao|à|às|aos|com|de)\b)", re.I),
     (lambda troca: lambda m: _keep_case(m.group(0), troca))(troca), "media",
     f"“{dificil}” é difícil de falar ou soa distante no ar. Mais natural: “{troca}”.")
    for dificil, troca in _TROCAS
] + [
    (re.compile(r"(?<![" + L + r"])(Sr|Sra|Dr|Dra|Prof|Profa)\.(?= [" + UP + "])"),
     lambda m: _titulo_falado(m), "alta",
     "Abreviação não existe na fala: escreva como se lê."),
    (re.compile(r"\b[a-zà-ÿ]+-(?:me|te|se|lhe|nos|vos|lhes)-(?:ei|ás|á|emos|eis|ão|ia|ias|íamos|íeis|iam)\b", re.I),
     lambda m: None, "baixa",
     "Mesóclise é muito difícil de falar no ar. Reescreva a frase com outra forma do verbo."),
]

REGRAS_EXTRAS = [
    ("Gramática", CONCORDANCIA),
    ("Gramática", CRASE),
    ("Pontuação", VIRGULA),
    ("Termo difícil", VOCABULARIO),
]


# ---------------- números e siglas como se falam ----------------
_UNID = ["zero", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove", "dez", "onze", "doze",
         "treze", "catorze", "quinze", "dezesseis", "dezessete", "dezoito", "dezenove"]
_DEZ = ["", "", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa"]
_CENT = ["", "cento", "duzentos", "trezentos", "quatrocentos", "quinhentos", "seiscentos", "setecentos",
         "oitocentos", "novecentos"]
_ESCALAS = {1: ("mil", "mil"), 2: ("milhão", "milhões"), 3: ("bilhão", "bilhões"), 4: ("trilhão", "trilhões")}
_ESC_NOMES = {10**6: ("milhão", "milhões"), 10**9: ("bilhão", "bilhões"), 10**12: ("trilhão", "trilhões")}
_ESC_VALOR = {"mil": 10**3, "mi": 10**6, "milhão": 10**6, "milhões": 10**6, "bi": 10**9, "bilhão": 10**9,
              "bilhões": 10**9, "tri": 10**12, "trilhão": 10**12, "trilhões": 10**12}


def _ate_999(n: int) -> str:
    if n == 100:
        return "cem"
    c, r = divmod(n, 100)
    partes = []
    if c:
        partes.append(_CENT[c])
    if r:
        if r < 20:
            partes.append(_UNID[r])
        else:
            d, u = divmod(r, 10)
            partes.append(_DEZ[d] + (f" e {_UNID[u]}" if u else ""))
    return " e ".join(partes)


def numero_por_extenso(n: int) -> str:
    """Número inteiro (masculino) por extenso: 1500 → "mil e quinhentos". Vai até 999 trilhões."""
    if not 0 <= n < 10**15:
        raise ValueError("número fora do intervalo suportado")
    if n == 0:
        return "zero"
    grupos: list[tuple[int, int]] = []  # (valor do grupo de 3 dígitos, posição da escala)
    esc = 0
    while n:
        n, g = divmod(n, 1000)
        if g:
            grupos.append((g, esc))
        esc += 1
    grupos.reverse()
    partes = []
    for g, esc in grupos:
        if esc == 0:
            partes.append(_ate_999(g))
        elif esc == 1:
            partes.append("mil" if g == 1 else f"{_ate_999(g)} mil")
        else:
            sing, plur = _ESCALAS[esc]
            partes.append(f"{_ate_999(g)} {sing if g == 1 else plur}")
    out = partes[0]
    for i in range(1, len(partes)):
        g = grupos[i][0]
        # "e" liga o último grupo quando ele é menor que 100 ou centena redonda: "mil e um", "um milhão e duzentos mil".
        liga = " e " if i == len(partes) - 1 and (g < 100 or g % 100 == 0) else " "
        out += liga + partes[i]
    return out


def _decimais_por_extenso(dec: str) -> str:
    """Casas depois da vírgula: "5" → "cinco", "05" → "zero cinco", "25" → "vinte e cinco"."""
    resto = dec.lstrip("0")
    partes = ["zero"] * (len(dec) - len(resto))
    if resto:
        partes.append(numero_por_extenso(int(resto)))
    return " ".join(partes)


def _quantia_falada(inteiro: int, dec: str, escala: int) -> tuple[str, bool] | None:
    """Fala "inteiro,dec × escala". Devolve (texto, termina_em_milhão/bilhão/trilhão) ou None se o valor não for exato."""
    dec = dec.rstrip("0")
    if escala >= 10**6 and dec and len(dec) <= 2:
        return f"{numero_por_extenso(inteiro)} vírgula {_decimais_por_extenso(dec)} {_ESC_NOMES[escala][1]}", True
    total = Decimal(f"{inteiro}.{dec or '0'}") * escala
    if total != total.to_integral_value() or total <= 0 or total >= 10**15:
        return None
    total = int(total)
    return numero_por_extenso(total), total >= 10**6 and total % 10**6 == 0


def _para_int(s: str) -> int:
    return int(s.replace(".", ""))


def _dinheiro_falado(m: re.Match) -> str | None:
    inteiro, dec = _para_int(m.group(1)), m.group(2) or ""
    if m.group(3):
        r = _quantia_falada(inteiro, dec, _ESC_VALOR[m.group(3)])
        if r is None:
            return None
        texto, redondo = r
        return f"{texto} {'de reais' if redondo else 'reais'}"
    if len(dec) > 2:
        return None
    centavos = int(dec.ljust(2, "0")) if dec else 0
    partes = []
    if inteiro:
        redondo = inteiro >= 10**6 and inteiro % 10**6 == 0
        unidade = "real" if inteiro == 1 else "de reais" if redondo else "reais"
        partes.append(f"{numero_por_extenso(inteiro)} {unidade}")
    if centavos:
        partes.append(f"{numero_por_extenso(centavos)} {'centavo' if centavos == 1 else 'centavos'}")
    return " e ".join(partes) or None


def _percentual_falado(m: re.Match) -> str | None:
    inteiro, dec = _para_int(m.group(1)), (m.group(2) or "").rstrip("0")
    if len(dec) > 2:
        return None
    texto = numero_por_extenso(inteiro)
    if dec:
        texto += f" vírgula {_decimais_por_extenso(dec)}"
    return texto + " por cento"


def _quantidade_falada(m: re.Match) -> str | None:
    r = _quantia_falada(_para_int(m.group(1)), m.group(2) or "", _ESC_VALOR[m.group(3)])
    return r[0] if r else None


_MEDIDAS = {"km/h": ("quilômetro por hora", "quilômetros por hora"), "km": ("quilômetro", "quilômetros"),
            "kg": ("quilo", "quilos")}


def _medida_falada(m: re.Match) -> str | None:
    inteiro, dec = _para_int(m.group(1)), (m.group(2) or "").rstrip("0")
    sing, plur = _MEDIDAS[m.group(3)]
    if dec:
        if len(dec) > 2:
            return None
        return f"{numero_por_extenso(inteiro)} vírgula {_decimais_por_extenso(dec)} {plur}"
    return f"{numero_por_extenso(inteiro)} {sing if inteiro == 1 else plur}"


_NUM = r"\d{1,3}(?:\.\d{3})+|\d+"
_ESC_ALT = "|".join(_ESC_VALOR)
RS_RE = re.compile(r"(?<![" + L + r"0-9$])R\$\s?(" + _NUM + r")(?:,(\d{1,3}))?(?:\s(" + _ESC_ALT + r")\b)?(?!\d)(?![.,]\d)")
PCT_RE = re.compile(r"(?<![\d.,])(" + _NUM + r")(?:,(\d{1,3}))?\s?%")
QTD_RE = re.compile(r"(?<![\d.,$])(?<!\$ )(" + _NUM + r")(?:,(\d{1,3}))?\s(milhão|milhões|bilhão|bilhões|trilhão|trilhões)\b(?!\d)")
MED_RE = re.compile(r"(?<![\d.,])(" + _NUM + r")(?:,(\d{1,3}))?\s?(km/h|km|kg)\b(?!\d)")

_MSG_FALADO = "Escrito como se fala, com o mesmo valor: evita tropeço na leitura ao vivo."
FALADOS = [
    (RS_RE, _dinheiro_falado), (PCT_RE, _percentual_falado),
    (QTD_RE, _quantidade_falada), (MED_RE, _medida_falada),
]

# Como o apresentador fala cada sigla. Com hífen = letra por letra; sem hífen = lida como palavra.
# A equipe pode ampliar esta lista; sigla que não está aqui continua só sendo sinalizada.
SIGLAS_FALADAS = {
    **{s: "-".join(s) for s in (
        "IBGE INSS STF STJ TSE TCU CPI PF PM PT PL PSDB MDB PDT OAB MP UTI USP CBF CNJ CNH CPF CNPJ IPTU IPVA "
        "ICMS FGTS IPCA OMS FMI BC").split()},
    **{s: s.capitalize() for s in (
        "ONU OTAN PIB SUS FIFA ENEM ANVISA ANEEL ANATEL INEP IBAMA DETRAN PROCON SAMU UNICEF UNESCO NASA MEC "
        "IPEA PSOL").split()},
}


def _sigla_canonica(w: str) -> str:
    """"I-B-G-E", "IBGE" e "Ibge" são o mesmo nome para a trava editorial."""
    return w.replace("-", "").upper()


def _inicio_de_frase(text: str, idx: int) -> bool:
    antes = text[:idx].rstrip()
    return not antes or antes[-1] in ".!?"


def _cue_ranges(text: str) -> list[tuple[int, int]]:
    return [(m.start(), m.end()) for m in CUE_RE.finditer(text)]


def _strip_cues(t: str) -> str:
    return CUE_RE.sub(" ", t or "")


def _words(t: str) -> list[str]:
    return re.findall(f"[{L}0-9][{L}0-9-]*", _strip_cues(t))


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
        if _sigla_canonica(w) in SIGLAS_FALADAS:
            out.append(_sigla_canonica(w))
        elif lw in MONTHS:
            out.append(lw)
        elif re.fullmatch(f"[{UP}]{{2,}}", w) and len(w) <= 8:
            out.append(w)
        elif re.match(f"[{UP}]", w) and lw not in STOP:
            before = t[: m.start()].rstrip()
            if before and (ABREV_RE.search(before) or not re.search(r"[.!?:\"“]$", before)):
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

    for categoria, regras in REGRAS_EXTRAS:
        for rx, fix, conf, msg in regras:
            for m in rx.finditer(text):
                novo = fix(m)
                if novo != m.group(0):
                    push(m.start(), categoria, conf, msg, m.group(0), novo)

    # Números como se falam (mesmo valor, escrito por extenso)
    cobertos: list[tuple[int, int]] = []
    for rx, falar in FALADOS:
        for m in rx.finditer(text):
            if any(m.start() < b and m.end() > a for a, b in cobertos):
                continue
            try:
                falado = falar(m)
            except ValueError:
                continue
            if falado is None:
                continue
            if _inicio_de_frase(text, m.start()):
                falado = falado[:1].upper() + falado[1:]
            cobertos.append((m.start(), m.end()))
            push(m.start(), "Termo difícil", "alta", _MSG_FALADO, m.group(0), falado)

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
        if (len(lw) < 5 or lw in STOP or lw in seen or _in_ranges(idx, cues)
                or re.fullmatch(r"(?:[a-z]-)+[a-z]", lw)):  # sigla soletrada ("i-b-g-e") não conta como repetição
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
        if s in SIGLA_IGNORE or text[m.end():m.end() + 1] == "-":
            continue
        if s in SIGLAS_FALADAS:
            falada = SIGLAS_FALADAS[s]
            como = "letra por letra" if "-" in falada else "como uma palavra"
            push(m.start(), "Termo difícil", "media",
                 f"A sigla “{s}” se lê {como}. Escrever “{falada}” deixa isso claro na leitura em voz alta.",
                 s, falada)
            continue
        if s in seen_siglas:
            continue
        seen_siglas.add(s)
        push(m.start(), "Termo difícil", "media",
             f"Sigla “{s}”: confira como deve ser lida e, se o público não conhecer, diga o nome por extenso na primeira menção.",
             s, None)
    for m in re.finditer(r"\d{1,3}(\.\d{3}){2,}", text):
        if any(a <= m.start() < b for a, b in cobertos):
            continue  # já virou valor por extenso
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