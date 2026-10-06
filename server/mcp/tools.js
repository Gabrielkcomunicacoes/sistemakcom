import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { all, get, audit } from '../db.js';
import { todayBR, addDays } from '../metrics.js';
import { REAL_ID } from '../sync.js';
import {
  ToolError, clientOf, channelsOf, performance, searchTerms, creatives, campaignSettings, changeHistory,
  accountInfo, googleConversionActions, attributionInfo, conversionDefinition, metaResultGroups,
} from './ads.js';

const INSTRUCTIONS = `Dados somente leitura de campanhas Meta Ads e Google Ads dos clientes da agência KCOM.
- Comece por list_clients para obter os IDs dos clientes; as contas vêm do cadastro, nunca informe IDs de conta.
- Antes de interpretar resultados, leia get_reporting_config: ele diz qual é o objetivo/meta, a moeda, o fuso e o que conta como conversão.
- Conversas (mensagens), visitas à página, leads e vendas vêm em colunas SEPARADAS. Não some nem compare como se fossem o mesmo resultado; "conversions" é a definição de resultado de cada plataforma.
- Sempre cite o período e os avisos (warnings) ao reportar números. Datas em AAAA-MM-DD, fuso America/Sao_Paulo.
- Sem datas, as consultas usam os 7 últimos dias completos (até ontem).`;

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use AAAA-MM-DD');
const clientId = z.number().int().positive().describe('ID do cliente (de list_clients)');
const platform = z.enum(['all', 'meta', 'google']).default('all').describe('Plataforma; "all" consulta Meta e Google');
const campaignId = z.string().regex(/^\d{1,20}$/).optional().describe('Filtra por ID da campanha');
const page = z.number().int().min(1).default(1).describe('Página (começa em 1)');
const pageSize = z.number().int().min(1).max(200).default(50).describe('Itens por página (máx. 200)');
const period = {
  from: dateStr.optional().describe('Data inicial. Padrão: 7 dias completos atrás'),
  to: dateStr.optional().describe('Data final (inclusive). Padrão: ontem'),
};
const defaults = ({ from, to }) => {
  const t = to ?? addDays(todayBR(), -1);
  return { from: from ?? addDays(t, -6), to: t };
};

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

/* ------------------------------ Tools do cadastro ------------------------------ */
function listClients({ include_inactive }) {
  const clients = all(
    `SELECT c.id, c.name, c.active, c.monthly_budget, u.name manager FROM clients c LEFT JOIN users u ON u.id = c.manager_id
      ${include_inactive ? '' : 'WHERE c.active = 1'} ORDER BY c.name COLLATE NOCASE`,
  );
  const chs = all(`SELECT ch.client_id, ch.id, ch.platform, ch.account_id, ch.metric, ch.target, ch.active, s.last_sync, s.error
                     FROM channels ch LEFT JOIN channel_status s ON s.channel_id = ch.id`);
  return {
    clients: clients.map((c) => ({
      id: c.id, name: c.name, active: !!c.active, manager: c.manager, monthly_budget: c.monthly_budget,
      accounts: chs.filter((x) => x.client_id === c.id).map((x) => ({
        platform: x.platform, account_id: x.account_id, active: !!x.active, objective_metric: x.metric, target: x.target,
        configured: REAL_ID.test(x.account_id), panel_last_sync: x.last_sync ? new Date(x.last_sync * 1000).toISOString() : null, panel_sync_error: x.error ?? null,
      })),
    })),
    today: todayBR(),
  };
}

const OBJECTIVE = {
  cpl: 'Custo por lead/conversa (CPL): menor é melhor', cpa: 'Custo por aquisição/venda (CPA): menor é melhor',
  followers: 'Novos seguidores (custo por seguidor)', reach: 'Alcance diário (pessoas alcançadas)',
};

