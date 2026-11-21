// Relatório de Vendas por Notas Fiscais — endpoints separados para evitar timeout.
// A coleta de dados na Olist fica em api/_lib/relatorio-coleta.js (compartilhada
// com o job automático de sync diário, acao=sync-diario abaixo — antes era um
// arquivo próprio, api/relatorio-sync-diario.js, fundido aqui pra caber no
// limite de 12 Serverless Functions do plano Hobby da Vercel — ver CLAUDE.md
// "Vercel serverless — limitações").
const lib = require("./_lib/relatorio-coleta");
const {
  SUPABASE_URL, supaHeaders,
  DESCRICOES_SERVICO_EXCLUIDAS, FINALIDADES_DEVOLUCAO,
  MARCADOR_REPRESENTACAO, MARGEM_DIAS_REPRESENTACAO,
  MARCADOR_AGUIA, MARGEM_DIAS_AGUIA, MARCADOR_VENDA_FUTURA_EXCLUIR,
  httpsRequest, sleep, parseJSON, normalizarNumero, formatarDataBR, parseDataBR, somarDiasBR, hojeBR, paraIso,
  buscarAlteracoes, buscarClientePorCnpj, temMarcador,
  buscarMapeamentoResponsavel, resolverResponsavel,
  buscarTodasNotas, buscarTodasNotasServico, buscarDetalheNotaServico, buscarDetalheNotaFiscal,
  buscarTodosPedidos, buscarDetalhePedido,
  extrairReferenciaOrigem, buscarVendedorDaNotaOrigem,
  salvarNoCache,
} = lib;

// ============================================================================
// Sync diário (antigo api/relatorio-sync-diario.js) — acionado via
// ?acao=sync-diario, nunca chamado pelo frontend (só pelo cron no vercel.json).
// Cobre só os últimos 7 dias (janela curta de propósito: com navegador dá pra
// fazer loop longo, mas aqui dentro do serverless o tempo de execução é
// limitado).
// ============================================================================

const DIAS_JANELA_DIARIA = 7;

async function coletarProdutosSync(dataInicial, dataFinal) {
  const notas = await buscarTodasNotas("S", dataInicial, dataFinal);
  const alteracoes = await buscarAlteracoes("produto");
  const resultado = [];
  for (const n of notas) {
    await sleep(600);
    const detalhe = await buscarDetalheNotaFiscal(n.id);
    if (temMarcador(detalhe, MARCADOR_VENDA_FUTURA_EXCLUIR)) continue;
    const alt = alteracoes[normalizarNumero(n.numero)];
    resultado.push({
      numero: n.numero, id: n.id,
      data: alt?.data_emissao ? formatarDataBR(alt.data_emissao) : n.data_emissao,
      vendedor: alt?.vendedor || n.nome_vendedor || "Sem vendedor",
      valor: parseFloat(n.valor || 0),
      clienteCnpj: n.cliente?.cpf_cnpj || null,
      clienteRazaoSocial: n.cliente?.nome || null,
    });
  }
  return resultado;
}

async function coletarDevolucoesSync(dataInicial, dataFinal) {
  const entradas = await buscarTodasNotas("E", dataInicial, dataFinal);
  const alteracoes = await buscarAlteracoes("devolucao");
  const resultado = [];
  for (const entrada of entradas) {
    await sleep(600);
    const resp = await httpsRequest("POST", "api.tiny.com.br", "/api2/nota.fiscal.obter.php",
      new URLSearchParams({ token: lib.TOKEN_V2, id: String(entrada.id), formato: "JSON" }).toString(),
      { "Content-Type": "application/x-www-form-urlencoded" });
    const nota = parseJSON(resp.text).retorno?.nota_fiscal;
    if (!nota) continue;
    const ehDevolucao = FINALIDADES_DEVOLUCAO.includes(String(nota.finalidade));
    if (!ehDevolucao) continue;

    let vendedor = null;
    const referencia = extrairReferenciaOrigem(nota.obs);
    if (referencia) {
      await sleep(400);
      vendedor = await buscarVendedorDaNotaOrigem(referencia);
    }
    const alt = alteracoes[normalizarNumero(nota.numero)];
    if (alt?.vendedor) vendedor = alt.vendedor;

    resultado.push({
      numero: nota.numero, id: nota.id,
      data: nota.data_emissao,
      vendedor: vendedor || "Sem vendedor",
      valor: parseFloat(nota.valor_nota || 0),
      clienteCnpj: nota.cliente?.cpf_cnpj || null,
      clienteRazaoSocial: nota.cliente?.nome || null,
    });
  }
  return resultado;
}

