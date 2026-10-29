# Movimentações internas

Relatório de uma página com todas as **saídas de estoque lançadas no mês** (movimentações internas), por depósito e setor,
com dados ao vivo do SQL Server (SISMOURA) de cada loja.

- **Porta:** 3009. Ela vem de `PORT` no `.env`.
- **Tecnologia:** Python 3.10 ou mais novo, Flask (Waitress no servidor) e `mssql-python` (já traz o driver).
- **Iniciar local:** `Abrir Relatorio.bat` ou `python app.py` → http://localhost:3009
- **Servidor:** `python app.py --producao` (aceita acesso da rede). Instalação: veja abaixo.

## Publicar no servidor (Windows)

1. Copie a pasta do projeto para o servidor.
2. Tenha o Python 3.10+ instalado.
3. Crie o `.env` a partir do `.env.example` (porta, lojas e logins do banco).
4. Clique duas vezes em `servidor\instalar.bat` e confirme o pedido de administrador.

Sobe sozinho ao ligar o computador (tarefa agendada "Movimentacoes internas (3009)"), reinicia se cair,
e fica acessível em http://NOME-DO-SERVIDOR:3009. Log: `logs\servidor.log`.
O servidor precisa enxergar os bancos das lojas listadas em `LOJAS` (mesma rede do Relatório gerencial).
Para atualizar: copie os arquivos novos e rode o `instalar.bat` de novo.
Para remover: `servidor\desinstalar.bat` (não apaga dados).

## O que a página mostra

- **Filtros:** mês e ano (abre sempre no mês atual), setor, motivo e depósito. Com mais de uma loja em `LOJAS`, aparece também o filtro de loja.
- **Setor × depósito:** os códigos das movimentações (Nº) na frente de cada setor, o valor de cada depósito e os totais
  por linha e por coluna. Mostra o consumo e as demais saídas, menos as que têm tabela própria. Tem botão **CSV**.
- **Avarias, Lanche dos funcionários, Marmitas, Desagregações e Saídas para transferências:** uma tabela no mesmo formato para cada uma
  (as marmitas separadas em funcionários e obra). Somando todas as tabelas, chega-se ao total do mês, sem contar nada duas vezes.
- **Abrir as linhas:** clicar num setor mostra a divisão por tipo — **Retirada**, **Aproveitamento**, **Funcionários**
  (almoço, lanche e marmitas dos funcionários), Vencimento, Transferência... — com códigos, valor por depósito e % do setor.
  Clicar num tipo mostra cada movimentação (data e motivo do sistema). **Expandir tudo** abre todas as linhas da tabela.
  O CSV traz uma linha por setor e uma por tipo (coluna "Tipo").
- **Relação de movimentações:** no formato da planilha — Nº, depósitos, motivo, setor, valor por depósito e total.
  Clicar numa movimentação abre os produtos. Tem busca (nº, produto ou motivo), ordenação e **CSV** com os produtos.

O servidor só busca o mês. Os outros filtros são feitos no navegador, sem nova consulta.
O botão **Atualizar** ignora o cache (15 minutos) e consulta o banco de novo.

## Regras

| Item | Regra |
|---|---|
| Saída | `Movimentacao_Item` com motivo de saída (`Mov_Desc.E_S = 'S'`); movimentação cancelada fica fora |
| Data | `Movimentacao.Data` |
| Nº | `Movimentacao.Codigo` |
| Valor | `Qtde × Preco_Custo` do item da movimentação |
| Depósito | **grupo do produto**, não o depósito do sistema: Hortifruti (HORTIFRUT, FRUTAS), Açougue, Lanchonete, Cozinha, Confeitaria. Todo o resto é **Loja** |
| Motivo e setor | pela descrição do motivo no sistema. Ex.: "RETIRADA PARA COZINHA" → Consumo / Cozinha; "AVARIAS FLV" → Avaria / Hortifruti; "MARMITAS" → Venda / Cozinha |

Tudo isso fica em `config/regras.json`, sem precisar mexer no código:

- `depositos`: quais grupos de produto formam cada depósito (a ordem é a das colunas e das cores).
- `motivos`: lista de regras "se a descrição contém X → motivo, setor". Vale a primeira que bater.
  Motivo sem regra aparece com a descrição do sistema e setor "Outros".
  Com `"quadro"`, a saída vai para aquela tabela separada; com `"linha"`, a linha da tabela usa esse rótulo em vez do setor.
  `"tipo"` é a segmentação ao abrir uma linha (Retirada, Funcionários...); sem ele, vale o motivo.
- `quadros`: as tabelas separadas e a ordem em que aparecem. Para criar uma nova, acrescente o nome aqui e use-o no `"quadro"` das regras.

As descrições são comparadas sem acento e sem diferenciar maiúsculas, porque os códigos de grupo e de motivo mudam entre lojas.

## Onde fica cada coisa

```
app.py                  servidor web (rotas e cache por loja/mês)
painel/config.py        lê .env e config/regras.json
painel/banco.py         consultas somente leitura (READ UNCOMMITTED, rollback no fim)
painel/relatorio.py     SQL das saídas + regras de depósito, motivo e setor
config/regras.json      lojas, depósitos e regras de motivo/setor. Sem senhas
web/                    página, CSS e JS. É a única pasta entregue ao navegador
```

## Segurança

- Senhas e usuários do banco ficam só no `.env` (fora do git e do navegador). Copie `.env.example` para `.env` e preencha.
- Só são servidas a página e `web/assets`; `.env`, `config/` e o código respondem 404.
- Não tem login: mantenha o acesso restrito à rede interna.
