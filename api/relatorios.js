// Relatório de Vendas por Notas Fiscais — endpoints separados para evitar timeout.
// A coleta de dados na Olist fica em api/_lib/relatorio-coleta.js (compartilhada
// com o job automático em api/relatorio-sync-diario.js).
const lib = require("./_lib/relatorio-coleta");
const {
  SUPABASE_URL, supaHeaders,
  DESCRICOES_SERVICO_EXCLUIDAS, FINALIDADES_DEVOLUCAO,
  MARCADOR_REPRESENTACAO, MARGEM_DIAS_REPRESENTACAO,
  MARCADOR_AGUIA, MARGEM_DIAS_AGUIA, MARCADOR_VENDA_FUTURA_EXCLUIR,
  httpsRequest, sleep, parseJSON, normalizarNumero,
  formatarDataBR, parseDataBR, somarDiasBR, paraIso,
  buscarAlteracoes, temMarcador,
  buscarTodasNotas, buscarTodasNotasServico, buscarDetalheNotaServico, buscarDetalheNotaFiscal,
  buscarTodosPedidos, buscarDetalhePedido,
  extrairReferenciaOrigem, buscarVendedorDaNotaOrigem,
  salvarNoCache,
} = lib;

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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

      // Reaplica as correções da tela de Alterações por cima do cache — assim
      // uma correção feita agora já aparece na hora, sem esperar o próximo
      // "Atualizar dados".
      const tiposPresentes = [...new Set((Array.isArray(linhasBrutas) ? linhasBrutas : []).map(l => l.tipo))];
      const mapaAlteracoesPorTipo = {};
      await Promise.all(tiposPresentes.map(async tipo => { mapaAlteracoesPorTipo[tipo] = await buscarAlteracoes(tipo); }));

      const linhas = (Array.isArray(linhasBrutas) ? linhasBrutas : []).map(l => {
        const alt = mapaAlteracoesPorTipo[l.tipo]?.[normalizarNumero(l.numero_nota)];
        if (!alt) return l;
        return {
          ...l,
          vendedor: alt.vendedor || l.vendedor,
          data: alt.data_emissao || l.data,
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
