"""Saídas de estoque (movimentações internas) de uma loja no mês.

Regras:
- Saída = Movimentacao_Item cujo motivo (Mov_Desc) tem E_S = 'S'; movimentação cancelada fica fora.
- Data = Movimentacao.Data; valor = Qtde × Preco_Custo do item (custo gravado na movimentação).
- Depósito = grupo do produto, pela lista "depositos" de regras.json (o resto é "Loja").
- Motivo e setor = regra "motivos" de regras.json, pela descrição do motivo no sistema.
  A regra também diz em qual quadro a saída aparece (Avarias, Marmitas...); sem quadro, vai para a tabela principal.
  Os códigos de Mov_Desc e Grupo_Produto mudam entre lojas, por isso tudo é casado pela descrição.
"""
import unicodedata
from datetime import date

from .banco import consultar, num
from .config import DEPOSITO_PADRAO, DEPOSITOS, MOTIVOS

SQL_ITENS = """
SELECT m.Codigo AS Mov, MIN(m.Data) AS Data, mi.Motivo, MAX(md.Descricao) AS MotivoSis,
       mi.Produto, MAX(p.Nome) AS Nome, MAX(p.Unidade) AS Unidade, MAX(g.Descricao) AS Grupo,
       SUM(mi.Qtde) AS Qtde, SUM(mi.Qtde * ISNULL(mi.Preco_Custo, 0)) AS Valor
FROM Movimentacao m
JOIN Movimentacao_Item mi ON mi.Movimentacao = m.Codigo
JOIN Mov_Desc md ON md.Codigo = mi.Motivo AND md.E_S = 'S'
LEFT JOIN Produto p ON p.Codigo = mi.Produto
LEFT JOIN Grupo_Produto g ON g.Codigo = p.Grupo
WHERE m.Data >= ? AND m.Data < ?
  AND ISNULL(m.Cancelada, 'N') <> 'S'
GROUP BY m.Codigo, mi.Motivo, mi.Produto
"""


def normalizar(texto):
    """Maiúsculas, sem acento e com espaços simples (para casar descrições entre lojas)."""
    t = unicodedata.normalize("NFKD", texto or "")
    return " ".join("".join(c for c in t if not unicodedata.combining(c)).upper().split())


_GRUPO_DEPOSITO = {normalizar(g): d["nome"] for d in DEPOSITOS for g in d["grupos"]}
_REGRAS = [(normalizar(r["contem"]), r) for r in MOTIVOS]


def deposito(grupo):
    return _GRUPO_DEPOSITO.get(normalizar(grupo), DEPOSITO_PADRAO)


def regra_motivo(descricao):
    """Motivo, setor, quadro, rótulo da linha e tipo (segmentação) para a descrição do motivo no sistema."""
    d = normalizar(descricao)
    for contem, r in _REGRAS:
        if contem in d:
            return (r["motivo"], r["setor"], r.get("quadro", ""), r.get("linha") or r["setor"],
                    r.get("tipo") or r["motivo"])
    motivo = (descricao or "Sem motivo").strip().capitalize()
    return motivo, "Outros", "", "Outros", motivo


def _periodo(ano, mes):
    inicio = date(ano, mes, 1)
    fim = date(ano + 1, 1, 1) if mes == 12 else date(ano, mes + 1, 1)
    return inicio.isoformat(), fim.isoformat()


def saidas(u, ano, mes):
    """Itens de saída da loja u no mês, já com depósito, motivo e setor, no formato do navegador."""
    linhas = consultar(u, SQL_ITENS, _periodo(ano, mes), u.get("timeout", 30))
    itens = []
    for i in linhas:
        motivo, setor, quadro, linha, tipo = regra_motivo(i["MotivoSis"])
        itens.append({
            "mov": i["Mov"],
            "data": i["Data"].date().isoformat() if i["Data"] else "",
            "motivoSis": (i["MotivoSis"] or "").strip(),
            "motivo": motivo,
            "setor": setor,
            "quadro": quadro,
            "linha": linha,
            "tipo": tipo,
            "produto": int(i["Produto"]) if i["Produto"] is not None else None,
            "nome": (i["Nome"] or "Produto sem cadastro").strip(),
            "unidade": (i["Unidade"] or "").strip().upper(),
            "grupo": (i["Grupo"] or "SEM GRUPO").strip().upper(),
            "deposito": deposito(i["Grupo"]),
            "qtde": round(num(i["Qtde"]), 3),
            "valor": round(num(i["Valor"]), 2),
        })
    return {"loja": u["slug"], "nome": u["nome"], "itens": itens}
