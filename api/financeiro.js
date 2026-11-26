// DRE + plano de contas + CRUD de lançamentos manuais + sync diário.
// Fundido num arquivo só (antes: api/financeiro.js + api/financeiro-sync-diario.js)
// pra caber no limite de 12 Serverless Functions do plano Hobby da Vercel — ver
// CLAUDE.md "Vercel serverless — limitações". O sync diário roda agora via
// `?acao=sync-diario` (antes era o arquivo inteiro) — ver vercel.json (crons).
//
// Nota sobre o sync diário (GET /caixa): devolve 403 com a conexão OAuth atual
// — testado ao vivo, a lista de "roles" do token de acesso não inclui nenhuma
// de caixa/extrato. Por isso NÃO existe aqui uma fase "caixa" separada e barata
// (uma chamada por categoria) como foi pensado antes de testar. Em vez disso:
//   - Receita (grupos 1.xx) vem de contas-receber, pelo mês de EMISSÃO
//     (dataCompetencia nunca vem preenchida em contas a receber na prática —
//     confirmado ao vivo em várias notas pagas; emissão já é a competência de
//     uma venda, então nem precisa de janela alargada aqui).
//   - Imposto sobre venda (5.01) e despesas/CMV (2.xx/3.xx/4.xx) vêm de
//     contas-pagar, numa janela alargada por vencimento (±1 mês), com detalhe
//     por título decidindo o mês real: dataCompetencia pro imposto,
//     dataLiquidacao (data em que foi de fato pago) pra despesa.
const https = require("https");
const { getAccessToken } = require("./_lib/olist-auth");
const { getConfigEmpresa } = require("./_lib/empresas");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

function httpsRequest(method, hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method, headers }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
// O ritmo entre chamadas era 600ms (~100/min), calibrado pro limite assumido
// de 120/min — só que o limite REAL da conta (header `x-limit-api` na V2,
// confirmado ao vivo em 2026-11-26 pras duas empresas) é 60/min. 600ms
// rodava ~70% mais rápido do que a conta permite, todo santo dia,
// independente de qualquer bloqueio pontual — ver PACE_MS abaixo.
const PACE_MS = 1050; // 60/min = 1000ms exatos; folga de 50ms de margem
// Olist diz "aguarde alguns minutos" nesse erro (429 na V3, ou "API Bloqueada"
// no corpo da V2) — mas o loop tentava de novo em só 600ms, o que mantinha o
// bloqueio ativo pelo resto do orçamento inteiro, em vez de dar o tempo que a
// própria Olist pede. Qualquer catch que bata nesse padrão insere uma pausa
// bem maior antes do próximo item, pras chamadas seguintes terem chance real
// de passar (achado em produção, 2026-11-26 — centenas de 429 por dia desde
// 2026-11-23, sempre no mesmo ritmo de 600ms).
const PADRAO_BLOQUEIO_OLIST = /HTTP 429|API Bloqueada|Excedido o n.mero de acessos/i;
async function pausaSeBloqueio(erro, contexto) {
  if (PADRAO_BLOQUEIO_OLIST.test(erro?.message || "")) {
    console.error(`[financeiro-sync] bloqueio da Olist detectado (${contexto}), pausando 15s`);
    await sleep(15000);
  }
}
function parseJSON(text) { try { return JSON.parse(text); } catch { return {}; } }
function parseBody(reqBody) {
  if (!reqBody) return {};
  if (typeof reqBody === "object") return reqBody;
  if (typeof reqBody === "string") return parseJSON(reqBody);
  return {};
}

const supaHeaders = {
  apikey: SUPABASE_KEY,
  Authorization: "Bearer " + SUPABASE_KEY,
  "Content-Type": "application/json",
};
function supaHost() { return SUPABASE_URL.replace("https://", ""); }

// ============================================================================
// DRE + plano de contas + CRUD manual (antigo api/financeiro.js)
// ============================================================================

// --- estrutura fixa do DRE (ver plano: "Plano de contas") ---
// sinal: como o bloco entra no resultado acumulado. subtotalNome: o rótulo do
// subtotal exibido IMEDIATAMENTE DEPOIS deste bloco (null = não fecha subtotal).
const ESTRUTURA_DRE = [
  { bloco: "Receita Bruta", linhas: ["receita_bruta"], sinal: 1, subtotalNome: null },
  { bloco: "Deduções da Receita Bruta", linhas: ["deducao_receita_bruta"], sinal: -1, subtotalNome: "Receita Líquida" },
  { bloco: "Custo da Mercadoria/Serviço Vendido", linhas: ["custo_mercadoria"], sinal: -1, subtotalNome: "Lucro Bruto" },
  {
    bloco: "Despesas Operacionais",
    linhas: ["despesa_marketing", "despesa_vendas_diretas", "custos_comerciais", "despesa_fretes",
      "despesa_infraestrutura", "despesa_pessoal", "despesa_estoque_armazenamento", "despesa_veiculos",
      "outras_despesas_operacao"],
    sinal: -1, subtotalNome: "Resultado Antes de Juros",
  },
  { bloco: "Despesas Financeiras (Juros)", linhas: ["despesa_endividamento"], sinal: -1, subtotalNome: "Lucro Líquido" },
  { bloco: "Distribuição de Lucro", linhas: ["distribuicao_lucro"], sinal: -1, subtotalNome: "Resultado do Período" },
];

async function buscarPlanoContas() {
  const r = await httpsRequest("GET", supaHost(),
    "/rest/v1/financeiro_plano_contas?select=codigo_grupo,descricao_grupo,linha_dre,ordem,regime,entra_dre,fonte_tiny&order=ordem.asc",
    null, supaHeaders);
  return parseJSON(r.text);
}

async function buscarMensal(empresas, ano, mes) {
  const filtroEmpresa = empresas.length === 1 ? `empresa=eq.${empresas[0]}` : `empresa=in.(${empresas.join(",")})`;
  const r = await httpsRequest("GET", supaHost(),
    `/rest/v1/financeiro_mensal?${filtroEmpresa}&ano=eq.${ano}&mes=eq.${mes}&select=empresa,codigo_grupo,categoria_id,origem,regime,valor,titulo_tipo,titulo_id,intercompany,descricao,historico,data_emissao,data_pagamento`,
    null, supaHeaders);
  return parseJSON(r.text);
}

// Nível 3 do DRE (ver CLAUDE.md "árvore de nível 3"): categoria_id já carrega
// o código de 3 níveis da própria Tiny (ex: "1.01.03 Serviços prestados"),
// extraído como codigo_leaf/descricao_raw em financeiro_categorias — uma
// leitura por empresa (categoria_id é um ID da conta Olist daquela empresa,
// então não dá pra misturar entre rampa/tf no consolidado).
async function buscarCategoriasPorEmpresa(empresas) {
  const porEmpresa = {};
  const leavesPorGrupo = {}; // { [codigo_grupo]: Set<descricao_raw> } — todas as subcategorias conhecidas, pra sempre aparecerem na árvore (mesmo com R$0) em ordem numérica.
  for (const empresa of empresas) {
    const r = await httpsRequest("GET", supaHost(),
      `/rest/v1/financeiro_categorias?empresa=eq.${empresa}&select=categoria_id,descricao_raw,codigo_grupo`, null, supaHeaders);
    const linhas = parseJSON(r.text);
    const mapa = {};
    (Array.isArray(linhas) ? linhas : []).forEach(l => {
      mapa[l.categoria_id] = l.descricao_raw;
      if (l.codigo_grupo && l.descricao_raw) {
        if (!leavesPorGrupo[l.codigo_grupo]) leavesPorGrupo[l.codigo_grupo] = new Set();
        leavesPorGrupo[l.codigo_grupo].add(l.descricao_raw);
      }
    });
    porEmpresa[empresa] = mapa;
  }
  porEmpresa.__leavesPorGrupo = leavesPorGrupo;
  return porEmpresa;
}
// Rótulo da subcategoria (nível 3) de uma linha de financeiro_mensal/manuais.
// Nem toda linha tem categoria_id (CMV vem do item da nota, não de uma
// categoria financeira; histórico é um fallback sem categoria na Tiny) —
// essas ganham um rótulo sintético em vez de ficarem sem nível 3.
function resolverLeaf(l, categoriasPorEmpresa) {
  if (l.categoria_id != null) {
    const descricao = categoriasPorEmpresa[l.empresa]?.[l.categoria_id];
    if (descricao) return descricao;
  }
  if (l.titulo_tipo === "cmv") return "Custo calculado pela nota (sem categoria)";
  if (l.origem === "tiny_historico") return "Classificado por histórico (sem categoria na Tiny)";
  if (l.subitem) return l.subitem; // lançamento manual
  return "Sem subcategoria";
}

async function buscarManuais(empresas, ano, mes) {
  const filtroEmpresa = empresas.length === 1 ? `empresa=eq.${empresas[0]}` : `empresa=in.(${empresas.join(",")})`;
  const r = await httpsRequest("GET", supaHost(),
    `/rest/v1/financeiro_lancamentos_manuais?${filtroEmpresa}&ano=eq.${ano}&mes=eq.${mes}&select=*&order=codigo_grupo.asc`,
    null, supaHeaders);
  return parseJSON(r.text);
}