async function reportingConfig({ client_id }) {
  const c = clientOf(client_id);
  const chs = all('SELECT * FROM channels WHERE client_id = ? ORDER BY platform', client_id);
  const platforms = await Promise.all(chs.map(async (ch) => {
    const st = get('SELECT balance, last_sync, error, funding FROM channel_status WHERE channel_id = ?', ch.id);
    const o = {
      platform: ch.platform, account_id: ch.account_id, active: !!ch.active,
      objective: { metric: ch.metric, description: OBJECTIVE[ch.metric] ?? ch.metric, target: ch.target, target_unit: ch.metric === 'reach' ? 'pessoas/dia' : ch.metric === 'followers' ? 'custo por seguidor (moeda da conta)' : 'custo por resultado (moeda da conta)' },
      conversion_definition: conversionDefinition(ch), attribution: attributionInfo(ch),
      panel: { balance: st?.balance ?? null, funding: st?.funding ?? null, last_sync: st?.last_sync ? new Date(st.last_sync * 1000).toISOString() : null, sync_error: st?.error ?? null },
    };
    if (ch.platform === 'meta') o.counted_events = metaResultGroups(ch);
    if (!ch.active || !REAL_ID.test(ch.account_id)) return o;
    try { Object.assign(o, await accountInfo(ch)); } catch (e) { o.account_error = String(e.message).slice(0, 200); }
    if (ch.platform === 'google') {
      try { o.conversion_actions = await googleConversionActions(ch); } catch (e) { o.conversion_actions_error = String(e.message).slice(0, 200); }
    }
    return o;
  }));
  return {
    client: { id: c.id, name: c.name, active: !!c.active },
    budget: { monthly: c.monthly_budget, currency_note: 'Verba mensal cadastrada no painel (moeda da conta).' },
    context: {
      briefing: c.briefing ?? null, products_services: c.products ?? null, prices: c.pricing ?? null, service_region: c.region ?? null,
      goals: c.goals ?? null, notes: c.notes ?? null,
    },
    platforms,
    definitions: {
      conversations: 'Conversas iniciadas por mensagem (Meta: messaging_conversation_started_7d). No Google, ligações/contatos.',
      landing_page_views: 'Visitas: visualizações da página de destino após o clique (Meta: landing_page_view; Google: conversões de categoria PAGE_VIEW).',
      leads: 'Cadastros/formulários (Meta: lead; Google: categorias de lead).',
      purchases: 'Vendas registradas pela plataforma (compras do pixel/conversões de compra); não são vendas do CRM.',
      conversions: 'Resultado principal da plataforma conforme conversion_definition. Não compare diretamente Meta e Google.',
      reach_frequency: 'Pessoas únicas; não é somável entre campanhas/anúncios nem entre dias.',
    },
    data_freshness: { fetched_at: new Date().toISOString() },
  };
}

/* ------------------------------ Registro ------------------------------ */
function wrap(name, user, ip, fn) {
  return async (args) => {
    audit({ user: { id: user.userId, name: user.userName }, ip }, 'mcp_tool', `${name} ${JSON.stringify(args).slice(0, 300)}`);
    try {
      const data = await fn(args);
      // todas as plataformas falharam: é erro da ferramenta, não "resultado vazio"
      const failed = Array.isArray(data?.platforms) && data.platforms.length > 0 && data.platforms.every((p) => p.error);
      return { ...(failed ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(data) }] };
    } catch (e) {
      const known = e instanceof ToolError;
      if (!known) console.error(`[mcp] ${name}:`, e.message);
      return { isError: true, content: [{ type: 'text', text: known ? e.message : `Erro ao consultar as plataformas: ${String(e.message).slice(0, 200)}` }] };
    }
  };
}