async function coletarServicosSync(dataInicial, dataFinal) {
  const notas = await buscarTodasNotasServico(dataInicial, dataFinal);
  const alteracoes = await buscarAlteracoes("servico");
  const resultado = [];
  for (const n of notas) {
    await sleep(600);
    const detalhe = await buscarDetalheNotaServico(n.id);
    const descricao = detalhe?.servico?.descricao || "";
    const excluido = DESCRICOES_SERVICO_EXCLUIDAS.some(d => descricao.toLowerCase().includes(d));
    if (excluido) continue;
    const alt = alteracoes[normalizarNumero(n.numero)];
    resultado.push({
      numero: n.numero, id: n.id,
      data: n.data_emissao,
      vendedor: alt?.vendedor || n.nome_vendedor || "Sem vendedor",
      valor: parseFloat(n.valor || 0),
      clienteCnpj: detalhe?.cliente?.cpf_cnpj || null,
      clienteRazaoSocial: detalhe?.cliente?.nome || null,
    });
  }
  return resultado;
}

async function coletarPedidosMarcadosSync(marcador, margemDias, dataInicial, dataFinal, tipoAlteracao) {
  const inicioBuscado = somarDiasBR(dataInicial, -margemDias);
  const fimBuscado = somarDiasBR(dataFinal, margemDias);
  const pedidos = await buscarTodosPedidos("faturado", marcador, inicioBuscado, fimBuscado);

  const inicioPeriodo = parseDataBR(dataInicial);
  const fimPeriodo = parseDataBR(dataFinal);
  const noPeriodo = pedidos.filter(p => {
    const dp = parseDataBR(p.data_prevista);
    return dp && dp >= inicioPeriodo && dp <= fimPeriodo;
  });

  const alteracoes = await buscarAlteracoes(tipoAlteracao);
  const resultado = [];
  for (const p of noPeriodo) {
    await sleep(600);
    const detalhe = await buscarDetalhePedido(p.id);
    const temNotaFiscal = !!(detalhe && Number(detalhe.id_nota_fiscal) > 0);
    if (temNotaFiscal) continue;
    const alt = alteracoes[normalizarNumero(p.numero)];
    resultado.push({
      numero: p.numero, id: p.id,
      data: alt?.data_emissao ? formatarDataBR(alt.data_emissao) : p.data_prevista,
      vendedor: alt?.vendedor || p.nome_vendedor || "Sem vendedor",
      valor: parseFloat(p.valor || 0),
      clienteCnpj: detalhe?.cliente?.cpf_cnpj || null,
      clienteRazaoSocial: detalhe?.cliente?.nome || null,
    });
  }
  return resultado;
}

async function anexarCodigoClienteSync(linhas) {
  for (const l of linhas) {
    if (!l.clienteCnpj) continue;
    const info = await buscarClientePorCnpj(l.clienteCnpj);
    if (info) l.clienteCodigo = info.codigo;
  }
  return linhas;
}

