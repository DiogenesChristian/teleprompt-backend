"""Testes do serviço de IA:  python -m pytest -q"""
import random
import re
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from main import app
from reviewer import introduces_new_facts, numero_por_extenso, review

client = TestClient(app)


def rev(text, anchors=None):
    return review([{"id": "b1", "title": "Abertura", "text": text}], anchors or [])


def sugestoes(text):
    """{original: sugestão} só do que tem texto de troca."""
    return {s["original"]: s["suggestion"] for s in rev(text) if s["suggestion"] is not None}


def aplicar(text, sugs):
    """Faz o que o editor faria ao aceitar tudo: troca a primeira ocorrência de cada original."""
    for s in sugs:
        if s["suggestion"] is not None:
            text = text.replace(s["original"], s["suggestion"], 1)
    return text


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


def test_sigla_desconhecida_e_numero_longo_so_alertam():
    sugs = rev("O SEPLAG contou 1.234.567 pessoas. O SEPLAG confirmou.")
    alertas = [s for s in sugs if s["category"] == "Termo difícil"]
    assert len(alertas) == 2
    assert all(s["suggestion"] is None for s in alertas)


def test_nao_sugere_fato_novo():
    assert introduces_new_facts("O pacote prevê recursos.", "recursos", "R$ 5 bilhões")
    assert not introduces_new_facts("Houveram 12 casos.", "Houveram", "Houve")


def test_ignora_marcacoes_tecnicas():
    assert rev("[CÂMERA 2] Boa noite. [PAUSA] Tudo certo.") == []


# ---------------------------------------------------------------- concordância
def test_haver_impessoal_no_plural():
    assert sugestoes("Devem haver mudanças. Podem haver atrasos.") == {
        "Devem haver": "Deve haver", "Podem haver": "Pode haver"}
    assert sugestoes("Haviam muitas pessoas na praça.") == {"Haviam": "Havia"}


def test_existe_e_falta_com_plural():
    assert sugestoes("Existe vários problemas no bairro.") == {"Existe": "Existem"}
    assert sugestoes("Existe 12 casos confirmados.") == {"Existe": "Existem"}
    assert sugestoes("Falta dois dias para a eleição.") == {"Falta": "Faltam"}


def test_tem_e_vem_no_plural():
    assert sugestoes("Eles tem direito a recurso.") == {"Eles tem": "Eles têm"}
    assert sugestoes("Os moradores tem medo.") == {"Os moradores tem": "Os moradores têm"}


def test_para_eu_e_futuro_do_subjuntivo():
    assert sugestoes("Isso é importante para mim fazer.") == {"para mim fazer": "para eu fazer"}
    assert sugestoes("Se eu ver o resultado, aviso. Quando ele fazer isso, volto.") == {
        "Se eu ver": "Se eu vir", "Quando ele fazer": "Quando ele fizer"}


def test_se_apassivador_concorda():
    assert sugestoes("Estima-se 3 mil pessoas na orla.") == {"Estima-se": "Estimam-se"}


def test_concordancia_nao_acusa_texto_certo():
    certo = ("Existe 1 caso confirmado. Existem 12 casos. Deve haver mudanças. Havia muitas pessoas. "
             "Eles têm direito. Para eu fazer isso, preciso de tempo. Estima-se que 3 mil pessoas estiveram lá. "
             "As vezes que ele veio foram poucas.")
    assert [s for s in rev(certo) if s["suggestion"] is not None and s["category"] == "Gramática"] == []


# ---------------------------------------------------------------- crase
def test_crase_obrigatoria():
    assert sugestoes("Devido as chuvas, o trânsito parou.") == {"Devido as": "Devido às"}
    assert sugestoes("Devido a chuva, o trânsito parou.") == {"Devido a chuva": "Devido à chuva"}
    assert sugestoes("Em relação as obras, nada mudou.") == {"Em relação as": "Em relação às"}
    assert sugestoes("As vezes o trânsito para.") == {"As vezes": "Às vezes"}
    assert sugestoes("O ato começa as 19h na praça.") == {"as 19h": "às 19h"}
    assert sugestoes("O prefeito vai a escola amanhã.") == {"vai a escola": "vai à escola"}


def test_crase_que_nao_existe():
    assert sugestoes("Trabalhamos à partir de segunda.") == {"à partir": "a partir"}
    assert sugestoes("Ele foi para à capital.") == {"para à": "para a"}
    assert sugestoes("Ele veio à pé até aqui.") == {"à pé": "a pé"}