// Cada grupo/linha/bloco guarda {operacional, intercompany} em vez de um valor
// só — ver CLAUDE.md "Intercompany Rampa↔TF". `valor`/`total`/`resultadoFinal`
// continuam somando os dois (operacional + intercompany), sem mudar o que já
// existia; os campos novos (*Operacional/*Intercompany) são só a abertura.
function montarDRE(planoContas, linhasMensal, linhasManuais, categoriasPorEmpresa, alocacoesOrigem, alocacoesDestino) {
  alocacoesOrigem = alocacoesOrigem || {};
  alocacoesDestino = alocacoesDestino || [];
  const porGrupo = {}; // { [codigo_grupo]: {operacional, intercompany} }
  const porGrupoLeaf = {}; // { [codigo_grupo]: { [descricaoLeaf]: {operacional, intercompany} } }
  const naoClassificado = { total: 0, qtd: 0, itens: [] };

  // Semeia toda subcategoria conhecida (financeiro_categorias) com R$0 — assim
  // ela sempre aparece na árvore de nível 3, na posição numérica certa, mesmo
  // sem nenhum lançamento no mês (decisão do Rafael, 2026-11-24: evita que uma
  // conta como "1.01.02 Produtos vendidos (PDV)" simplesmente suma da lista
  // quando não teve movimento, em vez de aparecer como R$0,00).
  const leavesPorGrupo = categoriasPorEmpresa.__leavesPorGrupo || {};
  for (const [grupo, descricoes] of Object.entries(leavesPorGrupo)) {
    porGrupoLeaf[grupo] = {};
    for (const descricao of descricoes) {
      porGrupoLeaf[grupo][descricao] = { operacional: 0, intercompany: 0 };
    }
  }

  function somar(grupo, valor, intercompany, leaf) {
    if (!porGrupo[grupo]) porGrupo[grupo] = { operacional: 0, intercompany: 0 };
    if (intercompany) porGrupo[grupo].intercompany += valor;
    else porGrupo[grupo].operacional += valor;

    if (!porGrupoLeaf[grupo]) porGrupoLeaf[grupo] = {};
    if (!porGrupoLeaf[grupo][leaf]) porGrupoLeaf[grupo][leaf] = { operacional: 0, intercompany: 0 };
    if (intercompany) porGrupoLeaf[grupo][leaf].intercompany += valor;
    else porGrupoLeaf[grupo][leaf].operacional += valor;
  }

  for (const l of linhasMensal) {
    const valor = Number(l.valor) || 0;
    if (!l.codigo_grupo) {
      naoClassificado.total += valor;
      naoClassificado.qtd += 1;
      naoClassificado.itens.push({
        empresa: l.empresa, categoria_id: l.categoria_id,
        categoriaRaw: categoriasPorEmpresa[l.empresa]?.[l.categoria_id] || null,
        origem: l.origem, titulo_tipo: l.titulo_tipo, titulo_id: l.titulo_id, valor,
        intercompany: !!l.intercompany, descricao: l.descricao, historico: l.historico,
        data_emissao: l.data_emissao, data_pagamento: l.data_pagamento,
      });
      continue;
    }
    const aloc = l.titulo_tipo === "pagar" ? alocacoesOrigem[`${l.titulo_tipo}:${l.titulo_id}`] : null;
    if (aloc) {
      // Redesenho 2026-11-24 (decisão do Rafael): Operacional sempre mostra o
      // valor BRUTO lançado na empresa, sem split — Intercompany vira um
      // ajuste com SINAL (negativo aqui, na origem que pagou), e o Total
      // (Operacional + Intercompany) é que reflete o real da empresa depois
      // da realocação. Ver "intercompany MANUAL (despesas)" acima.
      const leaf = resolverLeaf(l, categoriasPorEmpresa);
      const alocado = Math.min(Number(aloc.valor_alocado) || 0, valor);
      somar(l.codigo_grupo, valor, false, leaf);
      if (alocado > 0) somar(l.codigo_grupo, -alocado, true, leaf);
    } else if (l.intercompany) {
      // Venda/CMV automático Rampa→TF (grupos 1.01/4.01): Real sempre mostra o
      // valor cheio, igual uma venda normal (pedido do Rafael, 2026-11-24) — e
      // o ajuste intercompany entra com o valor NEGADO (não só "não invertido"
      // como antes) pras duas linhas, receita e CMV. Como a Rampa vende pra TF
      // abaixo do custo, isso faz a coluna Intercompany do bloco Lucro Bruto
      // (receita negada − CMV negado, com o sinal -1 do bloco de CMV) virar
      // POSITIVA — o espelho do resultado real negativo que fica na coluna
      // Real — e a coluna Ajustado (Real+Intercompany) zera pra essas linhas,
      // já que o efeito é todo absorvido pela relação entre as empresas.
      const leaf = resolverLeaf(l, categoriasPorEmpresa);
      somar(l.codigo_grupo, valor, false, leaf);
      somar(l.codigo_grupo, -valor, true, leaf);
    } else {
      somar(l.codigo_grupo, valor, false, resolverLeaf(l, categoriasPorEmpresa));
    }
  }
  // Entradas sintéticas da alocação intercompany: dinheiro que, pela
  // alocação manual, é desta empresa mesmo tendo sido pago pela outra — não
  // existe nenhuma linha real em financeiro_mensal pra isso, por isso entra
  // direto aqui, na categoria de destino escolhida (ver
  // buscarAlocacoesParaDestino). Nunca passado em modo consolidado (ver
  // acao=dre) — lá o título real da origem já conta o valor cheio uma vez só,
  // e somar de novo aqui duplicaria.
  for (const a of alocacoesDestino) {
    if (!a.codigo_grupo_destino || !(a.valor > 0)) continue;
    // leaf_destino (nível 3, escolhido no modal — ver "intercompany: categoria de
    // destino no nível 3") é o normal desde 2026-11-24; o fallback cobre só as
    // poucas alocações migradas do desenho antigo, que nunca tiveram leaf.
    const leaf = a.leaf_destino || a.nota || `Intercompany de ${String(a.empresa_origem || "").toUpperCase()} — ${a.descricaoOrigem || a.historicoOrigem || "despesa"}`;
    somar(a.codigo_grupo_destino, a.valor, true, leaf);
  }
  for (const l of linhasManuais) {
    if (!l.codigo_grupo) continue;
    // Lançamentos manuais (provisões/ajustes) nunca são intercompany — esse
    // esquema só existe pra lançamentos que vêm da Olist (nota de venda da
    // Rampa pra TF, ou despesa marcada manualmente num título real).
    somar(l.codigo_grupo, Number(l.valor) || 0, false, l.subitem || "Lançamento manual");
  }

  const porLinhaDre = {}; // { [linha_dre]: {operacional, intercompany} }
  const gruposPorLinhaDre = {};
  for (const grupo of planoContas) {
    if (!grupo.entra_dre) continue;
    const valores = porGrupo[grupo.codigo_grupo] || { operacional: 0, intercompany: 0 };
    if (!porLinhaDre[grupo.linha_dre]) porLinhaDre[grupo.linha_dre] = { operacional: 0, intercompany: 0 };
    porLinhaDre[grupo.linha_dre].operacional += valores.operacional;
    porLinhaDre[grupo.linha_dre].intercompany += valores.intercompany;
    const leafs = Object.entries(porGrupoLeaf[grupo.codigo_grupo] || {})
      .map(([descricao, v]) => ({
        descricao, valor: v.operacional + v.intercompany,
        valorOperacional: v.operacional, valorIntercompany: v.intercompany,
      }))
      .sort((a, b) => {
        // Ordem numérica da conta (1.01.01, 1.01.02, 1.01.03, 1.01.04...) —
        // antes ordenava por valor absoluto, o que colocava "1.01.04 (-)
        // Devoluções" antes de "1.01.03 Serviços prestados" sempre que a
        // devolução fosse maior em módulo do que o serviço. Leaf sem código
        // numérico na descrição (CMV, histórico, lançamento manual, "sem
        // subcategoria") não tem como ordenar por conta — fica depois das
        // que têm, por valor absoluto entre si (comportamento antigo).
        const codigoA = /^(\d+(?:\.\d+)*)/.exec(a.descricao)?.[1];
        const codigoB = /^(\d+(?:\.\d+)*)/.exec(b.descricao)?.[1];
        if (codigoA && codigoB) {
          return codigoA.localeCompare(codigoB, undefined, { numeric: true });
        }
        if (codigoA) return -1;
        if (codigoB) return 1;
        return Math.abs(b.valor) - Math.abs(a.valor);
      });
    (gruposPorLinhaDre[grupo.linha_dre] = gruposPorLinhaDre[grupo.linha_dre] || []).push({
      codigo_grupo: grupo.codigo_grupo, descricao_grupo: grupo.descricao_grupo,
      valor: valores.operacional + valores.intercompany,
      valorOperacional: valores.operacional, valorIntercompany: valores.intercompany,
      leafs,
    });
  }

  let acumulado = 0, acumuladoOperacional = 0, acumuladoIntercompany = 0;
  const blocos = ESTRUTURA_DRE.map(def => {
    const grupos = def.linhas.flatMap(ld => gruposPorLinhaDre[ld] || []);
    const totalOperacional = def.linhas.reduce((s, ld) => s + (porLinhaDre[ld]?.operacional || 0), 0);
    const totalIntercompany = def.linhas.reduce((s, ld) => s + (porLinhaDre[ld]?.intercompany || 0), 0);
    const total = totalOperacional + totalIntercompany;
    acumulado += def.sinal * total;
    acumuladoOperacional += def.sinal * totalOperacional;
    acumuladoIntercompany += def.sinal * totalIntercompany;
    return {
      bloco: def.bloco, sinal: def.sinal, total, totalOperacional, totalIntercompany, grupos,
      subtotalNome: def.subtotalNome,
      subtotalValor: def.subtotalNome ? acumulado : null,
      subtotalOperacional: def.subtotalNome ? acumuladoOperacional : null,
      subtotalIntercompany: def.subtotalNome ? acumuladoIntercompany : null,
    };
  });

  return {
    blocos, resultadoFinal: acumulado,
    resultadoFinalOperacional: acumuladoOperacional, resultadoFinalIntercompany: acumuladoIntercompany,
    naoClassificado,
  };
}

// ============================================================================
// Sync diário (antigo api/financeiro-sync-diario.js) — acionado via
// ?acao=sync-diario, nunca chamado pelo frontend (só pelo cron no vercel.json).
// ============================================================================

const ORCAMENTO_TOTAL_MS = 280000; // folga sob os 300s de maxDuration (vercel.json)
const MAX_TENTATIVAS_POR_TITULO = 3;
const SALVAR_PROGRESSO_A_CADA = 20;
// Mesmo raciocínio do estoque: precisa ser bem maior que o intervalo do cron
// diário (~24h), senão uma execução que precisa de vários dias pra terminar
// nunca termina (recomeça do zero todo dia antes de acabar).
const TRAVADO_APOS_MS = 36 * 60 * 60 * 1000;

function mesAlvoAnterior(ano, mes) {
  return mes === 1 ? { ano: ano - 1, mes: 12 } : { ano, mes: mes - 1 };
}
function formatarYYYYMM(ano, mes) { return `${ano}-${String(mes).padStart(2, "0")}`; }
function formatarData(ano, mes, dia) { return `${ano}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`; }
function addMeses(ano, mes, delta) {
  const total = ano * 12 + (mes - 1) + delta;
  return { ano: Math.floor(total / 12), mes: (total % 12) + 1 };
}
// new Date(ano, mes, 0) usa mes como índice do MÊS SEGUINTE (Date é 0-indexed) —
// dia 0 desse mês seguinte é o último dia do mês humano "mes".
function ultimoDiaDoMes(ano, mes) { return new Date(ano, mes, 0).getDate(); }
function formatarDataBR(ano, mes, dia) { return `${String(dia).padStart(2, "0")}/${String(mes).padStart(2, "0")}/${ano}`; }
function dataBRparaISO(dataBR) {
  if (!dataBR) return null;
  const [dia, mes, ano] = String(dataBR).split("/");
  return dia && mes && ano ? `${ano}-${mes}-${dia}` : null;
}

// --- intercompany Rampa↔TF ---
// Rampa vende pra TF abaixo do custo; em contrapartida a TF paga algumas
// despesas da Rampa (e, mais raro, o inverso também acontece). Decisão do
// Rafael (2026-11-21): separar esses lançamentos numa coluna própria no DRE
// das duas empresas, sem mudar o total que já existia (total = operacional +
// intercompany — ver montarDRE).
//   - Receita/CMV da Rampa: automático — toda nota de venda pro cliente TF
//     (cadastro na Tiny da Rampa: "TF COMERCIO E SERVICOS LTDA", id 893415936,
//     CNPJ 51.251.441/0001-05) marca intercompany=true sozinho, todo sync.
//   - Despesas de QUALQUER empresa (titulo_tipo=pagar): nunca automático —
//     não tem padrão (nome de fornecedor varia) — só manual. Desde 2026-11-24
//     isso não é mais um boolean tudo-ou-nada em financeiro_mensal.intercompany
//     (esse campo, pra titulo_tipo=pagar, não é mais lido em lugar nenhum — só
//     continua valendo pro caso automático de receita/CMV acima): vive na
//     tabela financeiro_intercompany_alocacoes (ver "intercompany MANUAL
//     (despesas)", mais abaixo), que permite valor PARCIAL do título e deixa
//     escolher em qual categoria esse valor entra na outra empresa — e
//     injeta esse valor de fato no DRE da outra empresa (ver montarDRE).
//     Por isso o campo `intercompany` nunca entra no payload do lote nos
//     dois ramos de contas-pagar do sync: fica de fora do upsert, que
//     preserva o que já tiver no banco (ver "Bug de acumulação" — upsert com
//     merge-duplicates só sobrescreve coluna que estiver no payload) — hoje
//     isso só importa porque o campo nunca é tocado ali de propósito, não
//     porque algo ainda dependa do valor que ele guarda pra titulo_tipo=pagar.
const CNPJ_TF = "51251441000105";
function limparCnpj(v) { return String(v || "").replace(/\D/g, ""); }

// --- intercompany MANUAL (despesas) — redesenho 2026-11-24, decisão do Rafael ---
// O boolean `intercompany` em financeiro_mensal (acima) resolvia só o caso
// automático (receita/CMV da Rampa) e, pro caso manual, só permitia tudo ou
// nada (o título inteiro virava intercompany, sempre na mesma categoria).
// Rafael pediu algo mais rico: marcar só uma PARTE do valor como intercompany,
// escolher em qual categoria esse valor entra na OUTRA empresa, e ver esse
// valor aparecer de fato no DRE da outra empresa (não só desaparecer da
// origem).
// Redesenho 2026-11-24 (decisão do Rafael, depois de usar a v1 acima): o
// Operacional (coluna 1) sempre mostra o valor BRUTO lançado na empresa —
// nunca split —, e o Intercompany (coluna 2) passou a ser um ajuste com
// SINAL: negativo em quem pagou (dinheiro saindo), positivo em quem é de
// fato a despesa (dinheiro entrando). O Total (coluna 3 = col1+col2) é o
// "DRE real" por empresa — na origem ele CAI pelo valor alocado (antes
// ficava igual, só trocava de coluna); no destino, sobe pelo mesmo valor.
// Deliberadamente só pra despesa manual — a receita/CMV automático abaixo
// continua sem mudança (total intocado), Rafael ainda não decidiu se
// aplica esse mesmo modelo lá. Isso vive numa tabela própria (financeiro_intercompany_alocacoes,
// uma linha por título — titulo_tipo sempre 'pagar' na prática, é só despesa
// que não tem como detectar sozinho de qual empresa é de verdade) em vez do
// boolean, que ficou só pro caso automático (nunca usado pra pagar desde essa
// migração — ver CLAUDE.md "Intercompany Rampa↔TF").
function empresaContraria(empresa) { return empresa === "rampa" ? "tf" : "rampa"; }

async function buscarAlocacoesPorOrigem(empresa) {
  const r = await httpsRequest("GET", supaHost(),
    `/rest/v1/financeiro_intercompany_alocacoes?empresa_origem=eq.${empresa}&select=*`, null, supaHeaders);
  const linhas = parseJSON(r.text);
  const mapa = {};
  (Array.isArray(linhas) ? linhas : []).forEach(a => { mapa[`${a.titulo_tipo}:${a.titulo_id}`] = a; });
  return mapa;
}

// Alocações que apontam PRA essa empresa (ela é a empresa_destino) — pra cada
// uma, confirma que o título original ainda cai no mês pedido (lendo o valor
// real dele em financeiro_mensal, do lado da empresa de origem) antes de
// devolver, e já traz descrição/histórico pra exibir. Um título cujo mês
// mudou (reprocessamento) ou que saiu do catálogo simplesmente não aparece
// mais — sem precisar apagar a alocação, ela some e volta sozinha se o título
// voltar a cair no mesmo mês de novo.
async function buscarAlocacoesParaDestino(empresa, ano, mes) {
  const r = await httpsRequest("GET", supaHost(),
    `/rest/v1/financeiro_intercompany_alocacoes?empresa_destino=eq.${empresa}&select=*`, null, supaHeaders);
  const alocacoes = parseJSON(r.text);
  if (!Array.isArray(alocacoes) || !alocacoes.length) return [];
  const resultado = [];
  for (const a of alocacoes) {
    const r2 = await httpsRequest("GET", supaHost(),
      `/rest/v1/financeiro_mensal?empresa=eq.${a.empresa_origem}&titulo_tipo=eq.${a.titulo_tipo}&titulo_id=eq.${a.titulo_id}` +
      `&ano=eq.${ano}&mes=eq.${mes}&select=valor,descricao,historico`, null, supaHeaders);
    const linha = parseJSON(r2.text);
    const origemRow = Array.isArray(linha) ? linha[0] : null;
    if (!origemRow) continue;
    const valorTitulo = Number(origemRow.valor) || 0;
    const valor = Math.min(Number(a.valor_alocado) || 0, valorTitulo);
    if (valor <= 0) continue;
    resultado.push({ ...a, valor, valorTitulo, descricaoOrigem: origemRow.descricao, historicoOrigem: origemRow.historico });
  }
  return resultado;
}