async function executarSyncDiario(req, res) {
  // Protege contra chamadas externas — só o cron da Vercel (ou um admin com o segredo) pode acionar.
  const segredo = process.env.CRON_SECRET;
  if (segredo && req.headers.authorization !== `Bearer ${segredo}`) {
    return res.status(401).json({ erro: "não autorizado" });
  }

  try {
    const hoje = hojeBR();
    const dataInicial = somarDiasBR(hoje, -DIAS_JANELA_DIARIA);
    const dataFinal = hoje;

    const produtos = await anexarCodigoClienteSync(await coletarProdutosSync(dataInicial, dataFinal));
    const aguia = await anexarCodigoClienteSync(await coletarPedidosMarcadosSync(MARCADOR_AGUIA, MARGEM_DIAS_AGUIA, dataInicial, dataFinal, "aguia"));
    const devolucoes = await anexarCodigoClienteSync(await coletarDevolucoesSync(dataInicial, dataFinal));
    const servicos = await anexarCodigoClienteSync(await coletarServicosSync(dataInicial, dataFinal));
    const representacao = await anexarCodigoClienteSync(await coletarPedidosMarcadosSync(MARCADOR_REPRESENTACAO, MARGEM_DIAS_REPRESENTACAO, dataInicial, dataFinal, "representacao"));

    await salvarNoCache("produto", dataInicial, dataFinal, produtos);
    await salvarNoCache("aguia", dataInicial, dataFinal, aguia);
    await salvarNoCache("devolucao", dataInicial, dataFinal, devolucoes);
    await salvarNoCache("servico", dataInicial, dataFinal, servicos);
    await salvarNoCache("representacao", dataInicial, dataFinal, representacao);

    return res.status(200).json({
      ok: true,
      periodo: { dataInicial, dataFinal },
      contagens: { produtos: produtos.length, aguia: aguia.length, devolucoes: devolucoes.length, servicos: servicos.length, representacao: representacao.length },
    });
  } catch (e) {
    return res.status(500).json({ erro: e.message, stack: e.stack });
  }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const acao = req.query.acao;
  const { dataInicial, dataFinal } = req.query;

  // Sync diário (cron) — nunca chamado pelo frontend, ver vercel.json.
  if (acao === "sync-diario") {
    return executarSyncDiario(req, res);
  }

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
            id: n.id,
            numero: n.numero,
            data: alt?.data_emissao ? formatarDataBR(alt.data_emissao) : n.data_emissao,
            vendedor: alt?.vendedor || n.nome_vendedor || "Sem vendedor",
            valor: parseFloat(n.valor || 0),
            clienteCnpj: n.cliente?.cpf_cnpj || null,
            clienteRazaoSocial: n.cliente?.nome || null,
          };
        }),
      });
    }

    // ── AÇÃO: verifica se a nota de venda é "vf-faturamento" (excluída) ──
    // Notas com marcador "vf-faturamento" são só a cobrança antecipada de uma
    // venda futura — a entrega de fato vem numa nota separada (vf-entrega).
    if (acao === "venda-detalhe") {
      const id = req.query.id;
      if (!id) return res.status(400).json({ erro: "id obrigatorio" });
      const nota = await buscarDetalheNotaFiscal(id);
      const excluir = temMarcador(nota, MARCADOR_VENDA_FUTURA_EXCLUIR);
      return res.status(200).json({ excluir });
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
            data: n.data_emissao,
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
      const nota = await buscarDetalheNotaServico(id);
      const descricao = nota?.servico?.descricao || "";
      const excluir = DESCRICOES_SERVICO_EXCLUIDAS.some(d => descricao.toLowerCase().includes(d));
      return res.status(200).json({
        descricao, excluir,
        clienteCnpj: nota?.cliente?.cpf_cnpj || null,
        clienteRazaoSocial: nota?.cliente?.nome || null,
      });
    }

    // ── AÇÃO: pedidos de representação faturados no período (lista bruta) ─
    // Ainda precisa checar id_nota_fiscal (acao=representacao-detalhe) pra
    // garantir que não foi emitida NF nossa nesse meio tempo.
    if (acao === "representacao") {
      if (!dataInicial || !dataFinal) return res.status(400).json({ erro: "dataInicial e dataFinal obrigatórios" });
      const inicioBuscado = somarDiasBR(dataInicial, -MARGEM_DIAS_REPRESENTACAO);
      const fimBuscado = somarDiasBR(dataFinal, MARGEM_DIAS_REPRESENTACAO);
      const pedidos = await buscarTodosPedidos("faturado", MARCADOR_REPRESENTACAO, inicioBuscado, fimBuscado);

      const inicioPeriodo = parseDataBR(dataInicial);
      const fimPeriodo = parseDataBR(dataFinal);
      const noPeriodo = pedidos.filter(p => {
        const dp = parseDataBR(p.data_prevista);
        return dp && dp >= inicioPeriodo && dp <= fimPeriodo;
      });

      const alteracoes = await buscarAlteracoes("representacao");
      return res.status(200).json({
        notas: noPeriodo.map(p => {
          const alt = alteracoes[normalizarNumero(p.numero)];
          return {
            id: p.id,
            numero: p.numero,
            data: alt?.data_emissao ? formatarDataBR(alt.data_emissao) : p.data_prevista,
            vendedor: alt?.vendedor || p.nome_vendedor || "Sem vendedor",
            valor: parseFloat(p.valor || 0),
          };
        }),
      });
    }

    // ── AÇÃO: verifica se o pedido de representação já tem NF nossa ──
    if (acao === "representacao-detalhe") {
      const id = req.query.id;
      if (!id) return res.status(400).json({ erro: "id obrigatorio" });
      const pedido = await buscarDetalhePedido(id);
      const temNotaFiscal = !!(pedido && Number(pedido.id_nota_fiscal) > 0);
      return res.status(200).json({
        temNotaFiscal,
        clienteCnpj: pedido?.cliente?.cpf_cnpj || null,
        clienteRazaoSocial: pedido?.cliente?.nome || null,
      });
    }

    // ── AÇÃO: pedidos "aguia" (faturados por outro CNPJ nosso) no período ──
    // Formato igual ao de "vendas" (numero/data/vendedor/valor) pra entrar
    // junto na grade por dia/vendedor, não como linha separada.
    if (acao === "aguia") {
      if (!dataInicial || !dataFinal) return res.status(400).json({ erro: "dataInicial e dataFinal obrigatórios" });
      const inicioBuscado = somarDiasBR(dataInicial, -MARGEM_DIAS_AGUIA);
      const fimBuscado = somarDiasBR(dataFinal, MARGEM_DIAS_AGUIA);
      const pedidos = await buscarTodosPedidos("faturado", MARCADOR_AGUIA, inicioBuscado, fimBuscado);

      const inicioPeriodo = parseDataBR(dataInicial);
      const fimPeriodo = parseDataBR(dataFinal);
      const noPeriodo = pedidos.filter(p => {
        const dp = parseDataBR(p.data_prevista);
        return dp && dp >= inicioPeriodo && dp <= fimPeriodo;
      });

      const alteracoes = await buscarAlteracoes("aguia");
      return res.status(200).json({
        notas: noPeriodo.map(p => {
          const alt = alteracoes[normalizarNumero(p.numero)];
          return {
            id: p.id,
            numero: p.numero,
            data: alt?.data_emissao ? formatarDataBR(alt.data_emissao) : p.data_prevista,
            vendedor: alt?.vendedor || p.nome_vendedor || "Sem vendedor",
            valor: parseFloat(p.valor || 0),
          };
        }),
      });
    }

    // ── AÇÃO: verifica se o pedido "aguia" já tem NF nossa ───────────
    if (acao === "aguia-detalhe") {
      const id = req.query.id;
      if (!id) return res.status(400).json({ erro: "id obrigatorio" });
      const pedido = await buscarDetalhePedido(id);
      const temNotaFiscal = !!(pedido && Number(pedido.id_nota_fiscal) > 0);
      return res.status(200).json({
        temNotaFiscal,
        clienteCnpj: pedido?.cliente?.cpf_cnpj || null,
        clienteRazaoSocial: pedido?.cliente?.nome || null,
      });
    }

    // ── AÇÃO: detalhe de uma nota (pra checar a finalidade) ──────────
    if (acao === "nota") {
      const id = req.query.id;
      if (!id) return res.status(400).json({ erro: "id obrigatorio" });
      const nota = await buscarDetalheNotaFiscal(id);
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
        data: nota.data_emissao,
        valor: parseFloat(nota.valor_nota || 0),
        ehDevolucao,
        vendedor,
        clienteCnpj: nota.cliente?.cpf_cnpj || null,
        clienteRazaoSocial: nota.cliente?.nome || null,
      });
    }

    // ── AÇÃO: lê o relatório já processado do cache (rápido, sem Olist) ──
    if (acao === "cache") {
      if (!dataInicial || !dataFinal) return res.status(400).json({ erro: "dataInicial e dataFinal obrigatórios" });
      const supaHost = SUPABASE_URL.replace("https://", "");
      const isoInicial = paraIso(dataInicial);
      const isoFinal = paraIso(dataFinal);

      const [rLinhas, rStatus] = await Promise.all([
        httpsRequest("GET", supaHost,
          `/rest/v1/relatorio_cache?data=gte.${isoInicial}&data=lte.${isoFinal}&select=*`,
          null, supaHeaders),
        httpsRequest("GET", supaHost,
          "/rest/v1/relatorio_cache_status?id=eq.1&select=ultima_atualizacao,sincronizado_desde",
          null, supaHeaders),
      ]);
      const linhasBrutas = parseJSON(rLinhas.text);
      const status = parseJSON(rStatus.text)?.[0] || {};

      // Reaplica as correções da tela de Alterações e o DE-PARA de responsável
      // por cima do cache — assim uma correção ou uma mudança no DE-PARA já
      // aparece na hora, sem esperar o próximo "Atualizar dados".
      const tiposPresentes = [...new Set((Array.isArray(linhasBrutas) ? linhasBrutas : []).map(l => l.tipo))];
      const mapaAlteracoesPorTipo = {};
      const [_, mapeamentoResponsavel] = await Promise.all([
        Promise.all(tiposPresentes.map(async tipo => { mapaAlteracoesPorTipo[tipo] = await buscarAlteracoes(tipo); })),
        buscarMapeamentoResponsavel(),
      ]);

      const linhas = (Array.isArray(linhasBrutas) ? linhasBrutas : []).map(l => {
        const alt = mapaAlteracoesPorTipo[l.tipo]?.[normalizarNumero(l.numero_nota)];
        const vendedor = alt?.vendedor || l.vendedor;
        return {
          ...l,
          vendedor,
          data: alt?.data_emissao || l.data,
          responsavel: resolverResponsavel(mapeamentoResponsavel, vendedor, l.tipo),
        };
      });

      return res.status(200).json({
        linhas,
        ultimaAtualizacao: status.ultima_atualizacao || null,
        sincronizadoDesde: status.sincronizado_desde || null,
      });
    }

    // ── AÇÃO: grava no cache um lote já coletado pela tela ───────────
    if (acao === "cache-salvar" && req.method === "POST") {
      const corpo = typeof req.body === "string" ? parseJSON(req.body) : (req.body || {});
      const { tipo, dataInicial: di, dataFinal: df, linhas } = corpo;
      if (!tipo || !di || !df || !Array.isArray(linhas)) {
        return res.status(400).json({ erro: "tipo, dataInicial, dataFinal e linhas são obrigatórios" });
      }
      await salvarNoCache(tipo, di, df, linhas);
      return res.status(200).json({ ok: true, salvos: linhas.length });
    }

    return res.status(400).json({
      erro: "acao invalida. Use: vendas, venda-detalhe, entradas, nota, servicos, servico-detalhe, representacao, representacao-detalhe, aguia, aguia-detalhe, cache, cache-salvar",
    });

  } catch (e) {
    return res.status(500).json({ erro: e.message, stack: e.stack });
  }
};
