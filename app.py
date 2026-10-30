"""Movimentações internas: saídas de estoque do mês por depósito e setor (dados ao vivo do SQL Server SISMOURA).

  python app.py             -> modo local: só este computador (http://localhost:PORTA)
  python app.py --producao  -> servidor da empresa: Waitress, aceita acesso da rede
  python app.py --testar    -> testa a conexão com o banco de cada loja do .env (diagnóstico)

Quais lojas são consultadas é decidido por LOJAS no .env.
O navegador recebe os itens do mês e faz os filtros (loja, setor, motivo, depósito) sozinho.
"""
import json
import logging
import socket
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date

from flask import Flask, Response, abort, request, send_from_directory

from painel import relatorio
from painel.banco import ErroBanco
from painel.config import CACHE_MINUTOS, DEPOSITOS, LOJAS, LOJAS_DESCONHECIDAS, PORTA, QUADROS, RAIZ

PORTA_OCUPADA = 3
WEB = RAIZ / "web"

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
log = logging.getLogger("movimentacoes")

app = Flask(__name__, static_folder=None)
app.json.ensure_ascii = False

_lojas_pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="loja")


# ------------------------------------------------------------------
# Cache por loja e mês (o mês em andamento não atravessa a meia-noite)
# ------------------------------------------------------------------
_cache = {}
_travas = {}
_trava_global = threading.Lock()


def _trava(chave):
    with _trava_global:
        return _travas.setdefault(chave, threading.Lock())


def _em_cache(chave, gerar, atualizar):
    with _trava(chave):
        item = _cache.get(chave)
        if (not atualizar and item and time.time() - item["quando"] < CACHE_MINUTOS * 60
                and item["dia"] == date.today()):
            return item["dados"]
        dados = gerar()
        _cache[chave] = {"dados": dados, "quando": time.time(), "dia": date.today()}
        return dados


def _json(obj, status=200):
    return Response(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), status=status,
                    mimetype="application/json")


def _ano_mes():
    hoje = date.today()
    try:
        ano, mes = int(request.args.get("ano", "")), int(request.args.get("mes", ""))
    except ValueError:
        ano = mes = -1
    if not (2000 <= ano <= hoje.year and 1 <= mes <= 12) or ano * 12 + mes > hoje.year * 12 + hoje.month:
        abort(_json({"erro": "Informe um ano e mês válidos (até o mês atual)."}, 400))
    return ano, mes


# ------------------------------------------------------------------
# Rotas
# ------------------------------------------------------------------
@app.get("/")
def index():
    return send_from_directory(WEB, "index.html")


@app.get("/assets/<path:arquivo>")
def assets(arquivo):
    return send_from_directory(WEB / "assets", arquivo)


@app.get("/api/config")
def api_config():
    return _json({
        "lojas": [{"slug": u["slug"], "nome": u["nome"]} for u in LOJAS],
        "depositos": [d["nome"] for d in DEPOSITOS],
        "quadros": QUADROS,
    })


@app.get("/api/movimentacoes")
def api_movimentacoes():
    ano, mes = _ano_mes()
    atualizar = request.args.get("atualizar") == "1"

    def da_loja(u):
        try:
            return _em_cache((u["slug"], ano, mes), lambda: relatorio.saidas(u, ano, mes), atualizar)
        except ErroBanco as e:
            return {"loja": u["slug"], "nome": u["nome"], "erro": str(e)}
        except Exception:  # noqa: BLE001
            log.exception("Falha ao montar as movimentações de %s", u["slug"])
            return {"loja": u["slug"], "nome": u["nome"], "erro": "erro inesperado (veja o log)"}

    lojas = list(_lojas_pool.map(da_loja, LOJAS))
    return _json({"ano": ano, "mes": mes, "lojas": lojas})


@app.after_request
def _sem_cache_no_navegador(resp):
    if request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


# ------------------------------------------------------------------
def porta_em_uso(porta):
    with socket.socket() as s:
        s.settimeout(1)
        return s.connect_ex(("127.0.0.1", porta)) == 0


def testar_conexao():
    """Diagnóstico para rodar no servidor: lojas do .env, nome do servidor na rede e uma consulta simples.

    O erro completo do driver sai no log (sem a senha), para saber por que a conexão falhou.
    """
    from painel.banco import consultar
    from painel.config import credenciais

    print(f"LOJAS no .env: {', '.join(u['slug'] for u in LOJAS) or '(nenhuma)'}")
    if LOJAS_DESCONHECIDAS:
        print(f"  Não existem em config/regras.json: {', '.join(LOJAS_DESCONHECIDAS)}")
    falhas = 0
    for u in LOJAS:
        print(f"\n{u['nome']}  (servidor {u['servidor']}, banco {u['banco']})")
        usuario, senha = credenciais(u)
        print(f"  usuário/senha no .env: {'preenchidos' if usuario and senha else 'FALTANDO'}")
        try:
            print(f"  nome na rede: {u['servidor']} -> {socket.gethostbyname(u['servidor'])}")
        except OSError:
            print(f"  nome na rede: {u['servidor']} NÃO encontrado (DNS) — tente o IP do servidor em config/regras.json")
        try:
            linha = consultar(u, "SELECT TOP 1 Codigo, Data FROM Movimentacao ORDER BY Codigo DESC", (),
                              u.get("timeout", 30))
            print(f"  banco OK — última movimentação: {linha[0]['Codigo'] if linha else '(nenhuma)'}")
        except ErroBanco as e:
            falhas += 1
            print(f"  FALHOU: {e} (o erro completo está na linha acima)")
    return 1 if falhas or not LOJAS else 0


if __name__ == "__main__":
    if "--testar" in sys.argv:
        sys.exit(testar_conexao())
    if porta_em_uso(PORTA):
        print(f"ERRO: a porta {PORTA} já está em uso.", file=sys.stderr)
        sys.exit(PORTA_OCUPADA)
    if LOJAS_DESCONHECIDAS:
        log.warning("Lojas do .env que não existem em config/regras.json: %s", ", ".join(LOJAS_DESCONHECIDAS))
    if not LOJAS:
        log.warning("Nenhuma loja em LOJAS no .env: o relatório vai ficar vazio.")
    if "--producao" in sys.argv:
        from waitress import serve
        log.info("Escutando na rede: http://%s:%d", socket.gethostname(), PORTA)
        serve(app, host="0.0.0.0", port=PORTA, threads=8, ident="movimentacoes")
    else:
        log.info("Relatório local: http://localhost:%d", PORTA)
        app.run(host="127.0.0.1", port=PORTA, debug=False, threaded=True)