// --- CMV (custo da mercadoria vendida): itens de nota de venda × custo do produto ---
// Ver CLAUDE.md "Módulo Financeiro (DRE)" — grupos 4.01/4.02 antes vinham de
// contas-pagar (pagamento de compra), o que o Rafael pediu pra tirar do DRE
// (2026-11-20): compra não é custo da venda. O cálculo certo é por nota
// emitida: quantidade vendida × custo do produto na Tiny. Só cobre 4.01
// (Estoques) por enquanto — 4.02 (Insumos de Serviços) continua manual.
//
// Custo do produto: NUNCA busca na Olist aqui — vem de estoque_catalogo
// (coluna custo_atual, já capturada de graça pelo sync diário de Estoque, ver
// api/estoque-sync-diario.js) mais a tabela financeiro_custo_mensal, que
// congela o custo por produto/mês (2026-11-22, correção de bug real):
//   - mês atual (ainda aberto): usa sempre custo_atual (o mês ainda não tem
//     "custo final", é esperado seguir o que estiver na Tiny agora).
//   - mês anterior (ainda dentro da janela de 2 meses reprocessada): usa o
//     custo CONGELADO desse produto nesse mês/empresa, se já existir; se não
//     existir ainda (primeira vez que esse produto aparece no mês anterior),
//     congela agora com o custo_atual do momento e nunca mais toca nisso —
//     auto-recuperável contra cron perdido, sem depender de cair exatamente
//     no último dia do mês. Isso evita o bug original: mudar o custo de um
//     produto em novembro não pode retroagir e mudar o CMV de outubro, que já
//     foi fechado com o custo que era real em outubro.
//
// Produto sem custo cadastrado conta como custo 0 nesse item (em vez de
// travar o cálculo todo) — enquanto o cadastro de custos não estiver completo
// na Tiny, o CMV fica subestimado, não errado por estimativa.
const SITUACOES_INVALIDAS_NOTA_VENDA_V2 = ["1", "3", "5", "10"]; // Pendente, Cancelada, Rejeitada, Denegada
// Mesmos códigos de `_lib/relatorio-coleta.js` (duplicado aqui de propósito,
// mesmo padrão de pequena duplicação já existente entre api/*.js — ver
// CLAUDE.md). Nota "S" (saída) com uma dessas finalidades = devolução de
// COMPRA (mercadoria saindo de volta pro fornecedor); nota "E" (entrada) =
// devolução de VENDA (cliente devolvendo) — mesma lógica já usada no
// Relatório de Vendas, só que lá só a direção "E" importava.
const FINALIDADES_DEVOLUCAO = ["4", "7", "8"];
function ehErroSemResultadosV2(erro) {
  return String(erro?.erros?.[0]?.erro || "").toLowerCase().includes("não retornou");
}
async function listarNotasFiscaisV2(tokenV2, tipoNota, dataInicialBR, dataFinalBR) {
  const todas = [];
  let pagina = 1;
  while (true) {
    const body = new URLSearchParams({
      token: tokenV2, formato: "JSON", tipoNota,
      dataInicial: dataInicialBR, dataFinal: dataFinalBR, pagina: String(pagina),
    }).toString();
    const r = await httpsRequest("POST", "api.tiny.com.br", "/api2/notas.fiscais.pesquisa.php", body,
      { "Content-Type": "application/x-www-form-urlencoded" });
    const data = parseJSON(r.text);
    if (data.retorno?.status === "Erro") {
      if (ehErroSemResultadosV2(data.retorno)) break;
      throw new Error(data.retorno.erros?.[0]?.erro || "Erro ao pesquisar notas fiscais");
    }
    const lista = (data.retorno?.notas_fiscais || []).map(n => n.nota_fiscal).filter(Boolean);
    todas.push(...lista);
    if (lista.length < 100) break;
    pagina++;
    await sleep(PACE_MS);
  }
  return todas.filter(n => !SITUACOES_INVALIDAS_NOTA_VENDA_V2.includes(String(n.situacao)));
}
async function buscarDetalheNotaVendaV2(tokenV2, id) {
  const body = new URLSearchParams({ token: tokenV2, id: String(id), formato: "JSON" }).toString();
  const r = await httpsRequest("POST", "api.tiny.com.br", "/api2/nota.fiscal.obter.php", body,
    { "Content-Type": "application/x-www-form-urlencoded" });
  const data = parseJSON(r.text);
  if (data.retorno?.status === "Erro") {
    throw new Error(data.retorno.erros?.[0]?.erro || `erro ao obter nota ${id}`);
  }
  return data.retorno?.nota_fiscal || null;
}

// --- receita: data de emissão da NF (não da parcela) + exclusão de notas de
// "apoio em vendas" (ver CLAUDE.md "Receita classificada pela parcela..." e
// "Comissão de apoio em vendas...") ---

// Custo atual de cada produto do catálogo (coluna custo_atual, preenchida de
// graça pelo sync diário de Estoque — ver api/estoque-sync-diario.js) — uma
// leitura só no Supabase pra empresa inteira, nada de bater na Olist produto
// a produto aqui (era assim que o antigo buscarCustoProdutoV2 fazia).
async function lerCustoAtualCatalogo(empresa) {
  const mapa = new Map();
  const limit = 1000;
  let offset = 0;
  while (true) {
    const r = await httpsRequest("GET", supaHost(),
      `/rest/v1/estoque_catalogo?empresa=eq.${empresa}&select=produto_id,custo_atual&limit=${limit}&offset=${offset}`,
      null, supaHeaders);
    const linhas = parseJSON(r.text);
    if (!Array.isArray(linhas)) break;
    linhas.forEach(l => mapa.set(Number(l.produto_id), Number(l.custo_atual) || 0));
    if (linhas.length < limit) break;
    offset += limit;
  }
  return mapa;
}
// Custos já congelados do mês anterior (financeiro_custo_mensal) — só esse
// mês precisa, é o único que pode estar "fechando" nesta chamada.
async function lerCustoCongeladoMes(empresa, ano, mes) {
  const mapa = new Map();
  const r = await httpsRequest("GET", supaHost(),
    `/rest/v1/financeiro_custo_mensal?empresa=eq.${empresa}&ano=eq.${ano}&mes=eq.${mes}&select=produto_id,custo`,
    null, supaHeaders);
  const linhas = parseJSON(r.text);
  if (Array.isArray(linhas)) linhas.forEach(l => mapa.set(Number(l.produto_id), Number(l.custo) || 0));
  return mapa;
}
// Grava os congelamentos novos descobertos nesta chamada. ignore-duplicates
// (nunca merge-duplicates): uma vez congelado um produto/mês, a linha é
// definitiva — se outra chamada (do mesmo dia ou de dias seguintes, enquanto
// esse mês ainda for "mês anterior") tentar congelar de novo, o insert é
// ignorado e o valor original permanece intocado.
async function salvarCongelamentos(novosCongelamentos) {
  if (!novosCongelamentos.size) return;
  const payload = JSON.stringify([...novosCongelamentos.values()]);
  await httpsRequest("POST", supaHost(), "/rest/v1/financeiro_custo_mensal?on_conflict=empresa,produto_id,ano,mes", payload,
    { ...supaHeaders, "Content-Length": Buffer.byteLength(payload), Prefer: "resolution=ignore-duplicates,return=minimal" });
  novosCongelamentos.clear();
}
// Calcula o CMV de uma nota (soma quantidade × custo de cada item) e devolve
// também quantos itens ficaram sem custo cadastrado, só pra log/diagnóstico.
// `obterCusto(idProduto)` resolve o custo certo (atual ou congelado, ver
// comentário acima sobre congelamento) — nunca busca nada na Olist aqui.
async function calcularCmvNota(tokenV2, idNota, obterCusto) {
  const nota = await buscarDetalheNotaVendaV2(tokenV2, idNota);
  let valor = 0, semCusto = 0, totalItens = 0;
  for (const itWrap of (nota?.itens || [])) {
    const it = itWrap?.item;
    const idProduto = it?.id_produto;
    const quantidade = Number(it?.quantidade) || 0;
    if (!it) continue;
    totalItens++;
    if (!idProduto) { semCusto++; continue; }
    const custo = obterCusto(idProduto);
    if (!custo) { semCusto++; continue; }
    valor += quantidade * custo;
  }
  const intercompanyTF = limparCnpj(nota?.cliente?.cpf_cnpj) === CNPJ_TF;
  return { valor, semCusto, totalItens, intercompanyTF, clienteNome: nota?.cliente?.nome || null };
}

// --- classificação por histórico (fallback pra título sem categoria na Tiny) ---
// Só cobre o grupo 5.01 (impostos sobre a venda) — caso real visto em
// 2026-11-20: categorias de imposto criadas na Tiny só nessa data, títulos
// pagos antes continuam com categoria=null. NUNCA usar isso pro grupo 5.02
// (impostos sobre o resultado) — esse é manual de propósito (ver plano).
const PADROES_HISTORICO_5_01 = [
  /\bPIS\b/i, /\bCOFINS\b/i, /\bICMS\b/i, /\bISSQN\b/i, /\bISS\b/i, /SIMPLES\s*NACIONAL/i,
];
function classificarPorHistorico(historico) {
  const texto = String(historico || "");
  return PADROES_HISTORICO_5_01.some(re => re.test(texto)) ? "5.01" : null;
}

// --- status / checkpoint (mesmo padrão de estoque_sync_status) ---

async function lerStatusSync(empresa) {
  const r = await httpsRequest("GET", supaHost(), `/rest/v1/financeiro_sync_status?empresa=eq.${empresa}&select=*`, null, supaHeaders);
  return parseJSON(r.text)?.[0] || null;
}
async function criarStatusSync(empresa) {
  const payload = JSON.stringify({ empresa });
  await httpsRequest("POST", supaHost(), "/rest/v1/financeiro_sync_status?on_conflict=empresa", payload,
    { ...supaHeaders, "Content-Length": Buffer.byteLength(payload), Prefer: "resolution=ignore-duplicates,return=minimal" });
}
async function salvarStatusSync(empresa, status) {
  const payload = JSON.stringify(status);
  await httpsRequest("PATCH", supaHost(), `/rest/v1/financeiro_sync_status?empresa=eq.${empresa}`, payload,
    { ...supaHeaders, "Content-Length": Buffer.byteLength(payload), Prefer: "return=minimal" });
}
// Grava ANTES de qualquer trabalho arriscado (e de novo no catch fatal) —
// mesmo motivo do estoque: sem isso uma falha bem no início não deixa
// rastro nenhum depois que o log da Vercel expira (ver CLAUDE.md).
async function marcarTentativaSync(empresa, erro) {
  await criarStatusSync(empresa);
  const campos = { ultima_tentativa_em: new Date().toISOString() };
  if (erro) campos.ultimo_erro = erro;
  const payload = JSON.stringify(campos);
  await httpsRequest("PATCH", supaHost(), `/rest/v1/financeiro_sync_status?empresa=eq.${empresa}`, payload,
    { ...supaHeaders, "Content-Length": Buffer.byteLength(payload), Prefer: "return=minimal" });
}

// --- plano de contas / categorias (lidos uma vez por execução) ---

async function lerPlanoContasSync() {
  const r = await httpsRequest("GET", supaHost(), "/rest/v1/financeiro_plano_contas?select=codigo_grupo,regime,fonte_tiny", null, supaHeaders);
  const linhas = parseJSON(r.text);
  const mapa = {};
  (Array.isArray(linhas) ? linhas : []).forEach(l => { mapa[l.codigo_grupo] = l; });
  return mapa;
}

async function lerCategoriasMapeadas(empresa) {
  const r = await httpsRequest("GET", supaHost(),
    `/rest/v1/financeiro_categorias?empresa=eq.${empresa}&select=categoria_id,codigo_grupo,codigo_leaf,forca_manual`, null, supaHeaders);
  const linhas = parseJSON(r.text);
  const mapa = {};
  (Array.isArray(linhas) ? linhas : []).forEach(l => { mapa[l.categoria_id] = l; });
  return mapa;
}

// --- categorias ---

