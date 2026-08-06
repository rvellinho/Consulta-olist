// Relatório de Vendas por Notas Fiscais — endpoints separados para evitar timeout
const https = require("https");

const TOKEN_V2 = process.env.OLIST_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supaHeaders = {
  apikey: SUPABASE_KEY,
  Authorization: "Bearer " + SUPABASE_KEY,
  "Content-Type": "application/json",
};

// Serviços que não devem entrar no relatório (ex: cobrança interna, não é venda)
const DESCRICOES_SERVICO_EXCLUIDAS = ["serviço de apoio na área de vendas"];

// situação: 1=Pendente, 3=Cancelada, 5=Rejeitada, 10=Denegada — nunca contam.
// Tudo mais (2=Emitida, 6=Autorizada, 7=Emitida DANFE, 8=Registrada, etc) conta como válida —
// a Olist usa mais códigos de "emitida com sucesso" do que a documentação lista.
const SITUACOES_INVALIDAS = ["1", "3", "5", "10"];
// finalidade: 4, 7, 8 = Devolução/Retorno
const FINALIDADES_DEVOLUCAO = ["4", "7", "8"];
// situação de nota de serviço: 1=Pendente, 3=Cancelada — nunca contam.
// 2=Emitida, 4=Enviada (aguardando recibo) contam como válidas.
const SITUACOES_INVALIDAS_SERVICO = ["1", "3"];