export function buildServer(user, ip) {
  const s = new McpServer({ name: 'kcom-ads', version: '1.0.0' }, { instructions: INSTRUCTIONS });
  const tool = (name, title, description, inputSchema, fn) => s.registerTool(name, { title, description, inputSchema, annotations: READ_ONLY }, wrap(name, user, ip, fn));

  tool('list_clients', 'Listar clientes',
    'Lista os clientes monitorados com seus IDs e as contas Meta/Google vinculadas, objetivo e meta de cada conta e a data da última sincronização do painel.',
    { include_inactive: z.boolean().default(false).describe('Inclui clientes desativados') }, listClients);

  tool('get_reporting_config', 'Configuração de relatório do cliente',
    'Objetivo e meta por plataforma, moeda, fuso, janela de atribuição, definição do que conta como conversão (e ações de conversão do Google), verba mensal e contexto do cliente (briefing, produtos/serviços, preços, região, metas). Leia antes de analisar resultados.',
    { client_id: clientId }, reportingConfig);

  tool('get_performance', 'Desempenho por campanha, conjunto/grupo ou anúncio',
    'Investimento, impressões, alcance, frequência, cliques, visitas (landing page views), conversas, leads, vendas e conversões, com CTR/CPC/CPM e custos por resultado. level: account, campaign, adset (conjunto no Meta, grupo de anúncios no Google) ou ad. Opcionalmente com série diária (daily=true) e comparativo com o período anterior. Conversas, visitas, leads e vendas vêm em colunas separadas; cada plataforma traz sua definição de conversão e janela de atribuição.',
    {
      client_id: clientId, platform, level: z.enum(['account', 'campaign', 'adset', 'ad']).default('campaign'), ...period,
      daily: z.boolean().default(false).describe('Inclui a série diária por item e o total diário'),
      campaign_id: campaignId,
      compare: z.enum(['none', 'previous_period', 'previous_year']).default('none').describe('Período comparativo automático'),
      compare_from: dateStr.optional().describe('Início de um período comparativo manual (use com compare_to)'),
      compare_to: dateStr.optional().describe('Fim do período comparativo manual'),
      page, page_size: pageSize,
    },
    (a) => performance({
      clientId: a.client_id, platform: a.platform, level: a.level, ...defaults(a), daily: a.daily, campaignId: a.campaign_id,
      compare: { compare: a.compare, compare_from: a.compare_from, compare_to: a.compare_to }, page: a.page, pageSize: a.page_size,
    }));

  tool('get_search_terms', 'Termos de pesquisa do Google',
    'Termos de pesquisa que acionaram os anúncios no Google Ads (só Google), com impressões, cliques, gasto e conversões por termo e grupo de anúncios.',
    {
      client_id: clientId, ...period, campaign_id: campaignId,
      min_cost: z.number().min(0).optional().describe('Só termos com gasto mínimo'),
      only_converting: z.boolean().default(false).describe('Só termos que converteram'),
      order_by: z.enum(['cost', 'clicks', 'impressions', 'conversions']).default('cost'), page, page_size: pageSize,
    },
    (a) => searchTerms({ clientId: a.client_id, ...defaults(a), campaignId: a.campaign_id, minCost: a.min_cost, onlyConverting: a.only_converting, orderBy: a.order_by, page: a.page, pageSize: a.page_size }));

  tool('get_creatives', 'Criativos dos anúncios',
    'Textos principais, títulos, descrições, CTA, imagens/vídeos acessíveis, página de destino e link de visualização de cada anúncio, com desempenho opcional no período.',
    {
      client_id: clientId, platform, status: z.enum(['active', 'paused', 'all']).default('active'), ...period, campaign_id: campaignId,
      include_performance: z.boolean().default(true).describe('Inclui métricas do período por anúncio'), page, page_size: pageSize.default(30),
    },
    (a) => creatives({ clientId: a.client_id, platform: a.platform, status: a.status, ...defaults(a), campaignId: a.campaign_id, includePerformance: a.include_performance, page: a.page, pageSize: a.page_size }));

  tool('get_campaign_settings', 'Configurações das campanhas',
    'Configuração atual das campanhas: objetivo, orçamento, estratégia de lance, metas, segmentação (público/localização), posicionamentos e redes, conjuntos/grupos e datas. Use junto com get_change_history para avaliar mudanças.',
    { client_id: clientId, platform, status: z.enum(['active', 'paused', 'all']).default('active'), campaign_id: campaignId },
    (a) => campaignSettings({ clientId: a.client_id, platform: a.platform, status: a.status, campaignId: a.campaign_id }));

  tool('get_change_history', 'Histórico de alterações das contas',
    'Alterações feitas nas contas (quem, quando, o que mudou, valor anterior e novo). Google: últimos 30 dias. Meta: histórico de atividades da conta (pode exigir permissão adicional).',
    {
      client_id: clientId, platform, from: dateStr.optional().describe('Data inicial. Padrão: 14 dias atrás'), to: dateStr.optional().describe('Data final. Padrão: hoje'),
      limit: z.number().int().min(1).max(1000).default(200).describe('Máximo de alterações por plataforma'),
    },
    (a) => {
      const to = a.to ?? todayBR();
      return changeHistory({ clientId: a.client_id, platform: a.platform, from: a.from ?? addDays(to, -13), to, limit: a.limit });
    });

  return s;
}