def test_crase_nao_acusa_texto_certo():
    certo = ("Devido a chuvas fortes, o trânsito parou. Contei todas as vezes que ele veio. "
             "O ato começa às 19h e vai até as 22h30. Entre as 19h e as 21h não há fila. Desde as 8h, chove. "
             "Ele vai à escola. Foi a escola que decidiu. Vou a casa agora. "
             "Ficou à vontade e saiu à noite.")
    assert [s for s in rev(certo) if s["suggestion"] is not None and s["category"] == "Gramática"] == []


# ---------------------------------------------------------------- vírgula
def test_virgula_antes_de_mas_e_ou_seja():
    assert sugestoes("Ele chegou mas não falou.") == {"chegou mas": "chegou, mas"}
    assert sugestoes("A obra atrasou ou seja não termina em maio.") == {"atrasou ou seja": "atrasou, ou seja"}


def test_virgula_no_vocativo():
    assert sugestoes("Bom dia Telespectadores!") == {"Bom dia Telespectadores": "Bom dia, Telespectadores"}
    assert sugestoes("Boa noite Brasil.") == {"Boa noite Brasil": "Boa noite, Brasil"}


def test_virgula_adversativa_e_so_aviso_de_baixa_confianca():
    s = [x for x in rev("O governo prometeu porém não cumpriu.") if x["category"] == "Pontuação"]
    assert len(s) == 1 and s[0]["confidence"] == "baixa"


def test_virgula_nao_acusa_texto_certo():
    certo = "Ele chegou, mas não falou. Mas ninguém ouviu. Boa noite, Brasil. Foi não só rápido mas também barato."
    assert [s for s in rev(certo) if s["category"] == "Pontuação"] == []


# ---------------------------------------------------------------- palavras difíceis de falar
def test_troca_palavras_dificeis():
    assert sugestoes("Mormente agora, o caminho é longo.") == {"Mormente": "Principalmente"}
    assert sugestoes("O evento durou aproximadamente duas horas.") == {"aproximadamente": "cerca de"}
    assert sugestoes("Posteriormente, o juiz decidiu.") == {"Posteriormente": "Depois"}


def test_troca_nao_quebra_regencia():
    # "posteriormente a" pede outra estrutura: não sugerimos troca automática
    assert sugestoes("Isso ocorreu posteriormente a decisão.") == {}


def test_titulos_viram_palavra():
    assert sugestoes("O Sr. Silva e a Dra. Helena Duarte chegaram.") == {"Sr.": "senhor", "Dra.": "doutora"}


def test_mesoclise_so_avisa():
    s = [x for x in rev("Dir-se-ia que ninguém viu.") if x["category"] == "Termo difícil"]
    assert len(s) == 1 and s[0]["suggestion"] is None


# ---------------------------------------------------------------- números por extenso
@pytest.mark.parametrize("n,esperado", [
    (0, "zero"), (1, "um"), (15, "quinze"), (21, "vinte e um"), (100, "cem"), (101, "cento e um"),
    (110, "cento e dez"), (999, "novecentos e noventa e nove"), (1000, "mil"), (1001, "mil e um"),
    (1100, "mil e cem"), (1500, "mil e quinhentos"), (2000, "dois mil"),
    (12345, "doze mil trezentos e quarenta e cinco"), (100000, "cem mil"),
    (1000000, "um milhão"), (1000001, "um milhão e um"), (2000000, "dois milhões"),
    (1200000, "um milhão e duzentos mil"), (12_000_000_000, "doze bilhões"),
    (2_300_000_000, "dois bilhões e trezentos milhões"), (10**12, "um trilhão"),
])
def test_numero_por_extenso(n, esperado):
    assert numero_por_extenso(n) == esperado


_VALORES = {"zero": 0, "um": 1, "dois": 2, "três": 3, "quatro": 4, "cinco": 5, "seis": 6, "sete": 7, "oito": 8,
            "nove": 9, "dez": 10, "onze": 11, "doze": 12, "treze": 13, "catorze": 14, "quinze": 15,
            "dezesseis": 16, "dezessete": 17, "dezoito": 18, "dezenove": 19, "vinte": 20, "trinta": 30,
            "quarenta": 40, "cinquenta": 50, "sessenta": 60, "setenta": 70, "oitenta": 80, "noventa": 90,
            "cem": 100, "cento": 100, "duzentos": 200, "trezentos": 300, "quatrocentos": 400,
            "quinhentos": 500, "seiscentos": 600, "setecentos": 700, "oitocentos": 800, "novecentos": 900}