async function syncCategorias(empresa, accessToken) {
  const limit = 100;
  let offset = 0;
  let total = 0;
  const linhas = [];
  while (true) {
    const r = await httpsRequest("GET", "api.tiny.com.br",
      `/public-api/v3/categorias-receita-despesa?limit=${limit}&offset=${offset}`,
      null, { Authorization: "Bearer " + accessToken });
    const data = parseJSON(r.text);
    const itens = data.itens || [];
    itens.forEach(it => {
      const grupoMatch = String(it.grupo || "").match(/^(\d+\.\d+)/);
      const leafMatch = String(it.descricao || "").match(/^(\d+\.\d+\.\d+)/);
      linhas.push({
        categoria_id: it.id,
        grupo_raw: it.grupo || null,
        descricao_raw: it.descricao || null,
        codigo_grupo: grupoMatch ? grupoMatch[1] : null,
        codigo_leaf: leafMatch ? leafMatch[1] : null,
        atualizado_em: new Date().toISOString(),
      });
    });
    total = data.paginacao?.total ?? itens.length;
    offset += limit;
    if (itens.length < limit || offset >= total) break;
    await sleep(PACE_MS);
  }
  if (linhas.length) {
    const payload = JSON.stringify(linhas.map(l => ({ ...l, empresa })));
    // forca_manual NÃO entra no payload — upsert não toca nela, preserva o
    // que foi marcado à mão.
    await httpsRequest("POST", supaHost(), "/rest/v1/financeiro_categorias?on_conflict=empresa,categoria_id", payload,
      { ...supaHeaders, "Content-Length": Buffer.byteLength(payload), Prefer: "resolution=merge-duplicates,return=minimal" });
  }
  console.log(`[financeiro-sync:${empresa}] categorias: ${linhas.length} sincronizadas`);
  return linhas.length;
}

// --- upsert na agregação mensal ---

async function upsertMensal(empresa, linhas) {
  if (!linhas.length) return;
  const payload = JSON.stringify(linhas.map(l => ({ ...l, empresa, atualizado_em: new Date().toISOString() })));
  await httpsRequest("POST", supaHost(), "/rest/v1/financeiro_mensal?on_conflict=empresa,titulo_tipo,titulo_id", payload,
    { ...supaHeaders, "Content-Length": Buffer.byteLength(payload), Prefer: "resolution=merge-duplicates,return=minimal" });
}

// Remove um título que passou a ser excluído do DRE (ex: "apoio em vendas"
// classificado depois de já ter sido gravado por uma execução anterior, antes
// dessa exclusão existir) — upsert nunca apaga, só sobrescreve quem ele
// recebe, então sem isso um título excluído hoje continuava com a linha
// antiga parada em financeiro_mensal pra sempre.
async function excluirMensal(empresa, tituloTipo, tituloId) {
  await httpsRequest("DELETE", supaHost(),
    `/rest/v1/financeiro_mensal?empresa=eq.${empresa}&titulo_tipo=eq.${tituloTipo}&titulo_id=eq.${tituloId}`,
    null, { ...supaHeaders, Prefer: "return=minimal" });
}

// --- receita (contas-receber, por emissão = competência de uma venda) ---

async function listarIdsContasReceber(accessToken, dataIni, dataFim) {
  const ids = [];
  const limit = 100;
  let offset = 0;
  while (true) {
    const r = await httpsRequest("GET", "api.tiny.com.br",
      `/public-api/v3/contas-receber?dataInicialEmissao=${dataIni}&dataFinalEmissao=${dataFim}&limit=${limit}&offset=${offset}`,
      null, { Authorization: "Bearer " + accessToken });
    const data = parseJSON(r.text);
    // Mesmo bug já visto em api/estoque.js ("página perdida por rate-limit virava
    // lista vazia, tratada como fim da paginação") — aqui fazia o título simplesmente
    // nunca entrar na fila (nem processado, nem "não classificado"), sem erro nenhum.
    if (r.status !== 200 || !Array.isArray(data.itens)) {
      throw new Error(`contas-receber (listagem offset=${offset}): HTTP ${r.status} - ${r.text.slice(0, 200)}`);
    }
    const itens = data.itens;
    itens.forEach(it => ids.push(it.id));
    const total = data.paginacao?.total ?? itens.length;
    offset += limit;
    if (itens.length < limit || offset >= total) break;
    await sleep(PACE_MS);
  }
  return ids;
}

// --- contas a pagar (imposto sobre venda por competência + despesas por caixa, numa janela larga por vencimento) ---

async function listarIdsContasPagar(accessToken, dataIni, dataFim) {
  const ids = [];
  const limit = 100;
  let offset = 0;
  while (true) {
    const r = await httpsRequest("GET", "api.tiny.com.br",
      `/public-api/v3/contas-pagar?dataInicialVencimento=${dataIni}&dataFinalVencimento=${dataFim}&limit=${limit}&offset=${offset}`,
      null, { Authorization: "Bearer " + accessToken });
    const data = parseJSON(r.text);
    const itens = Array.isArray(data) ? data : data.itens;
    // Mesmo bug de "página perdida por rate-limit virava lista vazia" de
    // listarIdsContasReceber acima — ver comentário lá.
    if (r.status !== 200 || !Array.isArray(itens)) {
      throw new Error(`contas-pagar (listagem offset=${offset}): HTTP ${r.status} - ${r.text.slice(0, 200)}`);
    }
    itens.forEach(it => ids.push(it.id));
    const total = data.paginacao?.total ?? itens.length;
    offset += limit;
    if (itens.length < limit || offset >= total) break;
    await sleep(PACE_MS);
  }
  return ids;
}

// --- receita de Venda Interna (grupo 1.01) direto da nota fiscal, não do
// título de contas a receber (decisão do Rafael, 2026-11-23; generalizada
// pras duas empresas em 2026-11-24 — "qualquer ajuste que tenhamos feito na
// Rampa, vale pra TF também. a lógica é igual") ---
// Caçar título a título os casos que apareciam como "sumidos" (Kalil, Dario
// Neves, Germano Petersen, Castanhel — ver CLAUDE.md "Totais Rampa não
// bateram...") nunca ia ter 100% de confiabilidade, e um ajuste de
// conciliação que só fechava a diferença em dinheiro (tentado antes disso)
// escondia casos novos atrás de um número só. Nenhum desses casos era
// problema na NF — só no título (fora da janela de busca, devolução
// integral sem título correspondente, nota marcada "futura" mas que já é
// entrega de verdade). Decisão do Rafael: nesse primeiro momento o DRE olha
// só nota/faturamento, nunca título — título fica pra quando entrarmos em
// auditoria/balanço. Fonte: relatorio_cache (Relatório de Vendas), já
// multi-empresa (coluna empresa — ver migration de 2026-11-24) e já
// auditado/corrigido (cancelamento, revalidação, buracos de coleta) — não
// refaz nenhuma consulta na Olist aqui.
//   - tipo='produto'   -> leaf 1.01.01 Produtos vendidos (Danfe)
//   - tipo='servico'   -> leaf 1.01.03 Serviços prestados (relatorio_cache já
//     filtra "apoio em vendas" na própria coleta — ver DESCRICOES_SERVICO_EXCLUIDAS
//     em relatorio-coleta.js — então tudo que chega aqui é serviço de verdade,
//     inclusive a nota de R$2.200 que o Rafael confirmou ser 1.01.03)
//   - tipo='devolucao' -> leaf 1.01.04 (-) Devoluções e estornos, negativo —
//     entra como linha própria por NF, nunca abatendo a venda original
//     (decisão do Rafael: "tem que constar 2x, venda e estorno" — ex: Kalil
//     NF 013421 +1620,05 e devolução NF 013429 -1620,05, as duas visíveis)
// titulo_id = id_olist da própria nota (estável e único por tipo — checado
// ao vivo em 2026-11-23: produto/serviço/devolução de outubro, 0 nulos, sem
// duplicata), então o upsert é idempotente por NF, nunca por mês agregado.
// categoria_id de cada leaf é diferente por empresa na Tiny (confirmado ao
// vivo, 2026-11-24: Danfe Rampa=361455283/TF=358506367, Serviços
// Rampa=361455286/TF=358506432, Devoluções Rampa=361455287/TF=360821669) —
// por isso nunca usar um id fixo, sempre resolver pelo codigo_leaf (mesmo
// texto nas duas empresas) contra o `categorias` da empresa em questão.
const CODIGO_GRUPO_VENDA_INTERNA = "1.01";

function categoriaIdPorLeaf(categorias, leaf) {
  for (const [id, info] of Object.entries(categorias)) {
    if (info.codigo_leaf === leaf) return Number(id);
  }
  return null;
}

async function listarRelatorioCache(empresa, tipo, dataIniIso, dataFimIso) {
  const r = await httpsRequest("GET", supaHost(),
    `/rest/v1/relatorio_cache?tipo=eq.${tipo}&empresa=eq.${empresa}&data=gte.${dataIniIso}&data=lte.${dataFimIso}&select=id_olist,valor,cliente_razao_social,cliente_cnpj,data`,
    null, supaHeaders);
  const linhas = parseJSON(r.text);
  return Array.isArray(linhas) ? linhas : [];
}

async function sincronizarReceitaPorNotasFiscais(empresa, periodos, categorias) {
  const categoriaProduto = categoriaIdPorLeaf(categorias, "1.01.01");
  const categoriaServico = categoriaIdPorLeaf(categorias, "1.01.03");
  const categoriaDevolucao = categoriaIdPorLeaf(categorias, "1.01.04");
  for (const p of periodos) {
    // Limpa título de contas a receber que já tenha sido classificado em 1.01
    // numa execução anterior e cujo ID não voltou a aparecer na janela de
    // listarIdsContasReceber desta vez (ex: parcela cuja própria data cai fora
    // da janela mesmo com a NF referenciada dentro do mês — mesmo padrão de
    // borda do caso Germano Petersen, só que aqui sobra em vez de faltar).
    // A exclusão no loop de contas a receber só acontece pra título
    // efetivamente revisitado; sem isso, um título assim duplica a receita
    // pra sempre (título antigo + NF nova) — achado ao vivo em 2026-11-23: 7
    // títulos de outubro (D1 Litoral, Bordini Green, Kalil OC 1852, Termofrax
    // — R$20.911,34) continuaram em "receber" depois do primeiro sync com NF.
    await httpsRequest("DELETE", supaHost(),
      `/rest/v1/financeiro_mensal?empresa=eq.${empresa}&codigo_grupo=eq.${CODIGO_GRUPO_VENDA_INTERNA}` +
      `&titulo_tipo=eq.receber&ano=eq.${p.ano}&mes=eq.${p.mes}`,
      null, { ...supaHeaders, Prefer: "return=minimal" });

    const dataIni = formatarData(p.ano, p.mes, 1);
    const dataFim = formatarData(p.ano, p.mes, ultimoDiaDoMes(p.ano, p.mes));
    const [produtos, servicos, devolucoes] = await Promise.all([
      listarRelatorioCache(empresa, "produto", dataIni, dataFim),
      listarRelatorioCache(empresa, "servico", dataIni, dataFim),
      listarRelatorioCache(empresa, "devolucao", dataIni, dataFim),
    ]);
    // Venda da Rampa pro cliente TF (mesmo CNPJ_TF usado no CMV — ver CLAUDE.md
    // "Intercompany Rampa↔TF") marca intercompany sozinha, igual já fazia o
    // caminho por título — sem isso a receita por NF perderia esse apontamento
    // automático (ex: NF 013495, R$0,50, cliente "TF Comercio e Serviços").
    const linhas = [
      ...produtos.map(l => ({
        ano: p.ano, mes: p.mes, codigo_grupo: CODIGO_GRUPO_VENDA_INTERNA, categoria_id: categoriaProduto,
        origem: "relatorio_cache", regime: "competencia", titulo_tipo: "nf_produto", titulo_id: Number(l.id_olist),
        valor: Number(l.valor) || 0, descricao: l.cliente_razao_social || null, data_emissao: l.data || null,
        intercompany: limparCnpj(l.cliente_cnpj) === CNPJ_TF,
      })),
      ...servicos.map(l => ({
        ano: p.ano, mes: p.mes, codigo_grupo: CODIGO_GRUPO_VENDA_INTERNA, categoria_id: categoriaServico,
        origem: "relatorio_cache", regime: "competencia", titulo_tipo: "nf_servico", titulo_id: Number(l.id_olist),
        valor: Number(l.valor) || 0, descricao: l.cliente_razao_social || null, data_emissao: l.data || null,
        intercompany: limparCnpj(l.cliente_cnpj) === CNPJ_TF,
      })),
      ...devolucoes.map(l => ({
        ano: p.ano, mes: p.mes, codigo_grupo: CODIGO_GRUPO_VENDA_INTERNA, categoria_id: categoriaDevolucao,
        origem: "relatorio_cache", regime: "competencia", titulo_tipo: "devolucao", titulo_id: Number(l.id_olist),
        valor: -(Number(l.valor) || 0), descricao: l.cliente_razao_social || null, data_emissao: l.data || null,
        intercompany: limparCnpj(l.cliente_cnpj) === CNPJ_TF,
      })),
    ];
    if (linhas.length) await upsertMensal(empresa, linhas);
    console.log(`[financeiro-sync:${empresa}] receita por NF ${p.ano}-${p.mes}: ${produtos.length} produto + ${servicos.length} serviço + ${devolucoes.length} devolução`);
  }
}

