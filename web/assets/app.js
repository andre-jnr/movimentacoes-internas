/* Movimentações internas — busca o mês no servidor e faz todos os filtros aqui no navegador. */
(() => {
  "use strict";

  const MESES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto",
    "Setembro", "Outubro", "Novembro", "Dezembro"];
  const moeda = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  const inteiro = new Intl.NumberFormat("pt-BR");
  const decimal = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 3 });
  const percentual = new Intl.NumberFormat("pt-BR", { style: "percent", maximumFractionDigits: 1 });
  const pct = (parte, todo) => percentual.format(todo ? parte / todo : 0);

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const plural = (n, um, varios) => `${inteiro.format(n)} ${n === 1 ? um : varios}`;
  const dataBR = (iso) => (iso ? iso.split("-").reverse().join("/") : "");
  const soma = (lista, f) => lista.reduce((t, x) => t + f(x), 0);
  const ordenarTexto = (a, b) => a.localeCompare(b, "pt-BR");

  const estado = {
    cfg: { lojas: [], depositos: [], quadros: [] },
    dados: null,
    req: null,
    abertos: new Set(),      // movimentações abertas na relação
    expandidos: new Set(),   // linhas e tipos abertos nas tabelas setor × depósito
    visao: null, // último cálculo (usado pelo CSV)
  };

  // cor fixa por depósito (ordem de config/regras.json), nunca pela posição no ranking
  const corDeposito = (d) => {
    const i = estado.cfg.depositos.indexOf(d);
    return i >= 0 && i < 6 ? `var(--d${i + 1})` : "var(--muted)";
  };
  const ordemDeposito = (a, b) => {
    const ia = estado.cfg.depositos.indexOf(a), ib = estado.cfg.depositos.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || ordenarTexto(a, b);
  };
  const marcaDeposito = (d) => `<span class="dep" style="--cor:${corDeposito(d)}">${esc(d)}</span>`;
  // códigos das movimentações (mais recentes primeiro); passando de 12, o resto vira "+N" com a lista no title
  const codigos = (movs) => {
    const todos = [...movs].sort((a, b) => parseInt(b) - parseInt(a));
    const vistos = todos.length > 12 ? todos.slice(0, 11) : todos;
    const resto = todos.slice(vistos.length);
    return vistos.map((c) => `<span class="codigo">${esc(c)}</span>`).join("") +
      (resto.length ? `<span class="codigo mais" title="${esc(resto.join(", "))}">+${resto.length}</span>` : "");
  };

  // ------------------------------------------------------------------
  // Filtros
  // ------------------------------------------------------------------
  function montarFiltros() {
    const hoje = new Date();
    const url = new URLSearchParams(location.search);
    const ano = +url.get("ano") || hoje.getFullYear();
    const mes = +url.get("mes") || hoje.getMonth() + 1;

    $("f-mes").innerHTML = MESES.map((m, i) => `<option value="${i + 1}">${m}</option>`).join("");
    const anos = [];
    for (let a = hoje.getFullYear(); a >= 2020; a--) anos.push(`<option value="${a}">${a}</option>`);
    $("f-ano").innerHTML = anos.join("");
    $("f-mes").value = mes;
    $("f-ano").value = ano;
    estado.iniciais = { loja: url.get("loja") || "", setor: url.get("setor") || "", motivo: url.get("motivo") || "", deposito: url.get("deposito") || "" };
  }

  function lembrarNaUrl() {
    const p = new URLSearchParams({ ano: $("f-ano").value, mes: $("f-mes").value });
    for (const k of ["loja", "setor", "motivo", "deposito"]) if ($("f-" + k).value) p.set(k, $("f-" + k).value);
    history.replaceState(null, "", "?" + p);
  }

  // preenche um select com as opções, mantendo a escolha atual (ou a da URL) se ainda existir
  function opcoes(id, valores, inicial) {
    const sel = $(id);
    const atual = sel.value || inicial || "";
    sel.innerHTML = `<option value="">${sel.options[0].textContent}</option>` +
      valores.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
    sel.value = valores.includes(atual) ? atual : "";
  }

  async function carregarConfig() {
    try {
      estado.cfg = { ...estado.cfg, ...(await (await fetch("api/config")).json()) };
    } catch (e) { /* o erro aparece na busca do mês */ }
    const lojas = estado.cfg.lojas || [];
    if (lojas.length > 1) {
      $("campo-loja").hidden = false;
      $("f-loja").insertAdjacentHTML("beforeend", lojas.map((l) => `<option value="${esc(l.slug)}">${esc(l.nome)}</option>`).join(""));
      if (lojas.some((l) => l.slug === estado.iniciais.loja)) $("f-loja").value = estado.iniciais.loja;
    }
    opcoes("f-deposito", estado.cfg.depositos || [], estado.iniciais.deposito);
  }

  // ------------------------------------------------------------------
  // Busca no servidor
  // ------------------------------------------------------------------
  async function buscar(atualizar = false) {
    const ano = +$("f-ano").value, mes = +$("f-mes").value;
    const hoje = new Date();
    if (ano * 12 + mes > hoje.getFullYear() * 12 + hoje.getMonth() + 1) {
      estado.dados = { lojas: [] };
      avisar(["Esse mês ainda não começou."]);
      desenhar();
      return;
    }

    if (estado.req) estado.req.abort();
    const req = (estado.req = new AbortController());
    carregando(true);
    try {
      const resp = await fetch(`api/movimentacoes?ano=${ano}&mes=${mes}${atualizar ? "&atualizar=1" : ""}`, { signal: req.signal });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.erro || "Falha ao buscar os dados.");
      estado.dados = json;
      estado.abertos.clear();
      avisar(json.lojas.filter((l) => l.erro).map((l) => `${l.nome}: ${l.erro}.`));
    } catch (e) {
      if (e.name === "AbortError") return;
      estado.dados = { lojas: [] };
      avisar([e.message || "Não foi possível falar com o servidor."]);
    } finally {
      if (estado.req === req) { estado.req = null; carregando(false); }
    }
    montarOpcoesDoMes();
    desenhar();
  }

  function carregando(sim) {
    document.body.classList.toggle("carregando", sim);
    $("atualizar").disabled = sim;
    $("atualizar").classList.toggle("girando", sim);
  }

  function avisar(msgs) {
    $("avisos").innerHTML = msgs.map((m) => `<div class="aviso">${esc(m)}</div>`).join("");
  }

  function todosItens() {
    const loja = $("f-loja").value;
    const lojas = (estado.dados?.lojas || []).filter((l) => !l.erro && (!loja || l.loja === loja));
    return lojas.flatMap((l) => l.itens.map((i) => ({ ...i, loja: l.loja, lojaNome: l.nome })));
  }

  function montarOpcoesDoMes() {
    const itens = todosItens();
    opcoes("f-setor", [...new Set(itens.map((i) => i.setor))].sort(ordenarTexto), estado.iniciais.setor);
    opcoes("f-motivo", [...new Set(itens.map((i) => i.motivo))].sort(ordenarTexto), estado.iniciais.motivo);
    estado.iniciais.setor = estado.iniciais.motivo = "";
  }

  // ------------------------------------------------------------------
  // Cálculo da visão filtrada
  // ------------------------------------------------------------------
  // soma o item num nó (linha, tipo ou movimentação): total e valor por depósito
  const acumular = (no, i) => {
    no.total += i.valor;
    no.dep.set(i.deposito, (no.dep.get(i.deposito) || 0) + i.valor);
  };
  const filho = (mapa, chave, extra) =>
    mapa.get(chave) || mapa.set(chave, { nome: chave, total: 0, dep: new Map(), ...extra }).get(chave);
  const porValor = (mapa) => [...mapa.values()].sort((a, b) => b.total - a.total);

  // Uma tabela setor × depósito: linhas com os códigos das movimentações, valor por depósito e totais.
  // Cada linha abre nos tipos (Retirada, Aproveitamento, Funcionários...) e cada tipo nas movimentações.
  function montarQuadro(nome, itens, varias, principal) {
    const linhas = new Map(), depTot = new Map(), movs = new Set();
    for (const i of itens) {
      const cod = varias ? `${i.mov} · ${i.lojaNome}` : String(i.mov);
      const l = filho(linhas, i.linha, { movs: new Set(), tipos: new Map() });
      const t = filho(l.tipos, i.tipo, { movs: new Map() });
      const m = filho(t.movs, cod, { mov: i.mov, data: i.data, motivoSis: i.motivoSis });
      for (const no of [l, t, m]) acumular(no, i);
      l.movs.add(cod);
      depTot.set(i.deposito, (depTot.get(i.deposito) || 0) + i.valor);
      movs.add(`${i.loja}|${i.mov}`);
    }
    for (const l of linhas.values()) {
      l.tipos = porValor(l.tipos);
      for (const t of l.tipos) t.movs = [...t.movs.values()].sort((a, b) => b.mov - a.mov);
    }
    // a principal mostra sempre todos os depósitos; as menores, só os que têm valor
    const filtro = $("f-deposito").value;
    const base = principal ? estado.cfg.depositos.filter((d) => !filtro || d === filtro) : [];
    return {
      nome, principal, depTot, movs: movs.size,
      total: soma(itens, (i) => i.valor),
      colunas: [...new Set([...base, ...depTot.keys()])].sort(ordemDeposito),
      linhas: porValor(linhas),
    };
  }

  function calcular() {
    const setor = $("f-setor").value, motivo = $("f-motivo").value, deposito = $("f-deposito").value;
    const itens = todosItens().filter((i) =>
      (!setor || i.setor === setor) && (!motivo || i.motivo === motivo) && (!deposito || i.deposito === deposito));
    const varias = (estado.dados?.lojas || []).filter((l) => !l.erro).length > 1 && !$("f-loja").value;

    // saída com quadro desconhecido (fora da lista do servidor) fica na tabela principal
    const nomes = estado.cfg.quadros || [];
    const quadroDe = (i) => (nomes.includes(i.quadro) ? i.quadro : "");
    const quadros = [
      montarQuadro("Setor × depósito", itens.filter((i) => !quadroDe(i)), varias, true),
      ...nomes.map((q) => montarQuadro(q, itens.filter((i) => quadroDe(i) === q), varias, false)),
    ];

    const lancs = new Map();
    for (const i of itens) {
      const kl = `${i.loja}|${i.mov}|${i.motivoSis}`;
      const l = lancs.get(kl) || lancs.set(kl, {
        chave: kl, mov: i.mov, data: i.data, loja: i.lojaNome, motivo: i.motivo, motivoSis: i.motivoSis,
        setor: i.setor, total: 0, dep: new Map(), itens: [],
      }).get(kl);
      l.total += i.valor;
      l.dep.set(i.deposito, (l.dep.get(i.deposito) || 0) + i.valor);
      l.itens.push(i);
    }
    return { itens, varias, quadros, lancamentos: [...lancs.values()] };
  }

  // ------------------------------------------------------------------
  // Desenho
  // ------------------------------------------------------------------
  function desenhar() {
    const v = (estado.visao = calcular());
    const ano = +$("f-ano").value, mes = +$("f-mes").value;
    const lojas = estado.cfg.lojas || [];
    const loja = lojas.find((l) => l.slug === $("f-loja").value);
    const nomeLoja = loja ? loja.nome : lojas.length === 1 ? lojas[0].nome : "Todas as lojas";
    $("periodo").textContent = `${MESES[mes - 1]} de ${ano} · ${nomeLoja}`;
    document.title = `Movimentações internas · ${MESES[mes - 1]}/${ano}`;
    lembrarNaUrl();
    desenharQuadros(v);
    desenharRelacao(v);
  }

  // chaves das linhas abertas: "quadro|setor" e "quadro|setor|tipo" (sobrevivem a troca de filtro)
  const chaveLinha = (q, l) => `${q.nome}|${l.nome}`;
  const chaveTipo = (q, l, t) => `${q.nome}|${l.nome}|${t.nome}`;

  function tabelaQuadro(q) {
    if (!q.linhas.length) return `<p class="vazio">Nenhuma saída no período.</p>`;
    const maxCel = Math.max(...q.linhas.flatMap((l) => [...l.dep.values()]), 1);
    const celula = (val) => (val
      ? `<td class="num celula" style="--a:${(0.06 + 0.42 * (val / maxCel)).toFixed(3)}">${moeda.format(val)}</td>`
      : `<td class="num zero">—</td>`);
    const simples = (val) => (val ? `<td class="num">${moeda.format(val)}</td>` : `<td class="num zero">—</td>`);
    const valores = (no, f) => q.colunas.map((d) => f(no.dep.get(d) || 0)).join("");
    const abre = (chave, aberto) => `class="expansivel${aberto ? " aberto" : ""}" data-abre="${esc(chave)}" tabindex="0" aria-expanded="${aberto}"`;
    const seta = `<span class="seta" aria-hidden="true">›</span>`;

    const linhasHtml = q.linhas.map((l) => {
      const abertoL = estado.expandidos.has(chaveLinha(q, l));
      let html = `<tr ${abre(chaveLinha(q, l), abertoL)}>
        <td class="cods"><span class="codigos">${codigos(l.movs)}</span></td>
        <td class="setor">${seta}${esc(l.nome)}</td>
        ${valores(l, celula)}
        <td class="num total">${moeda.format(l.total)}</td>
      </tr>`;
      if (!abertoL) return html;
      for (const t of l.tipos) {
        const abertoT = estado.expandidos.has(chaveTipo(q, l, t));
        html += `<tr ${abre(chaveTipo(q, l, t), abertoT).replace('class="', 'class="nivel-2 ')}>
          <td class="cods"><span class="codigos">${codigos(t.movs.map((m) => m.nome))}</span></td>
          <td class="setor">${seta}${esc(t.nome)}<span class="sub">${plural(t.movs.length, "movimentação", "movimentações")} · ${pct(t.total, l.total)}</span></td>
          ${valores(t, simples)}
          <td class="num total">${moeda.format(t.total)}</td>
        </tr>`;
        if (abertoT) {
          html += t.movs.map((m) => `<tr class="nivel-3">
            <td class="cods"><span class="codigos"><span class="codigo">${esc(m.nome)}</span></span></td>
            <td class="setor">${dataBR(m.data)}<span class="sub">${esc(m.motivoSis)}</span></td>
            ${valores(m, simples)}
            <td class="num total">${moeda.format(m.total)}</td>
          </tr>`).join("");
        }
      }
      return html;
    }).join("");

    return `<div class="rolagem"><table class="matriz">
      <thead><tr><th>Nº</th><th>Setor</th>${q.colunas.map((d) => `<th class="num">${marcaDeposito(d)}</th>`).join("")}<th class="num total">Total</th></tr></thead>
      <tbody>${linhasHtml}</tbody>
      <tfoot><tr><td colspan="2">Total</td>${q.colunas.map((d) => `<td class="num">${q.depTot.get(d) ? moeda.format(q.depTot.get(d)) : "—"}</td>`).join("")}<td class="num">${moeda.format(q.total)}</td></tr></tfoot>
    </table></div>`;
  }

  const chavesDoQuadro = (q) => q.linhas.flatMap((l) => [chaveLinha(q, l), ...l.tipos.map((t) => chaveTipo(q, l, t))]);
  const todasAbertas = (q) => chavesDoQuadro(q).every((c) => estado.expandidos.has(c));

  function desenharQuadros(v) {
    const outros = (estado.cfg.quadros || []).map((n) => n.toLowerCase());
    // tabela com mais de 3 depósitos não cabe em meia largura: ocupa a linha inteira da grade
    const cartao = (q, k) => `<section class="cartao quadro${q.colunas.length > 3 ? " largo" : ""}">
      <div class="cartao-topo">
        <div>
          <h2>${esc(q.nome)}</h2>
          <p class="ajuda">${q.principal
            ? `Consumo e demais saídas: valor de cada depósito para cada setor${outros.length ? ` (sem ${outros.join(", ").replace(/, ([^,]*)$/, " e $1")}, que têm tabela própria)` : ""}. Clique num setor para abrir em retirada, aproveitamento, funcionários...`
            : q.linhas.length ? `${moeda.format(q.total)} · ${plural(q.movs, "movimentação", "movimentações")} · clique numa linha para abrir` : "Sem lançamentos no mês."}</p>
        </div>
        ${q.linhas.length ? `<div class="acoes">
          <button class="botao fantasma" type="button" data-expandir="${k}">${todasAbertas(q) ? "Recolher tudo" : "Expandir tudo"}</button>
          <button class="botao fantasma" type="button" data-csv="${k}" title="Baixar CSV">CSV</button>
        </div>` : ""}
      </div>
      ${tabelaQuadro(q)}
    </section>`;
    const [principal, ...resto] = v.quadros;
    $("quadros").innerHTML = cartao(principal, 0) +
      (resto.length ? `<div class="grade">${resto.map((q, k) => cartao(q, k + 1)).join("")}</div>` : "");
  }

  function lancamentosVisiveis(v) {
    const q = $("mov-busca").value.trim().toLowerCase();
    let lista = v.lancamentos;
    if (q) {
      lista = lista.filter((l) => String(l.mov).includes(q) || l.motivo.toLowerCase().includes(q) ||
        l.motivoSis.toLowerCase().includes(q) || l.setor.toLowerCase().includes(q) ||
        l.itens.some((i) => i.nome.toLowerCase().includes(q) || String(i.produto).includes(q)));
    }
    const ordem = $("mov-ordem").value;
    const cmp = {
      mov: (a, b) => b.mov - a.mov,
      valor: (a, b) => b.total - a.total,
      data: (a, b) => b.data.localeCompare(a.data) || b.mov - a.mov,
    }[ordem];
    return [...lista].sort(cmp);
  }

  function desenharRelacao(v) {
    const t = $("t-relacao");
    const lista = lancamentosVisiveis(v);
    t.querySelectorAll("tbody").forEach((b) => b.remove());
    $("mov-resumo").textContent = lista.length
      ? `${plural(new Set(lista.map((l) => l.loja + l.mov)).size, "movimentação", "movimentações")} · clique numa linha para ver os produtos`
      : " ";
    if (!lista.length) {
      t.tFoot.innerHTML = "";
      t.insertAdjacentHTML("beforeend", `<tbody><tr><td colspan="6" class="vazio">Nenhuma movimentação encontrada.</td></tr></tbody>`);
      return;
    }
    const html = lista.map((l) => {
      const partes = [...l.dep.entries()].sort((a, b) => ordemDeposito(a[0], b[0]));
      const n = partes.length;
      const aberto = estado.abertos.has(l.chave);
      const linhas = partes.map(([d, val], k) => `<tr>
        ${k === 0 ? `<td class="n agrupa" rowspan="${n}"><span class="seta" aria-hidden="true">›</span>${esc(l.mov)}<span class="sub">${dataBR(l.data)}${v.varias ? " · " + esc(l.loja) : ""}</span></td>` : ""}
        <td>${marcaDeposito(d)}</td>
        ${k === 0 ? `<td class="motivo agrupa" rowspan="${n}" title="${esc(l.motivoSis)}">${esc(l.motivo)}<span class="sub">${esc(l.motivoSis)}</span></td>
                     <td class="agrupa" rowspan="${n}">${esc(l.setor)}</td>` : ""}
        <td class="num">${moeda.format(val)}</td>
        ${k === 0 ? `<td class="num total agrupa" rowspan="${n}">${moeda.format(l.total)}</td>` : ""}
      </tr>`).join("");
      return `<tbody class="bloco${aberto ? " aberto" : ""}" data-chave="${esc(l.chave)}" tabindex="0" aria-expanded="${aberto}">${linhas}</tbody>` +
        (aberto ? detalhe(l) : "");
    }).join("");
    t.tHead.insertAdjacentHTML("afterend", html);
    t.tFoot.innerHTML = `<tr><td colspan="5">Total</td><td class="num">${moeda.format(soma(lista, (l) => l.total))}</td></tr>`;
  }

  function detalhe(l) {
    const itens = [...l.itens].sort((a, b) => b.valor - a.valor);
    return `<tbody class="detalhe"><tr><td colspan="6"><div class="itens"><table>
      <thead><tr><th>Código</th><th>Produto</th><th>Depósito</th><th class="num">Qtde</th><th class="num">Valor</th></tr></thead>
      <tbody>${itens.map((i) => `<tr>
        <td>${esc(i.produto ?? "")}</td>
        <td>${esc(i.nome)}<span class="sub">${esc(i.grupo)}</span></td>
        <td>${marcaDeposito(i.deposito)}</td>
        <td class="num">${decimal.format(i.qtde)} ${esc(i.unidade)}</td>
        <td class="num">${moeda.format(i.valor)}</td>
      </tr>`).join("")}</tbody>
    </table></div></td></tr></tbody>`;
  }

  // ------------------------------------------------------------------
  // CSV (abre direto no Excel: ; e vírgula decimal)
  // ------------------------------------------------------------------
  function baixarCsv(tipo) {
    const v = estado.visao;
    if (!v) return;
    const n = (x) => x.toFixed(2).replace(".", ",");
    const campo = (x) => (/[;"\n]/.test(String(x)) ? `"${String(x).replace(/"/g, '""')}"` : String(x));
    let linhas, nome;
    if (tipo === "itens") {
      nome = "produtos";
      linhas = [["Loja", "Nº", "Data", "Motivo", "Motivo no sistema", "Setor", "Depósito", "Grupo", "Código", "Produto", "Qtde", "Unidade", "Valor de custo"],
        ...lancamentosVisiveis(v).flatMap((l) => l.itens.map((i) => [i.lojaNome, i.mov, dataBR(i.data), i.motivo, i.motivoSis, i.setor,
          i.deposito, i.grupo, i.produto ?? "", i.nome, String(i.qtde).replace(".", ","), i.unidade, n(i.valor)]))];
    } else {
      const q = v.quadros[+tipo];
      if (!q) return;
      nome = q.principal ? "setor-deposito" : q.nome.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\W+/g, "-");
      // uma linha por setor (tipo vazio) seguida de uma por tipo, para dar para filtrar no Excel
      const valores = (no) => q.colunas.map((d) => n(no.dep.get(d) || 0));
      linhas = [["Nº", "Setor", "Tipo", ...q.colunas, "Total"],
        ...q.linhas.flatMap((l) => [
          [[...l.movs].join(", "), l.nome, "", ...valores(l), n(l.total)],
          ...l.tipos.map((t) => [t.movs.map((m) => m.nome).join(", "), l.nome, t.nome, ...valores(t), n(t.total)]),
        ]),
        ["", "Total", "", ...q.colunas.map((d) => n(q.depTot.get(d) || 0)), n(q.total)]];
    }
    const texto = "﻿" + linhas.map((l) => l.map(campo).join(";")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([texto], { type: "text/csv;charset=utf-8" }));
    a.download = `movimentacoes-${nome}-${$("f-ano").value}-${String($("f-mes").value).padStart(2, "0")}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ------------------------------------------------------------------
  // Eventos
  // ------------------------------------------------------------------
  function ligar() {
    $("f-mes").addEventListener("change", () => buscar());
    $("f-ano").addEventListener("change", () => buscar());
    $("f-loja").addEventListener("change", () => { montarOpcoesDoMes(); desenhar(); });
    for (const id of ["f-setor", "f-motivo", "f-deposito"]) $(id).addEventListener("change", desenhar);
    $("atualizar").addEventListener("click", () => buscar(true));
    $("mov-busca").addEventListener("input", () => desenharRelacao(estado.visao));
    $("mov-ordem").addEventListener("change", () => desenharRelacao(estado.visao));
    // os botões CSV dos quadros são recriados a cada desenho: um ouvinte só, no documento
    document.addEventListener("click", (e) => {
      const b = e.target.closest("[data-csv]");
      if (b) baixarCsv(b.dataset.csv);
    });

    // tabelas setor × depósito: clicar no setor abre os tipos; clicar no tipo abre as movimentações
    const quadros = $("quadros");
    const expandir = (linha) => {
      const k = linha.dataset.abre;
      if (estado.expandidos.has(k)) {
        // fechar um setor fecha também os tipos abertos dentro dele
        for (const c of [...estado.expandidos]) if (c === k || c.startsWith(k + "|")) estado.expandidos.delete(c);
      } else estado.expandidos.add(k);
      desenharQuadros(estado.visao);
      quadros.querySelector(`tr[data-abre="${CSS.escape(k)}"]`)?.focus({ preventScroll: true });
    };
    quadros.addEventListener("click", (e) => {
      const tudo = e.target.closest("[data-expandir]");
      if (tudo) {
        const q = estado.visao.quadros[+tudo.dataset.expandir];
        const abrir = !todasAbertas(q);
        for (const c of chavesDoQuadro(q)) if (abrir) estado.expandidos.add(c); else estado.expandidos.delete(c);
        desenharQuadros(estado.visao);
        return;
      }
      const linha = e.target.closest("tr[data-abre]");
      if (linha) expandir(linha);
    });
    quadros.addEventListener("keydown", (e) => {
      const linha = e.target.closest("tr[data-abre]");
      if (linha && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); expandir(linha); }
    });

    const alternar = (bloco) => {
      const k = bloco.dataset.chave;
      if (estado.abertos.has(k)) estado.abertos.delete(k); else estado.abertos.add(k);
      desenharRelacao(estado.visao);
      document.querySelector(`tbody.bloco[data-chave="${CSS.escape(k)}"]`)?.focus({ preventScroll: true });
    };
    const rel = $("t-relacao");
    rel.addEventListener("click", (e) => { const b = e.target.closest("tbody.bloco"); if (b) alternar(b); });
    rel.addEventListener("keydown", (e) => {
      const b = e.target.closest("tbody.bloco");
      if (b && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); alternar(b); }
    });

    $("tema").addEventListener("click", () => {
      const raiz = document.documentElement;
      const escuroAgora = raiz.dataset.theme ? raiz.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
      raiz.dataset.theme = escuroAgora ? "light" : "dark";
      try { localStorage.setItem("tema", raiz.dataset.theme); } catch (e) { /* sem armazenamento */ }
    });
  }

  montarFiltros();
  ligar();
  carregarConfig().then(() => buscar());
})();