_ESCALAS = {"mil": 10**3, "milhão": 10**6, "milhões": 10**6, "bilhão": 10**9, "bilhões": 10**9,
            "trilhão": 10**12, "trilhões": 10**12}


def de_extenso(frase):
    """Leitor independente: volta de "doze mil e um" para 12001 (confere o conversor sem usar o código dele)."""
    total = atual = 0
    for w in frase.split():
        if w == "e":
            continue
        if w in _VALORES:
            atual += _VALORES[w]
        else:
            total += (atual or 1) * _ESCALAS[w]
            atual = 0
    return total + atual


def valor_falado(frase):
    """Como de_extenso, mas entende "doze vírgula cinco bilhões" → Decimal('12500000000')."""
    escala = 1
    palavras = frase.split()
    if palavras and palavras[-1] in ("milhão", "milhões", "bilhão", "bilhões", "trilhão", "trilhões") and "vírgula" in palavras:
        escala = _ESCALAS[palavras[-1]]
        palavras = palavras[:-1]
    if "vírgula" in palavras:
        i = palavras.index("vírgula")
        inteiro = de_extenso(" ".join(palavras[:i]))
        resto = palavras[i + 1:]
        zeros = 0
        while resto and resto[0] == "zero":
            zeros += 1
            resto = resto[1:]
        dec = str(de_extenso(" ".join(resto))) if resto else ""
        return Decimal(f"{inteiro}.{'0' * zeros}{dec}") * escala
    return Decimal(de_extenso(frase))


def test_extenso_volta_ao_mesmo_numero():
    """De 0 a 3000 e uma amostra grande: do número ao extenso e de volta, sem perder nada."""
    for n in range(0, 3001):
        assert de_extenso(numero_por_extenso(n)) == n
    rnd = random.Random(7)
    for _ in range(3000):
        n = rnd.choice([rnd.randrange(10**k) for k in range(4, 15)])
        assert de_extenso(numero_por_extenso(n)) == n


def test_dinheiro_como_se_fala():
    assert sugestoes("O programa prevê R$ 12 bi em obras.") == {"R$ 12 bi": "doze bilhões de reais"}
    assert sugestoes("O programa prevê R$ 12 bilhões em obras.") == {"R$ 12 bilhões": "doze bilhões de reais"}
    assert sugestoes("Custa R$ 50 mil.") == {"R$ 50 mil": "cinquenta mil reais"}
    assert sugestoes("Custa R$ 1 mi.") == {"R$ 1 mi": "um milhão de reais"}
    assert sugestoes("Custa R$ 1,5 bi.") == {"R$ 1,5 bi": "um vírgula cinco bilhões de reais"}
    assert sugestoes("Custa R$ 12,50.") == {"R$ 12,50": "doze reais e cinquenta centavos"}
    assert sugestoes("Custa R$ 1.") == {"R$ 1": "um real"}
    assert sugestoes("Custa R$ 1.200.000 no total.") == {"R$ 1.200.000": "um milhão e duzentos mil reais"}


def test_dinheiro_no_comeco_da_frase_ganha_maiuscula():
    assert sugestoes("R$ 12 bi serão investidos.") == {"R$ 12 bi": "Doze bilhões de reais"}
    assert sugestoes("Foi aprovado. R$ 3 mi vão para a saúde.") == {"R$ 3 mi": "Três milhões de reais"}


def test_percentual_quantidade_e_medida():
    assert sugestoes("A taxa subiu 5%.") == {"5%": "cinco por cento"}
    assert sugestoes("A inflação foi de 3,5%.") == {"3,5%": "três vírgula cinco por cento"}
    assert sugestoes("Gastos de 0,05%.") == {"0,05%": "zero vírgula zero cinco por cento"}
    assert sugestoes("São 3 milhões de pessoas.") == {"3 milhões": "três milhões"}
    assert sugestoes("São 2,5 milhões de pessoas.") == {"2,5 milhões": "dois vírgula cinco milhões"}
    assert sugestoes("O limite é de 80 km/h na pista.") == {"80 km/h": "oitenta quilômetros por hora"}
    assert sugestoes("São 12 km até lá e 1 km depois.") == {"12 km": "doze quilômetros", "1 km": "um quilômetro"}