async function executarSyncDiario(req, res) {
  const empresa = String(req.query.empresa || "rampa").toLowerCase();

  // A Vercel SEMPRE dispara o cron via GET (confirmado na documentação
  // oficial), marcando a chamada com o header `x-vercel-cron-schedule` (não
  // `x-vercel-cron`, que não existe e nunca bateu aqui). Por isso essa
  // checagem tem que vir ANTES da leitura de status abaixo — caso contrário
  // TODO disparo do cron caía no "só lê status" e nunca processava nada
  // (achado em produção, 2026-11-20 — ver CLAUDE.md "Vercel serverless —
  // limitações", mesmo bug do estoque-sync-diario.js).
  const vercelCron = req.headers["x-vercel-cron-schedule"];

  // GET só lê o status (usado por um eventual botão "sincronizar agora" no
  // frontend, igual ao de Estoque) — não dispara processamento. Só entra
  // aqui quando NÃO é o cron de verdade.
  if (!vercelCron && req.method === "GET") {
    try {
      const status = await lerStatusSync(empresa);
      return res.status(200).json({ ok: true, status });
    } catch (e) {
      return res.status(500).json({ erro: e.message });
    }
  }

  if (CRON_SECRET && req.headers.authorization !== `Bearer ${CRON_SECRET}` && !vercelCron) {
    return res.status(401).json({ erro: "não autorizado" });
  }

  const inicioExecucao = Date.now();

  try {
    let status = await lerStatusSync(empresa);
    const ultimaAtividade = status?.ultima_tentativa_em || status?.iniciado_em;
    const iniciadoHaMuito = status?.em_andamento && ultimaAtividade
      && (Date.now() - new Date(ultimaAtividade).getTime() > TRAVADO_APOS_MS);
    await marcarTentativaSync(empresa);

    const accessToken = await getAccessToken(empresa);
    const tokenV2 = getConfigEmpresa(empresa).tokenV2;
    const planoContas = await lerPlanoContasSync();
    const grupoCmv = Object.values(planoContas).find(l => l.fonte_tiny === "notas_fiscais_itens")?.codigo_grupo || null;

    // Categorias são rápidas (uma lista paginada só) — sempre atualiza antes
    // de montar a fila, pra qualquer categoria nova já entrar classificada.
    await syncCategorias(empresa, accessToken);
    const categorias = await lerCategoriasMapeadas(empresa);

    const hoje = new Date();
    const mesAtual = { ano: hoje.getFullYear(), mes: hoje.getMonth() + 1 };
    const mesAnterior = mesAlvoAnterior(mesAtual.ano, mesAtual.mes);
    const periodos = [mesAtual, mesAnterior]; // reprocessa os 2 últimos meses, não assume mês fechado como imutável

    // Custo pro CMV: nunca busca na Olist aqui (ver comentário em cima de
    // calcularCmvNota) — lê o custo atual de todo o catálogo de uma vez e o
    // que já estiver congelado do mês anterior, de uma vez cada.
    const custoAtualPorProduto = grupoCmv ? await lerCustoAtualCatalogo(empresa) : new Map();
    const custoCongeladoMesAnterior = grupoCmv ? await lerCustoCongeladoMes(empresa, mesAnterior.ano, mesAnterior.mes) : new Map();
    const novosCongelamentos = new Map(); // chave produtoId -> linha pra inserir em financeiro_custo_mensal
    function obterCustoProduto(idProduto, ano, mes) {
      const custoAtual = custoAtualPorProduto.get(Number(idProduto)) || 0;
      if (ano !== mesAnterior.ano || mes !== mesAnterior.mes) return custoAtual; // mês atual (aberto): sempre o custo de agora
      if (custoCongeladoMesAnterior.has(Number(idProduto))) return custoCongeladoMesAnterior.get(Number(idProduto));
      // primeira vez que esse produto aparece no mês anterior: congela agora
      // com o custo atual e nunca mais muda (ver salvarCongelamentos).
      custoCongeladoMesAnterior.set(Number(idProduto), custoAtual);
      novosCongelamentos.set(Number(idProduto), { empresa, produto_id: idProduto, ano, mes, custo: custoAtual });
      return custoAtual;
    }

    if (!status || !status.em_andamento || iniciadoHaMuito) {
      const filaReceita = [];
      const filaPagar = [];
      const filaCmv = [];
      for (const p of periodos) {
        const iniEmissao = formatarData(p.ano, p.mes, 1);
        const fimEmissao = formatarData(p.ano, p.mes, ultimoDiaDoMes(p.ano, p.mes));
        const idsReceber = await listarIdsContasReceber(accessToken, iniEmissao, fimEmissao);
        idsReceber.forEach(id => filaReceita.push({ id, ano: p.ano, mes: p.mes }));
        await sleep(PACE_MS);

        // Janela larga por vencimento (mês alvo ±1) pra pegar título cuja
        // competência/liquidação real cai no mês alvo mesmo com vencimento
        // num mês vizinho.
        const jIni = addMeses(p.ano, p.mes, -1);
        const jFim = addMeses(p.ano, p.mes, 1);
        const idsPagar = await listarIdsContasPagar(accessToken, formatarData(jIni.ano, jIni.mes, 1), formatarData(jFim.ano, jFim.mes, ultimoDiaDoMes(jFim.ano, jFim.mes)));
        idsPagar.forEach(id => filaPagar.push({ id, ano: p.ano, mes: p.mes }));
        await sleep(PACE_MS);

        if (grupoCmv) {
          const iniBR = formatarDataBR(p.ano, p.mes, 1);
          const fimBR = formatarDataBR(p.ano, p.mes, ultimoDiaDoMes(p.ano, p.mes));
          const notasVenda = await listarNotasFiscaisV2(tokenV2, "S", iniBR, fimBR);
          notasVenda.forEach(n => filaCmv.push({ id: n.id, ano: p.ano, mes: p.mes, dataEmissaoBR: n.data_emissao }));
          await sleep(PACE_MS);
        }
      }
      // Dedup simples por id+ano+mes (a janela de meses vizinhos pode repetir título em dois períodos-alvo)
      const vistoPagar = new Set();
      const filaPagarUnica = filaPagar.filter(it => {
        const chave = `${it.id}:${it.ano}:${it.mes}`;
        if (vistoPagar.has(chave)) return false;
        vistoPagar.add(chave); return true;
      });

      status = {
        em_andamento: true,
        pendentes: { receita: filaReceita, pagar: filaPagarUnica, cmv: filaCmv },
        total: filaReceita.length + filaPagarUnica.length + filaCmv.length,
        processados: 0,
        iniciado_em: new Date().toISOString(),
        concluido_em: null,
        ultimo_erro: null,
      };
      await salvarStatusSync(empresa, status);
      console.log(`[financeiro-sync:${empresa}] execução nova: ${filaReceita.length} contas a receber + ${filaPagarUnica.length} contas a pagar + ${filaCmv.length} notas de venda (cmv) a classificar`);
    } else {
      console.log(`[financeiro-sync:${empresa}] retomando: ${status.pendentes.receita.length} receber + ${status.pendentes.pagar.length} pagar + ${(status.pendentes.cmv || []).length} cmv pendentes`);
    }

    const filaReceita = [...status.pendentes.receita];
    const filaPagar = [...status.pendentes.pagar];
    const filaCmv = [...(status.pendentes.cmv || [])]; // (|| []) cobre execução que ficou em_andamento de antes desse campo existir
    // Granularidade por título (não por categoria somada): cada upsert é
    // idempotente, então um checkpoint no meio do caminho nunca sobrescreve
    // parte do total já gravado por um checkpoint anterior — a soma por
    // categoria/mês é feita por quem lê (acao=dre), nunca aqui.
    let lote = [];
    let processadosDesdeCheckpoint = 0;

    async function salvarLote() {
      if (lote.length) await upsertMensal(empresa, lote);
      lote = [];
    }

    // Receita nunca mais é classificada por título de contas a receber —
    // decisão do Rafael (2026-11-24): "contas a receber... não devem estar
    // aí... combinamos que apenas contas a pagar estarão nesse primeiro
    // momento, pois receitas virão das notas". Cobre não só o grupo 1.01
    // (que já tinha saído daqui em 2026-11-23, só pra Rampa) como QUALQUER
    // classificação de receber por categoria, nas duas empresas — inclusive
    // a "Olist Conta Digital" (transferência bancária importada automática,
    // nunca uma venda) que aparecia como "não classificado" na TF. Por isso
    // nenhuma chamada à Tiny é feita aqui: só limpa qualquer linha que uma
    // execução anterior (antes dessa mudança, ou do fix de 2026-11-23 pro
    // grupo 1.01) tenha gravado em financeiro_mensal pelo caminho
    // título-based — upsert não apaga sozinho, então sem isso o título
    // ficaria preso lá pra sempre.
    while (filaReceita.length > 0 && (Date.now() - inicioExecucao) < ORCAMENTO_TOTAL_MS) {
      const item = filaReceita.shift();
      try {
        await excluirMensal(empresa, "receber", item.id);
      } catch (erroRede) {
        console.error(`[financeiro-sync] erro ao excluir título contas-receber ${item.id}: ${erroRede.message}`);
        item.tentativas = (item.tentativas || 0) + 1;
        if (item.tentativas <= MAX_TENTATIVAS_POR_TITULO) filaReceita.push(item);
      }
      processadosDesdeCheckpoint++;
      if (processadosDesdeCheckpoint >= SALVAR_PROGRESSO_A_CADA) {
        status.pendentes.receita = filaReceita;
        status.processados = status.total - filaReceita.length - filaPagar.length;
        await salvarStatusSync(empresa, status);
        console.log(`[financeiro-sync:${empresa}] checkpoint (receita): ${status.processados}/${status.total}`);
        processadosDesdeCheckpoint = 0;
      }
    }

    while (filaPagar.length > 0 && (Date.now() - inicioExecucao) < ORCAMENTO_TOTAL_MS) {
      const item = filaPagar.shift();
      await sleep(PACE_MS);
      try {
        const rd = await httpsRequest("GET", "api.tiny.com.br", `/public-api/v3/contas-pagar/${item.id}`, null, { Authorization: "Bearer " + accessToken });
        if (rd.status !== 200) throw new Error(`contas-pagar/${item.id}: HTTP ${rd.status} - ${rd.text.slice(0, 200)}`);
        const d = parseJSON(rd.text);
        const catId = d.categoria?.id;
        const cat = catId != null ? categorias[catId] : null;
        if (!(cat && cat.forca_manual)) {
          let codigoGrupo = cat?.codigo_grupo || null;
          let viaHistorico = false;
          if (!codigoGrupo) {
            // Categoria não existia na Tiny no momento do lançamento (ex: as
            // categorias de imposto 5.01 só foram criadas em 2026-11-20 —
            // títulos pagos antes disso ficam com categoria=null pra sempre,
            // a menos que alguém volte e retagueie manualmente na Tiny).
            // Enquanto isso não acontece, usamos o texto do histórico como
            // pista — ver "Classificação por histórico" no plano.
            const grupoHeuristico = classificarPorHistorico(d.historico);
            if (grupoHeuristico) { codigoGrupo = grupoHeuristico; viaHistorico = true; }
          }
          const linha = codigoGrupo ? planoContas[codigoGrupo] : null;

          // descricao é só informativo (pra tela de apontamento manual — ver
          // acao=titulos) — sempre recalculado no sync, nunca preservado como o
          // intercompany, que fica de fora do payload nos dois ramos abaixo.
          const descricao = d.contato?.nome || d.historico || null;
          if (linha && linha.regime === "competencia" && linha.fonte_tiny === "contas_pagar") {
            // Imposto sobre venda (5.01): conta no mês da dataCompetencia real, não do vencimento usado pra listar.
            // Quando a classificação veio do histórico (categoria não existe na Tiny — ver acima), a Tiny
            // também nunca preencheu dataCompetencia pra esse título (achado ao vivo, TF, 2026-11-24: títulos
            // "DAS - SIMPLES NACIONAL" pagos sem categoria E sem dataCompetencia) — exigir o match exato fazia
            // o título nunca bater em nenhum período testado e desaparecer sem erro nenhum, nem como "não
            // classificado" (nunca chegava a entrar em `lote`). Nesse caso usamos dataVencimento (campo real,
            // já usado pra decidir em qual janela/período esse título foi buscado) como aproximação de
            // competência, só pra esse caminho de stopgap.
            const competenciaReal = d.dataCompetencia || String(d.dataVencimento || "").slice(0, 7);
            if (competenciaReal === formatarYYYYMM(item.ano, item.mes)) {
              lote.push({
                ano: item.ano, mes: item.mes, codigo_grupo: codigoGrupo, categoria_id: viaHistorico ? null : catId,
                origem: viaHistorico ? "tiny_historico" : "tiny_competencia", regime: "competencia",
                titulo_tipo: "pagar", titulo_id: item.id, valor: Number(d.valor) || 0,
                data_emissao: d.data || null, data_pagamento: d.dataLiquidacao || null,
                descricao, historico: d.historico || null,
              });
            }
          } else if ((!linha || linha.regime === "caixa") && (d.situacao === "pago" || d.situacao === "parcial")) {
            // Despesa/CMV por caixa: conta no mês em que foi de fato liquidado.
            // Categoria não mapeada (linha=null) também cai aqui, como "não
            // classificado" (codigo_grupo=null), em vez de ser descartada.
            const dataLiq = String(d.dataLiquidacao || "").slice(0, 7); // "YYYY-MM"
            if (dataLiq === formatarYYYYMM(item.ano, item.mes)) {
              const valor = Number(d.valorPago) || Number(d.valor) || 0;
              lote.push({
                ano: item.ano, mes: item.mes, codigo_grupo: codigoGrupo, categoria_id: catId ?? null,
                origem: "tiny_caixa", regime: "caixa",
                titulo_tipo: "pagar", titulo_id: item.id, valor,
                data_emissao: d.data || null, data_pagamento: d.dataLiquidacao || null,
                descricao, historico: d.historico || null,
              });
            }
          }
        }
      } catch (erroRede) {
        console.error(`[financeiro-sync] erro no título contas-pagar ${item.id}: ${erroRede.message}`);
        item.tentativas = (item.tentativas || 0) + 1;
        if (item.tentativas <= MAX_TENTATIVAS_POR_TITULO) filaPagar.push(item);
        await pausaSeBloqueio(erroRede, `contas-pagar ${item.id}`);
      }
      processadosDesdeCheckpoint++;
      if (processadosDesdeCheckpoint >= SALVAR_PROGRESSO_A_CADA) {
        await salvarLote();
        status.pendentes.pagar = filaPagar;
        status.processados = status.total - filaReceita.length - filaPagar.length - filaCmv.length;
        await salvarStatusSync(empresa, status);
        console.log(`[financeiro-sync:${empresa}] checkpoint (pagar): ${status.processados}/${status.total}`);
        processadosDesdeCheckpoint = 0;
      }
    }

    let semCustoNoLote = 0, itensNoLote = 0;
    while (grupoCmv && filaCmv.length > 0 && (Date.now() - inicioExecucao) < ORCAMENTO_TOTAL_MS) {
      const item = filaCmv.shift();
      await sleep(PACE_MS);
      try {
        const obterCusto = (idProduto) => obterCustoProduto(idProduto, item.ano, item.mes);
        const { valor, semCusto, totalItens, intercompanyTF, clienteNome } = await calcularCmvNota(tokenV2, item.id, obterCusto);
        semCustoNoLote += semCusto;
        itensNoLote += totalItens;
        lote.push({
          ano: item.ano, mes: item.mes, codigo_grupo: grupoCmv, categoria_id: null,
          origem: "tiny_notas_itens", regime: "competencia",
          titulo_tipo: "cmv", titulo_id: item.id, valor,
          data_emissao: dataBRparaISO(item.dataEmissaoBR),
          intercompany: empresa === "rampa" && intercompanyTF, descricao: clienteNome,
        });
      } catch (erroRede) {
        console.error(`[financeiro-sync] erro na nota de venda (cmv) ${item.id}: ${erroRede.message}`);
        item.tentativas = (item.tentativas || 0) + 1;
        if (item.tentativas <= MAX_TENTATIVAS_POR_TITULO) filaCmv.push(item);
        await pausaSeBloqueio(erroRede, `cmv nota ${item.id}`);
      }
      processadosDesdeCheckpoint++;
      if (processadosDesdeCheckpoint >= SALVAR_PROGRESSO_A_CADA) {
        await salvarLote();
        await salvarCongelamentos(novosCongelamentos);
        status.pendentes.cmv = filaCmv;
        status.processados = status.total - filaReceita.length - filaPagar.length - filaCmv.length;
        await salvarStatusSync(empresa, status);
        console.log(`[financeiro-sync:${empresa}] checkpoint (cmv): ${status.processados}/${status.total}` +
          (itensNoLote ? ` — ${semCustoNoLote}/${itensNoLote} itens sem custo cadastrado neste lote` : ""));
        processadosDesdeCheckpoint = 0;
        semCustoNoLote = 0; itensNoLote = 0;
      }
    }

    await salvarLote();
    await salvarCongelamentos(novosCongelamentos);
    status.pendentes = { receita: filaReceita, pagar: filaPagar, cmv: filaCmv };
    status.processados = status.total - filaReceita.length - filaPagar.length - filaCmv.length;

    if (filaReceita.length === 0 && filaPagar.length === 0 && filaCmv.length === 0) {
      // Roda depois que a fila de contas a receber terminou de verdade —
      // é nesse mesmo passo que títulos de grupo 1.01 (Venda Interna) da
      // Rampa são excluídos (ver loop acima), então só faz sentido gravar a
      // receita por NF depois que essa exclusão já rodou pra todos. Cobre os
      // dois períodos (mês atual + anterior): diferente do antigo ajuste de
      // conciliação (que comparava contra um total e podia ficar negativo se
      // o cache do mês corrente estivesse incompleto), aqui cada linha é só
      // "o que o Relatório de Vendas já sabe pra essa NF" — nunca fica errado,
      // só fica incompleto até o sync de Relatórios (relatorio_cache) trazer
      // os dias que faltam do mês em andamento.
      await sincronizarReceitaPorNotasFiscais(empresa, periodos, categorias);
      status.em_andamento = false;
      status.concluido_em = new Date().toISOString();
      await salvarStatusSync(empresa, status);
      console.log(`[financeiro-sync:${empresa}] concluído: ${status.total} títulos classificados em ${Math.round((Date.now() - inicioExecucao) / 1000)}s`);
      return res.status(200).json({ ok: true, concluido: true, total: status.total });
    }

    await salvarStatusSync(empresa, status);
    console.error(`[financeiro-sync:${empresa}] orçamento de tempo esgotado: ${status.processados}/${status.total} — precisa de outra chamada pra terminar`);
    return res.status(200).json({ ok: true, concluido: false, processados: status.processados, restante: filaReceita.length + filaPagar.length + filaCmv.length });

  } catch (e) {
    console.error(`[financeiro-sync:${empresa}] erro fatal:`, e.message);
    try { await marcarTentativaSync(empresa, e.message); } catch (_) { /* best-effort */ }
    return res.status(500).json({ erro: e.message, stack: e.stack });
  }
}