function httpsRequest(method, hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method, headers }, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => resolve({ status: res.statusCode, text: d }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function parseJSON(text) { try { return JSON.parse(text); } catch { return {}; } }

// Normaliza número de nota pra comparação (remove zeros à esquerda) —
// assim "012662" cadastrado numa alteração casa com "12662" digitado por engano.
function normalizarNumero(numero) {
  const n = parseInt(String(numero).replace(/\D/g, ""), 10);
  return Number.isNaN(n) ? String(numero).trim() : String(n);
}

function formatarDataBR(isoDate) {
  const [y, m, d] = isoDate.split("-");
  return `${d}/${m}/${y}`;
}

// Busca as correções manuais cadastradas em "Alterações" pra um tipo de nota,
// já indexadas por número de nota normalizado.
async function buscarAlteracoes(tipoNota) {
  const supaHost = SUPABASE_URL.replace("https://", "");
  const r = await httpsRequest("GET", supaHost,
    `/rest/v1/alteracoes_relatorio?tipo_nota=eq.${tipoNota}&select=numero_nota,vendedor,data_emissao`,
    null, supaHeaders);
  const data = parseJSON(r.text);
  const mapa = {};
  (Array.isArray(data) ? data : []).forEach(a => { mapa[normalizarNumero(a.numero_nota)] = a; });
  return mapa;
}

async function buscarPaginaNotas(tipoNota, dataInicial, dataFinal, pagina) {
  const body = new URLSearchParams({
    token: TOKEN_V2, formato: "JSON",
    tipoNota, dataInicial, dataFinal, pagina: String(pagina),
  }).toString();
  const r = await httpsRequest("POST", "api.tiny.com.br",
    "/api2/notas.fiscais.pesquisa.php", body,
    { "Content-Type": "application/x-www-form-urlencoded" });
  const data = parseJSON(r.text);
  if (data.retorno && data.retorno.status === "Erro") {
    const codigoErro = data.retorno.codigo_erro;
    // Código 6 = nenhum registro encontrado — não é erro, é lista vazia
    if (codigoErro === "6") return [];
    throw new Error(data.retorno.erros?.[0]?.erro || "Erro ao pesquisar notas fiscais");
  }
  return data.retorno?.notas_fiscais || [];
}

async function buscarTodasNotas(tipoNota, dataInicial, dataFinal) {
  const todas = [];
  let pagina = 1;
  while (true) {
    const lista = await buscarPaginaNotas(tipoNota, dataInicial, dataFinal, pagina);
    lista.forEach(n => { if (n.nota_fiscal) todas.push(n.nota_fiscal); });
    if (lista.length < 100) break;
    pagina++;
    await sleep(600);
  }
  return todas.filter(n => !SITUACOES_INVALIDAS.includes(String(n.situacao)));
}

async function buscarPaginaNotasServico(dataInicial, dataFinal, pagina) {
  const body = new URLSearchParams({
    token: TOKEN_V2, formato: "JSON",
    dataInicial, dataFinal, pagina: String(pagina),
  }).toString();
  const r = await httpsRequest("POST", "api.tiny.com.br",
    "/api2/notas.servico.pesquisa.php", body,
    { "Content-Type": "application/x-www-form-urlencoded" });
  const data = parseJSON(r.text);
  if (data.retorno && data.retorno.status === "Erro") {
    const codigoErro = data.retorno.codigo_erro;
    // Código 6 = nenhum registro encontrado — não é erro, é lista vazia
    if (codigoErro === "6") return [];
    throw new Error(data.retorno.erros?.[0]?.erro || "Erro ao pesquisar notas de serviço");
  }
  return data.retorno?.notas_servico || [];
}

async function buscarTodasNotasServico(dataInicial, dataFinal) {
  const todas = [];
  let pagina = 1;
  while (true) {
    const lista = await buscarPaginaNotasServico(dataInicial, dataFinal, pagina);
    lista.forEach(n => { if (n.nota_servico) todas.push(n.nota_servico); });
    if (lista.length < 100) break;
    pagina++;
    await sleep(600);
  }
  return todas.filter(n => !SITUACOES_INVALIDAS_SERVICO.includes(String(n.situacao)));
}

// Quando a devolução é lançada referenciando a NF-e de venda original, a Olist
// grava esse texto padrão no campo "obs" da nota de devolução — usamos isso
// pra descobrir qual foi a nota de venda original e puxar o vendedor dela.
function extrairReferenciaOrigem(obs) {
  const mNumero = (obs || "").match(/N[uú]mero da NF-e referenciada:\s*(\d+)/i);
  const mData = (obs || "").match(/Data de emiss[ãa]o da NF-e referenciada:\s*(\d{2}\/\d{2}\/\d{4})/i);
  const mChave = (obs || "").match(/Chave de acesso da NF-e referenciada:\s*(\d+)/i);
  if (!mNumero || !mData) return null;
  return { numero: mNumero[1], data: mData[1], chave: mChave ? mChave[1] : null };
}

async function buscarVendedorDaNotaOrigem(referencia) {
  const body = new URLSearchParams({
    token: TOKEN_V2, formato: "JSON",
    tipoNota: "S", numero: referencia.numero,
    dataInicial: referencia.data, dataFinal: referencia.data,
  }).toString();
  const r = await httpsRequest("POST", "api.tiny.com.br",
    "/api2/notas.fiscais.pesquisa.php", body,
    { "Content-Type": "application/x-www-form-urlencoded" });
  const data = parseJSON(r.text);
  if (data.retorno?.status === "Erro") return null;
  const candidatas = (data.retorno?.notas_fiscais || []).map(n => n.nota_fiscal);
  const origem = referencia.chave
    ? candidatas.find(n => n.chave_acesso === referencia.chave)
    : candidatas[0];
  return origem?.nome_vendedor || null;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const acao = req.query.acao;
  const { dataInicial, dataFinal } = req.query;

  try {
    // ── AÇÃO: notas de venda (saída) no período, detalhadas por dia/vendedor ─
    if (acao === "vendas") {
      if (!dataInicial || !dataFinal) return res.status(400).json({ erro: "dataInicial e dataFinal obrigatórios" });
      const notas = await buscarTodasNotas("S", dataInicial, dataFinal);
      const alteracoes = await buscarAlteracoes("produto");
      return res.status(200).json({
        notas: notas.map(n => {
          const alt = alteracoes[normalizarNumero(n.numero)];
          return {
            numero: n.numero,
            data: alt?.data_emissao ? formatarDataBR(alt.data_emissao) : n.data_emissao,
            vendedor: alt?.vendedor || n.nome_vendedor || "Sem vendedor",
            valor: parseFloat(n.valor || 0),
          };
        }),
      });
    }

    // ── AÇÃO: notas de entrada candidatas a devolução no período ─────
    if (acao === "entradas") {
      if (!dataInicial || !dataFinal) return res.status(400).json({ erro: "dataInicial e dataFinal obrigatórios" });
      const notas = await buscarTodasNotas("E", dataInicial, dataFinal);
      return res.status(200).json({
        notas: notas.map(n => ({ id: n.id, numero: n.numero, valor: parseFloat(n.valor || 0) })),
      });
    }

    // ── AÇÃO: notas de serviço emitidas no período (lista bruta) ─────
    // A exclusão de "Serviço de apoio na área de vendas" é checada nota a nota
    // pelo frontend via acao=servico-detalhe, pra não fazer loop pesado aqui
    // dentro do serverless (timeout).
    if (acao === "servicos") {
      if (!dataInicial || !dataFinal) return res.status(400).json({ erro: "dataInicial e dataFinal obrigatórios" });
      const notas = await buscarTodasNotasServico(dataInicial, dataFinal);
      const alteracoes = await buscarAlteracoes("servico");
      return res.status(200).json({
        notas: notas.map(n => {
          const alt = alteracoes[normalizarNumero(n.numero)];
          return {
            id: n.id,
            numero: n.numero,
            vendedor: alt?.vendedor || n.nome_vendedor || "Sem vendedor",
            valor: parseFloat(n.valor || 0),
          };
        }),
      });
    }

    // ── AÇÃO: verifica se a nota de serviço é do tipo excluído do relatório ─
    if (acao === "servico-detalhe") {
      const id = req.query.id;
      if (!id) return res.status(400).json({ erro: "id obrigatorio" });
      const body = new URLSearchParams({ token: TOKEN_V2, id: String(id), formato: "JSON" }).toString();
      const r = await httpsRequest("POST", "api.tiny.com.br", "/api2/nota.servico.obter.php",
        body, { "Content-Type": "application/x-www-form-urlencoded" });
      const nota = parseJSON(r.text).retorno?.nota_fiscal;
      const descricao = nota?.servico?.descricao || "";
      const excluir = DESCRICOES_SERVICO_EXCLUIDAS.some(d => descricao.toLowerCase().includes(d));
      return res.status(200).json({ descricao, excluir });
    }

    // ── AÇÃO: detalhe de uma nota (pra checar a finalidade) ──────────
    if (acao === "nota") {
      const id = req.query.id;
      if (!id) return res.status(400).json({ erro: "id obrigatorio" });
      const body = new URLSearchParams({ token: TOKEN_V2, id: String(id), formato: "JSON" }).toString();
      const r = await httpsRequest("POST", "api.tiny.com.br", "/api2/nota.fiscal.obter.php",
        body, { "Content-Type": "application/x-www-form-urlencoded" });
      const nota = parseJSON(r.text).retorno?.nota_fiscal;
      if (!nota) return res.status(200).json({ finalidade: null, valor: 0 });

      const ehDevolucao = FINALIDADES_DEVOLUCAO.includes(String(nota.finalidade));
      let vendedor = null;
      if (ehDevolucao) {
        const referencia = extrairReferenciaOrigem(nota.obs);
        if (referencia) {
          await sleep(400);
          vendedor = await buscarVendedorDaNotaOrigem(referencia);
        }
        const alteracoes = await buscarAlteracoes("devolucao");
        const alt = alteracoes[normalizarNumero(nota.numero)];
        if (alt?.vendedor) vendedor = alt.vendedor;
      }

      return res.status(200).json({
        finalidade: String(nota.finalidade ?? ""),
        valor: parseFloat(nota.valor_nota || 0),
        ehDevolucao,
        vendedor,
      });
    }

    return res.status(400).json({ erro: "acao invalida. Use: vendas, entradas, nota, servicos, servico-detalhe" });

  } catch (e) {
    return res.status(500).json({ erro: e.message, stack: e.stack });
  }
};