@pytest.mark.parametrize("texto", [
    "Custa R$ 1.5 bi.",          # decimal com ponto: ambíguo, não mexe
    "Custa R$ 1,2345 mil.",      # casas demais para ser valor em reais
    "Subiu 3,125%.",             # casas demais para falar
    "Ligue 199 agora.",          # número comum fica como está
    "Foram 2.500 pessoas.",      # contagem comum: gênero pode mudar o extenso
])
def test_numero_ambiguo_nao_vira_sugestao(texto):
    assert [s for s in rev(texto) if s["suggestion"] is not None] == []


def test_valor_por_extenso_nao_muda_o_valor():
    """O que o editor leria em voz alta tem de valer o mesmo que o número escrito."""
    casos = {
        "R$ 12 bi": 12 * 10**9, "R$ 12 bilhões": 12 * 10**9, "R$ 2,3 bi": Decimal("2.3") * 10**9,
        "R$ 1,25 mi": Decimal("1.25") * 10**6, "R$ 50 mil": 50_000, "R$ 1,5 mil": 1500,
        "R$ 0,5 mi": 500_000, "R$ 1.234.567": 1_234_567, "R$ 3 tri": 3 * 10**12,
        "3,5 milhões": Decimal("3.5") * 10**6, "7 bilhões": 7 * 10**9,
    }
    for escrito, valor in casos.items():
        sug = [s for s in rev(f"Valor: {escrito} no ano.") if s["suggestion"] is not None]
        assert len(sug) == 1, escrito
        falado = re.sub(r" (de )?reais$", "", sug[0]["suggestion"])
        assert valor_falado(falado) == Decimal(valor), (escrito, sug[0]["suggestion"])


# ---------------------------------------------------------------- siglas
def test_sigla_letra_por_letra_e_como_palavra():
    assert sugestoes("O IBGE divulgou. A ONU respondeu.") == {"IBGE": "I-B-G-E", "ONU": "Onu"}


def test_sigla_conhecida_vale_em_toda_mencao():
    sugs = [s for s in rev("O IBGE contou. Depois o IBGE confirmou.") if s["suggestion"]]
    assert len(sugs) == 2


def test_sigla_ja_falada_nao_e_sinalizada_de_novo():
    assert rev("O I-B-G-E contou. A Onu respondeu.") == []


# ---------------------------------------------------------------- trava editorial
ROTEIROS = [
    "Boa noite. O Governo Federal anunciou hoje um novo pacote de investimentos em infraestrutura. "
    "O programa prevê R$ 12 bilhões em recursos e deve beneficiar 15 estados brasileiros a partir de janeiro.",
    "Segundo o Ministério dos Transportes, a maior parte do dinheiro vai para rodovias e ferrovias. "
    "A ministra Helena Duarte afirmou que as primeiras obras começam pelo Nordeste. O Sr. Silva, do IBGE, disse que "
    "devido as chuvas haviam muitas obras paradas, mas o ritmo vai crescer 3,5% ao ano.",
    "Houveram registros de alagamento em pelo menos 12 bairros do Recife. Bom dia Brasil! A ONU e a APAC "
    "registraram 86 milímetros em seis horas, aproximadamente metade do volume previsto para o mês de novembro.",
]


@pytest.mark.parametrize("texto", ROTEIROS)
def test_nenhuma_sugestao_inventa_fato_novo(texto):
    for s in rev(texto):
        if s["suggestion"] is not None:
            assert not introduces_new_facts(texto, s["original"], s["suggestion"]), s


@pytest.mark.parametrize("texto", ROTEIROS)
def test_numeros_e_nomes_do_original_continuam_no_texto_corrigido(texto):
    """Depois de aceitar tudo, nome próprio e data continuam; número só pode mudar de forma, nunca de valor."""
    novo = aplicar(texto, rev(texto))
    for nome in ("Helena Duarte", "Nordeste", "Recife", "Brasil", "Governo Federal", "janeiro", "novembro"):
        assert (nome in novo) == (nome in texto)


@pytest.mark.parametrize("texto", ROTEIROS)
def test_aceitar_tudo_converge(texto):
    """Depois de aceitar todas as trocas, o revisor não tem mais nenhuma troca para propor."""
    novo = aplicar(texto, rev(texto))
    assert [s for s in rev(novo) if s["suggestion"] is not None] == []