// ============================================================================
// CMV paralelo (Estoque Inicial + Compras − Estoque Final) — em desenho desde
// 2026-11-25, ver CLAUDE.md. Controle INDEPENDENTE do CMV do DRE acima (nota ×
// custo do produto) — serve pra comparar os dois e investigar divergência,
// nunca substitui nem altera o CMV que já entra no DRE.
//
// v1, escopo deliberadamente contido:
//   - Estoque inicial/final: a Olist não tem endpoint de saldo histórico (o
//     endpoint de log de movimentação devolve 403 — provável permissão de
//     app, mesmo padrão do /caixa, só o Rafael resolve isso no painel da
//     Tiny). Em vez disso, o saldo de fechamento de cada mês é IMPORTADO do
//     relatório "Saldos em Estoque" que o Rafael exporta direto da tela da
//     Tiny (ela reconstrói esse histórico internamente, só não expõe via
//     API) — ver acao=estoque-saldo-importar.
//   - Compras do mês: ordens de compra com situacao=Atendido cuja `data` cai
//     no mês (decisão do Rafael, 2026-11-25) — custo rateia o FRETE da
//     própria OC entre os itens (proporcional ao valor de cada item); o
//     DESCONTO da OC fica de fora do rateio por enquanto (vem como texto da
//     Tiny, sem ficar claro se é valor ou percentual — rateá-lo errado seria
//     pior que não ratear). Frete de CTe separada (quando a OC não embute
//     frete) e devoluções de compra/venda ficam pra uma v2 — não tem exemplo
//     vivo de devolução ainda (confirmado raro) e a CTe depende de um vínculo
//     manual que ainda não foi construído.
//   - Vendas do mês: mesma fonte de nota V2 que o CMV do DRE já usa (mas é um
//     passe PRÓPRIO, independente do sync-diario acima — não reaproveita nem
//     altera nada da fila de CMV, pra não arriscar o sync que já está em
//     produção) — soma quantidade por produto a partir dos itens de cada nota.
//   - Sem cron: tudo acionado manualmente (botão na tela), nos moldes do
//     "Atualizar Catálogo Agora" da aba Estoque. Dá pra automatizar depois se
//     fizer sentido.
// ============================================================================

const ORCAMENTO_MOVIMENTOS_MS = 280000;

async function buscarSkuParaProdutoId(empresa) {
  const mapa = new Map();
  const limit = 1000;
  let offset = 0;
  while (true) {
    const r = await httpsRequest("GET", supaHost(),
      `/rest/v1/estoque_catalogo?empresa=eq.${empresa}&select=produto_id,sku&limit=${limit}&offset=${offset}`,
      null, supaHeaders);
    const linhas = parseJSON(r.text);
    if (!Array.isArray(linhas)) break;
    linhas.forEach(l => { if (l.sku) mapa.set(String(l.sku).trim().toUpperCase(), Number(l.produto_id)); });
    if (linhas.length < limit) break;
    offset += limit;
  }
  return mapa;
}

// Importa o snapshot de saldo de fechamento de um mês (linhas vindas do
// relatório "Saldos em Estoque" exportado da Tiny, já parseado no navegador —
// mesmo padrão de upload client-side que a aba Importar já usa pra planilha
// de clientes). SKU que não bate com nenhum produto do catálogo (produto
// descontinuado há muito tempo, ou erro de digitação na planilha) entra na
// lista de "não encontrados" devolvida pro usuário, em vez de travar o resto.
async function importarSaldoMensal(empresa, ano, mes, linhas) {
  const skuParaProdutoId = await buscarSkuParaProdutoId(empresa);
  const naoEncontrados = [];
  const payload = [];
  for (const l of linhas) {
    const sku = String(l.sku || "").trim().toUpperCase();
    const produtoId = skuParaProdutoId.get(sku);
    if (!produtoId) { naoEncontrados.push(l.sku); continue; }
    payload.push({
      empresa, ano, mes, produto_id: produtoId, sku: l.sku,
      quantidade: Number(l.quantidade) || 0, importado_em: new Date().toISOString(),
    });
  }
  if (payload.length) {
    const body = JSON.stringify(payload);
    const r = await httpsRequest("POST", supaHost(), "/rest/v1/estoque_saldo_mensal?on_conflict=empresa,ano,mes,produto_id", body,
      { ...supaHeaders, "Content-Length": Buffer.byteLength(body), Prefer: "resolution=merge-duplicates,return=minimal" });
    if (r.status >= 300) {
      throw new Error(`upsert estoque_saldo_mensal: HTTP ${r.status} - ${r.text.slice(0, 500)}`);
    }
  }
  return { importados: payload.length, naoEncontrados };
}

async function upsertMovimentos(empresa, linhas) {
  if (!linhas.length) return;
  const payload = JSON.stringify(linhas.map(l => ({ ...l, empresa, atualizado_em: new Date().toISOString() })));
  const r = await httpsRequest("POST", supaHost(), "/rest/v1/estoque_movimentos_mensal?on_conflict=empresa,tipo,origem_id,produto_id", payload,
    { ...supaHeaders, "Content-Length": Buffer.byteLength(payload), Prefer: "resolution=merge-duplicates,return=minimal" });
  if (r.status >= 300) {
    throw new Error(`upsert estoque_movimentos_mensal: HTTP ${r.status} - ${r.text.slice(0, 500)}`);
  }
}

// Ordens de compra Atendido (situacao=1) cuja `data` cai no mês pedido —
// decisão do Rafael (2026-11-25). A listagem não filtra por data (só por
// situacao), então pagina tudo e filtra aqui. Custo de cada item = preço do
// item + rateio do FRETE da própria OC (proporcional ao valor do item); o
// DESCONTO da OC fica de fora (ver comentário no topo desta seção).
async function buscarOrdensCompraAtendidasDoMes(accessToken, ano, mes) {
  const alvo = formatarYYYYMM(ano, mes);
  const linhas = [];
  const limit = 100;
  let offset = 0;
  while (true) {
    const r = await httpsRequest("GET", "api.tiny.com.br",
      `/public-api/v3/ordem-compra?situacao=1&limit=${limit}&offset=${offset}`,
      null, { Authorization: "Bearer " + accessToken });
    const data = parseJSON(r.text);
    if (r.status !== 200 || !Array.isArray(data.itens)) {
      throw new Error(`ordem-compra (listagem offset=${offset}): HTTP ${r.status} - ${r.text.slice(0, 200)}`);
    }
    for (const ordem of data.itens) {
      if (String(ordem.data || "").slice(0, 7) !== alvo) continue;
      const itensOrdem = ordem.itens || [];
      const totalProdutos = Number(ordem.totalProdutos) || itensOrdem.reduce((s, it) => s + (Number(it.preco) || 0) * (Number(it.quantidade) || 0), 0);
      const frete = Number(ordem.frete) || 0;
      const divergenteData = !!ordem.dataPrevista && String(ordem.dataPrevista).slice(0, 7) !== alvo;
      // Uma mesma OC pode listar o mesmo produto em mais de uma linha (lotes/preços
      // diferentes) — agrega por produto ANTES de empilhar em `linhas`, porque o
      // upsert é por (empresa,tipo,origem_id,produto_id) e duas linhas com a mesma
      // chave no mesmo lote fazem o Postgres rejeitar o upsert inteiro (erro 21000,
      // "ON CONFLICT DO UPDATE command cannot affect row a second time")
      const porProduto = new Map();
      for (const item of itensOrdem) {
        const produtoId = item.produto?.id;
        const quantidade = Number(item.quantidade) || 0;
        if (!produtoId || !quantidade) continue;
        const valorItem = (Number(item.preco) || 0) * quantidade;
        const rateioFrete = totalProdutos > 0 ? frete * (valorItem / totalProdutos) : 0;
        const custoTotalItem = valorItem + rateioFrete;
        const acc = porProduto.get(produtoId) || { quantidade: 0, custoTotal: 0 };
        acc.quantidade += quantidade;
        acc.custoTotal += custoTotalItem;
        porProduto.set(produtoId, acc);
      }
      for (const [produtoId, acc] of porProduto) {
        linhas.push({
          ano, mes, produto_id: produtoId, tipo: "compra", origem_id: ordem.id,
          quantidade: acc.quantidade, custo_unitario: acc.custoTotal / acc.quantidade, custo_total: acc.custoTotal,
          data: ordem.data || null, data_prevista: ordem.dataPrevista || null, divergente_data: divergenteData,
        });
      }
    }
    const total = data.paginacao?.total ?? data.itens.length;
    offset += limit;
    if (data.itens.length < limit || offset >= total) break;
    await sleep(PACE_MS);
  }
  return linhas;
}

// Vendas do mês, por quantidade — mesma fonte V2 (nota.fiscal.*) que o CMV do
// DRE já usa, mas um passe PRÓPRIO e independente do sync-diario acima (ver
// comentário no topo desta seção pro motivo de não reaproveitar aquela fila).
//
// Separa por finalidade (pedido do Rafael, 2026-11-25 — colunas C/D de
// compras e V/D de vendas): nota "S" (saída) com finalidade normal = venda;
// com finalidade de devolução (FINALIDADES_DEVOLUCAO) = devolução de COMPRA
// (mercadoria voltando pro fornecedor). Nota "E" (entrada) com essa mesma
// finalidade = devolução de VENDA (cliente devolvendo) — mesmo padrão já
// usado em `_lib/relatorio-coleta.js`/coletarDevolucoesSync, só que aqui por
// quantidade/produto, não por valor. A devolução de COMPRA é suposição por
// simetria (nunca vista ao vivo até hoje, ver CLAUDE.md "CMV paralelo") —
// vale confirmar contra um caso real na Tiny quando aparecer um.
async function buscarNotasComDetalhe(tokenV2, tipoNota, ano, mes) {
  const iniBR = formatarDataBR(ano, mes, 1);
  const fimBR = formatarDataBR(ano, mes, ultimoDiaDoMes(ano, mes));
  const notas = await listarNotasFiscaisV2(tokenV2, tipoNota, iniBR, fimBR);
  const resultado = [];
  // Fila com retentativa (antes: sem nenhuma — uma nota que batesse em
  // bloqueio da Olist era descartada pra sempre, silenciosamente, nessa
  // mesma execução) e pausa quando detecta bloqueio (ver PADRAO_BLOQUEIO_OLIST).
  const fila = notas.map(n => ({ n, tentativas: 0 }));
  while (fila.length > 0) {
    const { n, tentativas } = fila.shift();
    await sleep(PACE_MS);
    try {
      const detalhe = await buscarDetalheNotaVendaV2(tokenV2, n.id);
      resultado.push({ nota: n, detalhe });
    } catch (e) {
      console.error(`[estoque-movimentos-sync] erro ao buscar nota ${n.id}: ${e.message}`);
      if (tentativas + 1 <= MAX_TENTATIVAS_POR_TITULO) fila.push({ n, tentativas: tentativas + 1 });
      await pausaSeBloqueio(e, `nota ${n.id}`);
    }
  }
  return resultado;
}

// Agrega por produto (uma nota pode ter o mesmo produto em mais de uma linha
// de item) — mesmo padrão que `buscarOrdensCompraAtendidasDoMes` já faz.
function movimentosPorProduto(ano, mes, notaId, tipo, dataEmissaoBR, itens) {
  const porProduto = new Map();
  for (const itWrap of (itens || [])) {
    const it = itWrap?.item;
    const produtoId = it?.id_produto;
    const quantidade = Number(it?.quantidade) || 0;
    if (!produtoId || !quantidade) continue;
    porProduto.set(produtoId, (porProduto.get(produtoId) || 0) + quantidade);
  }
  return [...porProduto].map(([produtoId, quantidade]) => ({
    ano, mes, produto_id: produtoId, tipo, origem_id: notaId,
    quantidade, custo_unitario: null, custo_total: null,
    data: dataBRparaISO(dataEmissaoBR), data_prevista: null, divergente_data: false,
  }));
}

async function buscarVendasDoMes(tokenV2, ano, mes) {
  const linhas = [];

  const notasSaida = await buscarNotasComDetalhe(tokenV2, "S", ano, mes);
  for (const { nota, detalhe } of notasSaida) {
    const ehDevolucaoCompra = FINALIDADES_DEVOLUCAO.includes(String(detalhe?.finalidade));
    const tipo = ehDevolucaoCompra ? "devolucao_compra" : "venda";
    linhas.push(...movimentosPorProduto(ano, mes, nota.id, tipo, nota.data_emissao, detalhe?.itens));
  }

  await sleep(PACE_MS);
  const notasEntrada = await buscarNotasComDetalhe(tokenV2, "E", ano, mes);
  for (const { nota, detalhe } of notasEntrada) {
    const ehDevolucaoVenda = FINALIDADES_DEVOLUCAO.includes(String(detalhe?.finalidade));
    if (!ehDevolucaoVenda) continue; // nota de entrada que não é devolução não interessa aqui
    linhas.push(...movimentosPorProduto(ano, mes, nota.id, "devolucao_venda", nota.data_emissao, detalhe?.itens));
  }

  return linhas;
}

async function executarMovimentosSync(empresa, ano, mes) {
  const inicio = Date.now();
  const accessToken = await getAccessToken(empresa);
  const tokenV2 = getConfigEmpresa(empresa).tokenV2;

  const compras = await buscarOrdensCompraAtendidasDoMes(accessToken, ano, mes);
  await upsertMovimentos(empresa, compras);

  if (Date.now() - inicio > ORCAMENTO_MOVIMENTOS_MS) {
    return { ok: true, concluido: false, etapa: "compras", compras: compras.length, vendas: 0 };
  }

  // buscarVendasDoMes devolve vendas, devoluções de compra (notas "S") e
  // devoluções de venda (notas "E") misturadas em `tipo` — conta cada uma
  // separado só pro retorno informativo do botão "Sincronizar agora".
  const movimentosVenda = await buscarVendasDoMes(tokenV2, ano, mes);
  await upsertMovimentos(empresa, movimentosVenda);
  const contarTipo = (tipo) => movimentosVenda.filter(l => l.tipo === tipo).length;

  return {
    ok: true, concluido: true, compras: compras.length,
    vendas: contarTipo("venda"), devolucoesCompra: contarTipo("devolucao_compra"), devolucoesVenda: contarTipo("devolucao_venda"),
  };
}

// Relatório de reconciliação em si: estoque inicial (saldo importado do mês
// anterior) + compras − vendas = estoque final CALCULADO, comparado contra o
// estoque final REAL (saldo importado do mês pedido). Produto sem saldo
// importado nos dois extremos ainda aparece se tiver movimento no mês (com
// `inicial=0` e `temSaldoInicial=false` pro front avisar que falta importar).
async function montarCmvParalelo(empresa, ano, mes) {
  const anterior = mesAlvoAnterior(ano, mes);
  const [rInicial, rFinal, rMov, rCatalogo, custoAtualMap, custoCongeladoMap] = await Promise.all([
    httpsRequest("GET", supaHost(), `/rest/v1/estoque_saldo_mensal?empresa=eq.${empresa}&ano=eq.${anterior.ano}&mes=eq.${anterior.mes}&select=produto_id,quantidade`, null, supaHeaders),
    httpsRequest("GET", supaHost(), `/rest/v1/estoque_saldo_mensal?empresa=eq.${empresa}&ano=eq.${ano}&mes=eq.${mes}&select=produto_id,quantidade`, null, supaHeaders),
    httpsRequest("GET", supaHost(), `/rest/v1/estoque_movimentos_mensal?empresa=eq.${empresa}&ano=eq.${ano}&mes=eq.${mes}&select=produto_id,tipo,quantidade`, null, supaHeaders),
    httpsRequest("GET", supaHost(), `/rest/v1/estoque_catalogo?empresa=eq.${empresa}&select=produto_id,sku,nome`, null, supaHeaders),
    lerCustoAtualCatalogo(empresa),
    lerCustoCongeladoMes(empresa, ano, mes),
  ]);
  const inicialMap = new Map((parseJSON(rInicial.text) || []).map(l => [Number(l.produto_id), Number(l.quantidade) || 0]));
  const finalRealMap = new Map((parseJSON(rFinal.text) || []).map(l => [Number(l.produto_id), Number(l.quantidade) || 0]));
  const catalogoMap = new Map((parseJSON(rCatalogo.text) || []).map(l => [Number(l.produto_id), l]));
  // Mesmo custo "do mês" usado no CMV do DRE (congelado se o mês já passou
  // por lá, senão o atual do catálogo) — só LÊ, nunca escreve/congela nada
  // novo a partir daqui (isso é feito só pelo sync diário do financeiro, ver
  // "CMV real" no CLAUDE.md), já que este é um relatório de leitura.
  const custoDoMes = (id) => custoCongeladoMap.has(id) ? custoCongeladoMap.get(id) : (custoAtualMap.get(id) || 0);

  // Compras/vendas BRUTAS e devoluções somadas separado (pedido do Rafael,
  // 2026-11-25: colunas "C"/"D" pra compras e "V"/"D" pra vendas) — o
  // calculado usa o NETO de cada par (compra − devolução de compra, venda −
  // devolução de venda), então a devolução entra com sinal contrário ao da
  // sua coluna-mãe.
  const comprasMap = new Map(), devCompraMap = new Map(), vendasMap = new Map(), devVendaMap = new Map();
  const mapaPorTipo = { compra: comprasMap, devolucao_compra: devCompraMap, venda: vendasMap, devolucao_venda: devVendaMap };
  for (const m of (parseJSON(rMov.text) || [])) {
    const mapa = mapaPorTipo[m.tipo];
    if (!mapa) continue;
    const id = Number(m.produto_id);
    mapa.set(id, (mapa.get(id) || 0) + (Number(m.quantidade) || 0));
  }

  const produtoIds = new Set([...inicialMap.keys(), ...finalRealMap.keys(), ...comprasMap.keys(), ...devCompraMap.keys(), ...vendasMap.keys(), ...devVendaMap.keys()]);
  const produtos = [...produtoIds].map(id => {
    const inicial = inicialMap.get(id) || 0;
    const compras = comprasMap.get(id) || 0;
    const devolucaoCompra = devCompraMap.get(id) || 0;
    const vendas = vendasMap.get(id) || 0;
    const devolucaoVenda = devVendaMap.get(id) || 0;
    const finalCalculado = inicial + (compras - devolucaoCompra) - (vendas - devolucaoVenda);
    const temFinalReal = finalRealMap.has(id);
    const finalReal = temFinalReal ? finalRealMap.get(id) : null;
    const cat = catalogoMap.get(id);
    // Sinal invertido a pedido do Rafael (2026-11-25): diferença = real − calculado
    // (positivo quando falta no calculado, negativo quando sobra).
    const diferenca = temFinalReal ? finalReal - finalCalculado : null;
    const custoUnitario = custoDoMes(id);
    return {
      produto_id: id, sku: cat?.sku || null, nome: cat?.nome || `Produto ${id}`,
      inicial, temInicial: inicialMap.has(id), compras, devolucaoCompra, vendas, devolucaoVenda, finalCalculado,
      finalReal, temFinalReal, diferenca,
      custoUnitario, custoDiferenca: diferenca != null ? diferenca * custoUnitario : null,
    };
  });
  // Ordenado por descrição do produto (pedido do Rafael, 2026-11-25) — antes
  // era por |diferença| decrescente, difícil de acompanhar na tela.
  produtos.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  const totalCustoDiferenca = produtos.reduce((s, p) => s + (p.custoDiferenca || 0), 0);

  return {
    ano, mes, anterior, totalCustoDiferenca,
    temSaldoInicial: inicialMap.size > 0, temSaldoFinal: finalRealMap.size > 0,
    produtos,
  };
}

// ============================================================================
// Handler principal
// ============================================================================

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Sync diário (cron) — nunca chamado pelo frontend, ver vercel.json.
  if (req.query.acao === "sync-diario") {
    return executarSyncDiario(req, res);
  }

  try {
    if (req.method === "GET") {
      const acao = req.query.acao;

      if (acao === "dre") {
        const ano = parseInt(req.query.ano, 10);
        const mes = parseInt(req.query.mes, 10);
        if (!ano || !mes) return res.status(400).json({ erro: "ano e mes são obrigatórios" });
        const consolidado = req.query.consolidado === "true";
        const empresas = consolidado ? ["rampa", "tf"] : [String(req.query.empresa || "rampa").toLowerCase()];

        const [planoContas, linhasMensal, linhasManuais, categoriasPorEmpresa] = await Promise.all([
          buscarPlanoContas(),
          buscarMensal(empresas, ano, mes),
          buscarManuais(empresas, ano, mes),
          buscarCategoriasPorEmpresa(empresas),
        ]);
        // Alocação intercompany manual só se aplica visualizando UMA empresa
        // por vez — no consolidado o título real já soma o valor cheio uma
        // vez (do lado de quem pagou), então nem divide a origem nem injeta
        // a entrada sintética no destino (duplicaria o valor).
        let alocacoesOrigem = {}, alocacoesDestino = [];
        if (!consolidado) {
          [alocacoesOrigem, alocacoesDestino] = await Promise.all([
            buscarAlocacoesPorOrigem(empresas[0]),
            buscarAlocacoesParaDestino(empresas[0], ano, mes),
          ]);
        }
        const dre = montarDRE(planoContas, linhasMensal, linhasManuais, categoriasPorEmpresa, alocacoesOrigem, alocacoesDestino);
        return res.status(200).json({ ano, mes, empresa: consolidado ? "consolidado" : empresas[0], ...dre });
      }

      if (acao === "titulos") {
        // Drill-down por grupo/mês/empresa — alimenta a tela de apontamento
        // manual do intercompany (um ou mais codigo_grupo, separados por vírgula,
        // pra cobrir uma linha_dre que tenha vários grupos). Com `leaf`, filtra
        // ainda mais fino pro nível 3 (mesmo rótulo que resolverLeaf monta pro
        // DRE) — usado pela lupa de cada sub-linha da árvore.
        const empresaTit = String(req.query.empresa || "rampa").toLowerCase();
        const anoTit = parseInt(req.query.ano, 10);
        const mesTit = parseInt(req.query.mes, 10);
        const grupos = String(req.query.codigo_grupo || "").split(",").map(s => s.trim()).filter(Boolean);
        const leafFiltro = req.query.leaf != null ? String(req.query.leaf) : null;
        if (!anoTit || !mesTit || !grupos.length) {
          return res.status(400).json({ erro: "empresa, ano, mes e codigo_grupo são obrigatórios" });
        }
        const filtroGrupo = grupos.length === 1
          ? `codigo_grupo=eq.${encodeURIComponent(grupos[0])}`
          : `codigo_grupo=in.(${grupos.map(encodeURIComponent).join(",")})`;
        const [r, alocacoesOrigemTit, alocacoesDestinoTit] = await Promise.all([
          httpsRequest("GET", supaHost(),
            `/rest/v1/financeiro_mensal?empresa=eq.${empresaTit}&ano=eq.${anoTit}&mes=eq.${mesTit}&${filtroGrupo}` +
            `&select=titulo_tipo,titulo_id,codigo_grupo,categoria_id,valor,origem,descricao,historico,intercompany,data_emissao,data_pagamento&order=valor.desc`,
            null, supaHeaders),
          buscarAlocacoesPorOrigem(empresaTit),
          buscarAlocacoesParaDestino(empresaTit, anoTit, mesTit),
        ]);
        let data = parseJSON(r.text);
        data = Array.isArray(data) ? data : [];
        // Anota cada título de despesa com a alocação que já existe (pra
        // mostrar o valor alocado e a empresa/categoria de destino no botão,
        // em vez do checkbox antigo — ver "intercompany MANUAL" acima).
        data = data.map(l => {
          if (l.titulo_tipo !== "pagar") return l;
          const aloc = alocacoesOrigemTit[`${l.titulo_tipo}:${l.titulo_id}`];
          return aloc ? { ...l, alocacao: aloc } : l;
        });
        // Entradas sintéticas: dinheiro que, por alocação de outra empresa,
        // é desta empresa — só entram se o grupo pedido bater com a
        // categoria de destino escolhida na alocação.
        for (const a of alocacoesDestinoTit) {
          if (!grupos.includes(a.codigo_grupo_destino)) continue;
          data.push({
            sintetico: true,
            titulo_tipo: "pagar",
            titulo_id: a.titulo_id,
            codigo_grupo: a.codigo_grupo_destino,
            categoria_id: null,
            valor: a.valor,
            origem: "intercompany_alocacao",
            descricao: a.descricaoOrigem,
            historico: a.historicoOrigem,
            intercompany: true,
            data_emissao: null,
            data_pagamento: null,
            empresa_origem: a.empresa_origem,
            empresa_destino: a.empresa_destino,
            codigo_grupo_destino: a.codigo_grupo_destino,
            leaf_destino: a.leaf_destino,
            nota: a.nota,
            valor_total_titulo: a.valorTitulo,
          });
        }
        if (leafFiltro != null) {
          const categoriasPorEmpresa = await buscarCategoriasPorEmpresa([empresaTit]);
          data = data.filter(l => {
            if (l.sintetico) return (l.leaf_destino || l.nota || `Intercompany de ${String(l.empresa_origem || "").toUpperCase()} — ${l.descricao || l.historico || "despesa"}`) === leafFiltro;
            return resolverLeaf({ ...l, empresa: empresaTit }, categoriasPorEmpresa) === leafFiltro;
          });
        }
        return res.status(200).json(data);
      }

      if (acao === "estoque-cmv-paralelo") {
        const empresaCmvPar = String(req.query.empresa || "rampa").toLowerCase();
        const anoCmvPar = parseInt(req.query.ano, 10);
        const mesCmvPar = parseInt(req.query.mes, 10);
        if (!anoCmvPar || !mesCmvPar) return res.status(400).json({ erro: "ano e mes são obrigatórios" });
        const relatorio = await montarCmvParalelo(empresaCmvPar, anoCmvPar, mesCmvPar);
        return res.status(200).json(relatorio);
      }

      if (acao === "plano-contas") {
        const empresa = String(req.query.empresa || "rampa").toLowerCase();
        const [planoContas, rCategorias] = await Promise.all([
          buscarPlanoContas(),
          httpsRequest("GET", supaHost(),
            `/rest/v1/financeiro_categorias?empresa=eq.${empresa}&select=categoria_id,grupo_raw,descricao_raw,codigo_grupo,codigo_leaf,forca_manual&order=codigo_grupo.asc`,
            null, supaHeaders),
        ]);
        return res.status(200).json({ planoContas, categorias: parseJSON(rCategorias.text) });
      }

      // Sem acao: listar lançamentos manuais (filtros opcionais empresa/ano/mes)
      const { empresa, ano, mes } = req.query;
      let path = "/rest/v1/financeiro_lancamentos_manuais?select=*&order=ano.desc,mes.desc,codigo_grupo.asc";
      if (empresa) path += "&empresa=eq." + encodeURIComponent(String(empresa).toLowerCase());
      if (ano) path += "&ano=eq." + encodeURIComponent(ano);
      if (mes) path += "&mes=eq." + encodeURIComponent(mes);
      const r = await httpsRequest("GET", supaHost(), path, null, supaHeaders);
      const data = parseJSON(r.text);
      return res.status(200).json(Array.isArray(data) ? data : []);
    }

    if (req.method === "POST" && req.query.acao === "estoque-saldo-importar") {
      const { empresa, ano, mes, linhas } = parseBody(req.body);
      if (!empresa || !ano || !mes || !Array.isArray(linhas)) {
        return res.status(400).json({ erro: "empresa, ano, mes e linhas (array) são obrigatórios" });
      }
      const resultado = await importarSaldoMensal(String(empresa).toLowerCase(), parseInt(ano, 10), parseInt(mes, 10), linhas);
      return res.status(200).json({ ok: true, ...resultado });
    }

    if (req.method === "POST" && req.query.acao === "estoque-movimentos-sync") {
      const { empresa, ano, mes } = parseBody(req.body);
      if (!empresa || !ano || !mes) return res.status(400).json({ erro: "empresa, ano e mes são obrigatórios" });
      try {
        const resultado = await executarMovimentosSync(String(empresa).toLowerCase(), parseInt(ano, 10), parseInt(mes, 10));
        return res.status(200).json(resultado);
      } catch (e) {
        return res.status(500).json({ erro: e.message });
      }
    }

    if (req.method === "POST" && req.query.acao === "intercompany-alocacao") {
      // Cria ou edita a alocação intercompany manual de um título de despesa
      // (titulo_tipo=pagar) — substitui o antigo acao=marcar-intercompany
      // (checkbox tudo-ou-nada) por valor parcial + categoria de destino
      // escolhida (decisão do Rafael, 2026-11-24 — ver "intercompany MANUAL"
      // acima). empresa_destino é sempre a outra empresa, nunca escolhida
      // pelo usuário (só existem duas hoje).
      const { empresa_origem, titulo_tipo, titulo_id, valor_alocado, leaf_destino, nota } = parseBody(req.body);
      if (!empresa_origem || !titulo_tipo || !titulo_id || !leaf_destino || !(Number(valor_alocado) > 0)) {
        return res.status(400).json({ erro: "empresa_origem, titulo_tipo, titulo_id, leaf_destino e valor_alocado (> 0) são obrigatórios" });
      }
      if (titulo_tipo !== "pagar") {
        return res.status(400).json({ erro: "alocação intercompany manual só vale pra despesas (titulo_tipo=pagar)" });
      }
      const empresaOrigemNorm = String(empresa_origem).toLowerCase();
      const empresaDestinoNorm = empresaContraria(empresaOrigemNorm);
      // categoria de destino agora é sempre do nível 3 (leaf) — o grupo (nível 2)
      // é derivado aqui a partir do leaf escolhido, nunca confiado direto do
      // corpo da requisição, pra não dar pra mandar um leaf de um grupo e um
      // codigo_grupo_destino de outro sem querer (decisão do Rafael, 2026-11-24
      // — ver "intercompany: categoria de destino no nível 3").
      const rCat = await httpsRequest("GET", supaHost(),
        `/rest/v1/financeiro_categorias?empresa=eq.${empresaDestinoNorm}&descricao_raw=eq.${encodeURIComponent(leaf_destino)}&select=codigo_grupo&limit=1`,
        null, supaHeaders);
      const catEncontrada = parseJSON(rCat.text)?.[0];
      if (!catEncontrada?.codigo_grupo) {
        return res.status(400).json({ erro: `categoria de destino "${leaf_destino}" não encontrada pra ${empresaDestinoNorm}` });
      }
      const payload = JSON.stringify({
        empresa_origem: empresaOrigemNorm,
        titulo_tipo,
        titulo_id: Number(titulo_id),
        valor_alocado: Number(valor_alocado),
        empresa_destino: empresaDestinoNorm,
        codigo_grupo_destino: catEncontrada.codigo_grupo,
        leaf_destino,
        nota: nota || null,
        atualizado_em: new Date().toISOString(),
      });
      const r = await httpsRequest("POST", supaHost(), "/rest/v1/financeiro_intercompany_alocacoes?on_conflict=empresa_origem,titulo_tipo,titulo_id", payload,
        { ...supaHeaders, "Content-Length": Buffer.byteLength(payload), Prefer: "resolution=merge-duplicates,return=representation" });
      if (r.status >= 400) return res.status(400).json({ erro: r.text });
      const data = parseJSON(r.text);
      return res.status(200).json(Array.isArray(data) ? data[0] : data);
    }

    if (req.method === "DELETE" && req.query.acao === "intercompany-alocacao") {
      const { empresa_origem, titulo_tipo, titulo_id } = parseBody(req.body);
      if (!empresa_origem || !titulo_tipo || !titulo_id) {
        return res.status(400).json({ erro: "empresa_origem, titulo_tipo e titulo_id são obrigatórios" });
      }
      const r = await httpsRequest("DELETE", supaHost(),
        `/rest/v1/financeiro_intercompany_alocacoes?empresa_origem=eq.${encodeURIComponent(String(empresa_origem).toLowerCase())}` +
        `&titulo_tipo=eq.${encodeURIComponent(titulo_tipo)}&titulo_id=eq.${encodeURIComponent(titulo_id)}`,
        null, { ...supaHeaders, Prefer: "return=minimal" });
      if (r.status >= 400) return res.status(400).json({ erro: r.text });
      return res.status(200).json({ ok: true });
    }

    if (req.method === "POST") {
      const { empresa, ano, mes, codigo_grupo, categoria_id, subitem, valor, observacao, usuario } = parseBody(req.body);
      if (!empresa || !ano || !mes || !codigo_grupo || valor === undefined) {
        return res.status(400).json({ erro: "empresa, ano, mes, codigo_grupo e valor são obrigatórios" });
      }
      const payload = JSON.stringify({
        empresa: String(empresa).toLowerCase(),
        ano: parseInt(ano, 10),
        mes: parseInt(mes, 10),
        codigo_grupo,
        categoria_id: categoria_id || null,
        subitem: subitem || null,
        valor: Number(valor) || 0,
        observacao: observacao || null,
        usuario: usuario || null,
        atualizado_em: new Date().toISOString(),
      });
      const r2 = await httpsRequest("POST", supaHost(), "/rest/v1/financeiro_lancamentos_manuais", payload,
        { ...supaHeaders, "Content-Length": Buffer.byteLength(payload), Prefer: "return=representation" });
      if (r2.status >= 400) return res.status(400).json({ erro: r2.text });
      const data2 = parseJSON(r2.text);
      return res.status(200).json(Array.isArray(data2) ? data2[0] : data2);
    }

    if (req.method === "PUT") {
      const { id, codigo_grupo, categoria_id, subitem, valor, observacao, usuario } = parseBody(req.body);
      if (!id) return res.status(400).json({ erro: "id obrigatório" });
      const updates = { atualizado_em: new Date().toISOString() };
      if (codigo_grupo !== undefined) updates.codigo_grupo = codigo_grupo;
      if (categoria_id !== undefined) updates.categoria_id = categoria_id || null;
      if (subitem !== undefined) updates.subitem = subitem || null;
      if (valor !== undefined) updates.valor = Number(valor) || 0;
      if (observacao !== undefined) updates.observacao = observacao || null;
      if (usuario !== undefined) updates.usuario = usuario || null;
      const payload = JSON.stringify(updates);
      const r = await httpsRequest("PATCH", supaHost(), "/rest/v1/financeiro_lancamentos_manuais?id=eq." + id, payload,
        { ...supaHeaders, "Content-Length": Buffer.byteLength(payload), Prefer: "return=minimal" });
      if (r.status >= 400) return res.status(400).json({ erro: r.text });
      return res.status(200).json({ ok: true });
    }

    if (req.method === "DELETE") {
      const { id } = parseBody(req.body);
      if (!id) return res.status(400).json({ erro: "id obrigatório" });
      const r = await httpsRequest("DELETE", supaHost(), "/rest/v1/financeiro_lancamentos_manuais?id=eq." + id, null,
        { ...supaHeaders, Prefer: "return=minimal" });
      if (r.status >= 400) return res.status(400).json({ erro: r.text });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ erro: "Método não permitido" });

  } catch (e) {
    return res.status(500).json({ erro: e.message });
  }
};
