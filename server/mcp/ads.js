import { get, all } from '../db.js';
import { getSetting } from '../settings.js';
import { http, gaql, META_V, REAL_ID, META_GROUPS, AUTO } from '../sync.js';
import { todayBR, addDays, isDate } from '../metrics.js';

/* ------------------------------ Utilidades ------------------------------ */
const MAX_ROWS = 5000;
const META_WINDOWS = ['7d_click', '1d_view'];
const round = (n, d = 2) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
const div = (a, b) => (b > 0 ? a / b : null);
const num = (v) => (v == null || v === '' ? 0 : +v || 0);

/** Cache curto de consultas ao vivo (protege as APIs e acelera perguntas repetidas). */
const cache = new Map();
export async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;
  const value = await fn();
  if (cache.size > 300) cache.clear();
  cache.set(key, { exp: Date.now() + ttlMs, value });
  return value;
}

/** Limita consultas simultâneas às APIs externas. */
let active = 0;
const waiting = [];
export async function limited(fn) {
  if (active >= 4) await new Promise((r) => waiting.push(r));
  active++;
  try { return await fn(); } finally { active--; waiting.shift()?.(); }
}

export class ToolError extends Error {}

export function clientOf(clientId) {
  const c = get('SELECT * FROM clients WHERE id = ?', clientId);
  if (!c) throw new ToolError(`Cliente ${clientId} não encontrado. Use list_clients para ver os IDs válidos.`);
  return c;
}

/** Canais do cliente. A conta SEMPRE vem do cadastro: o chamador nunca informa IDs de conta. */
export function channelsOf(clientId, platform) {
  const rows = all('SELECT * FROM channels WHERE client_id = ? AND active = 1 ORDER BY platform', clientId);
  const list = platform && platform !== 'all' ? rows.filter((c) => c.platform === platform) : rows;
  if (!list.length) throw new ToolError(platform && platform !== 'all' ? `Este cliente não tem conta ${platform} ativa.` : 'Este cliente não tem contas ativas.');
  return list;
}

export function checkRange(from, to) {
  const today = todayBR();
  if (!isDate(from) || !isDate(to)) throw new ToolError('Datas devem estar no formato AAAA-MM-DD.');
  if (from > to) throw new ToolError('A data inicial é posterior à final.');
  if (to > today) throw new ToolError(`A data final não pode ser futura (hoje é ${today}, fuso America/Sao_Paulo).`);
  if ((Date.parse(to) - Date.parse(from)) / 864e5 > 92) throw new ToolError('Período máximo de 93 dias por consulta.');
}

/** Período comparativo: igual e imediatamente anterior, ou mesmo período do ano anterior, ou datas explícitas. */
export function comparePeriod({ from, to, compare, compare_from, compare_to }) {
  if (compare_from && compare_to) { checkRange(compare_from, compare_to); return { from: compare_from, to: compare_to, kind: 'custom' }; }
  if (compare === 'previous_period') {
    const days = Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1;
    return { from: addDays(from, -days), to: addDays(from, -1), kind: 'previous_period' };
  }
  if (compare === 'previous_year') {
    const shift = (d) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCFullYear(x.getUTCFullYear() - 1); return x.toISOString().slice(0, 10); };
    return { from: shift(from), to: shift(to), kind: 'previous_year' };
  }
  return null;
}

export function paginate(rows, page = 1, pageSize = 50) {
  const size = Math.min(200, Math.max(1, pageSize));
  const p = Math.max(1, page);
  const start = (p - 1) * size;
  return {
    rows: rows.slice(start, start + size),
    pagination: { page: p, page_size: size, total_rows: rows.length, total_pages: Math.max(1, Math.ceil(rows.length / size)), has_more: start + size < rows.length },
  };
}

/* ------------------------------ Métricas ------------------------------ */
const BASE = ['spend', 'impressions', 'clicks', 'link_clicks', 'landing_page_views', 'conversations', 'leads', 'purchases', 'purchase_value', 'conversions', 'conversions_value'];

/** Normaliza um conjunto de métricas e calcula os derivados (CTR, CPC, CPM, custos por resultado). */
export function shape(m) {
  const o = {
    spend: round(m.spend), impressions: Math.round(m.impressions ?? 0), reach: m.reach == null ? null : Math.round(m.reach),
    frequency: m.reach ? round(m.impressions / m.reach) : (m.frequency == null ? null : round(m.frequency)),
    clicks: Math.round(m.clicks ?? 0), link_clicks: m.link_clicks == null ? null : Math.round(m.link_clicks),
    landing_page_views: m.landing_page_views == null ? null : round(m.landing_page_views, 1),
    conversations: m.conversations == null ? null : round(m.conversations, 1),
    leads: m.leads == null ? null : round(m.leads, 1),
    purchases: m.purchases == null ? null : round(m.purchases, 1),
    purchase_value: m.purchase_value == null ? null : round(m.purchase_value),
    conversions: m.conversions == null ? null : round(m.conversions, 1),
    conversions_value: m.conversions_value == null ? null : round(m.conversions_value),
  };
  o.ctr_pct = round((div(m.clicks ?? 0, m.impressions ?? 0) ?? 0) * 100, 2);
  o.cpc = round(div(m.spend, m.clicks ?? 0));
  o.cpm = round((div(m.spend, m.impressions ?? 0) ?? NaN) * 1000);
  o.cost_per_landing_page_view = round(div(m.spend, m.landing_page_views ?? 0));
  o.cost_per_conversation = round(div(m.spend, m.conversations ?? 0));
  o.cost_per_lead = round(div(m.spend, m.leads ?? 0));
  o.cost_per_purchase = round(div(m.spend, m.purchases ?? 0));
  o.cost_per_conversion = round(div(m.spend, m.conversions ?? 0));
  const value = m.purchase_value ?? m.conversions_value;
  o.roas = round(value ? div(value, m.spend) : null);
  return o;
}

const sumRows = (rows) => {
  const t = Object.fromEntries(BASE.map((k) => [k, null]));
  for (const r of rows) for (const k of BASE) if (r.raw[k] != null) t[k] = (t[k] ?? 0) + r.raw[k];
  return t;
};

export function deltas(cur, prev) {
  const out = {};
  for (const k of ['spend', 'impressions', 'reach', 'clicks', 'link_clicks', 'landing_page_views', 'conversations', 'leads', 'purchases', 'conversions', 'cpc', 'cpm', 'ctr_pct', 'cost_per_conversation', 'cost_per_lead', 'cost_per_purchase', 'cost_per_conversion', 'roas']) {
    if (cur[k] == null || prev[k] == null) { out[k] = null; continue; }
    out[k] = { change: round(cur[k] - prev[k]), change_pct: prev[k] ? round(((cur[k] - prev[k]) / prev[k]) * 100, 1) : null };
  }
  return out;
}

/* ------------------------------ Meta ------------------------------ */
function metaCtx(ch) {
  const token = getSetting('meta_access_token');
  if (!token) throw new ToolError('Meta Access Token não configurado no sistema.');
  const id = `act_${ch.account_id.replace(/^act_/, '')}`;
  return { id, headers: { authorization: `Bearer ${token}` }, base: `https://graph.facebook.com/${META_V}/${id}` };
}

async function metaPaged(url, headers, max = MAX_ROWS) {
  const rows = [];
  let next = url, truncated = false;
  while (next) {
    const j = await limited(() => http(next, { headers }));
    rows.push(...(j.data ?? []));
    next = j.paging?.next ?? null;
    if (rows.length >= max) { truncated = !!next; break; }
  }
  return { rows, truncated };
}

/** "Resultado" configurado no cadastro do canal (mesma lógica do painel). */
export function metaResultGroups(ch) {
  return META_GROUPS[ch.result_type] && ['cpl', 'cpa'].includes(ch.metric) ? [ch.result_type] : (AUTO[ch.metric] ?? []);
}

const metaGroup = (list, g) => {
  const v = (list ?? []).filter((a) => META_GROUPS[g].includes(a.action_type)).map((a) => +a.value);
  return v.length ? Math.max(...v) : 0; // lead e lead_grouped descrevem o mesmo evento: conta uma vez
};

function metaRaw(r, ch) {
  const groups = metaResultGroups(ch);
  return {
    spend: num(r.spend), impressions: num(r.impressions), reach: num(r.reach), clicks: num(r.clicks), link_clicks: num(r.inline_link_clicks),
    landing_page_views: metaGroup(r.actions, 'lpv'), conversations: metaGroup(r.actions, 'message'),
    leads: metaGroup(r.actions, 'lead'), purchases: metaGroup(r.actions, 'purchase'), purchase_value: metaGroup(r.action_values, 'purchase'),
    conversions: ch.metric === 'reach' ? num(r.reach) : groups.reduce((s, g) => s + metaGroup(r.actions, g), 0),
    conversions_value: null,
  };
}

const META_LEVEL = {
  account: { level: 'account', fields: [], key: () => 'account' },
  campaign: { level: 'campaign', fields: ['campaign_id', 'campaign_name'], key: (r) => r.campaign_id },
  adset: { level: 'adset', fields: ['campaign_id', 'campaign_name', 'adset_id', 'adset_name'], key: (r) => r.adset_id },
  ad: { level: 'ad', fields: ['campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'ad_id', 'ad_name'], key: (r) => r.ad_id },
};

function metaEntity(r, level) {
  const e = {};
  if (level !== 'account') { e.campaign_id = r.campaign_id; e.campaign = r.campaign_name; }
  if (level === 'adset' || level === 'ad') { e.adset_id = r.adset_id; e.adset = r.adset_name; }
  if (level === 'ad') { e.ad_id = r.ad_id; e.ad = r.ad_name; }
  return e;
}

async function metaInsights(ch, { level, from, to, daily, campaignId }) {
  const ctx = metaCtx(ch);
  const def = META_LEVEL[level];
  const q = new URLSearchParams({
    level: def.level, limit: '500',
    fields: [...def.fields, 'date_start', 'spend', 'impressions', 'reach', 'frequency', 'clicks', 'inline_link_clicks', 'actions', 'action_values'].join(','),
    time_range: JSON.stringify({ since: from, until: to }),
    action_attribution_windows: JSON.stringify(META_WINDOWS),
  });
  if (daily) q.set('time_increment', '1');
  if (campaignId) q.set('filtering', JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: [String(campaignId)] }]));
  const { rows, truncated } = await metaPaged(`${ctx.base}/insights?${q}`, ctx.headers);
  return { rows, truncated, def };
}

async function metaPerformance(ch, o) {
  const { level, from, to, daily, campaignId } = o;
  const tot = await metaInsights(ch, { level, from, to, daily: false, campaignId });
  const entities = new Map();
  for (const r of tot.rows) {
    entities.set(tot.def.key(r), { ...metaEntity(r, level), raw: metaRaw(r, ch), daily: [] });
  }
  let truncated = tot.truncated;
  let dailyRows = [];
  if (daily) {
    const d = await metaInsights(ch, { level, from, to, daily: true, campaignId });
    truncated ||= d.truncated;
    dailyRows = d.rows;
    for (const r of d.rows) {
      const e = entities.get(d.def.key(r));
      if (e) e.daily.push({ date: r.date_start, raw: metaRaw(r, ch) });
    }
  }
  // totais da conta: alcance e frequência não são somáveis, então vêm de uma consulta própria
  let accountRaw;
  if (level === 'account' && !campaignId) accountRaw = [...entities.values()][0]?.raw ?? metaRaw({}, ch);
  else {
    const a = await metaInsights(ch, { level: 'account', from, to, daily: false, campaignId: null });
    accountRaw = a.rows[0] ? metaRaw(a.rows[0], ch) : metaRaw({}, ch);
  }
  let dailyTotals = null;
  if (daily) {
    const dt = level === 'account' && !campaignId ? { rows: dailyRows } : await metaInsights(ch, { level: 'account', from, to, daily: true, campaignId: null });
    dailyTotals = dt.rows.map((r) => ({ date: r.date_start, raw: metaRaw(r, ch) }));
  }
  return { entities: [...entities.values()], accountRaw, dailyTotals, truncated };
}

/* ------------------------------ Google ------------------------------ */
const G_LEVEL = {
  account: { from: 'customer', select: [], where: '', key: () => 'account', label: () => ({}) },
  campaign: {
    from: 'campaign', select: ['campaign.id', 'campaign.name', 'campaign.status'], where: "campaign.status != 'REMOVED'",
    key: (r) => r.campaign.id, label: (r) => ({ campaign_id: r.campaign.id, campaign: r.campaign.name, status: r.campaign.status }),
  },
  adset: {
    from: 'ad_group', select: ['campaign.id', 'campaign.name', 'ad_group.id', 'ad_group.name', 'ad_group.status'],
    where: "campaign.status != 'REMOVED' AND ad_group.status != 'REMOVED'", key: (r) => r.adGroup.id,
    label: (r) => ({ campaign_id: r.campaign.id, campaign: r.campaign.name, adset_id: r.adGroup.id, adset: r.adGroup.name, status: r.adGroup.status }),
  },
  ad: {
    from: 'ad_group_ad', select: ['campaign.id', 'campaign.name', 'ad_group.id', 'ad_group.name', 'ad_group_ad.ad.id', 'ad_group_ad.ad.name', 'ad_group_ad.ad.type', 'ad_group_ad.status'],
    where: "campaign.status != 'REMOVED' AND ad_group_ad.status != 'REMOVED'", key: (r) => r.adGroupAd.ad.id,
    label: (r) => ({
      campaign_id: r.campaign.id, campaign: r.campaign.name, adset_id: r.adGroup.id, adset: r.adGroup.name,
      ad_id: r.adGroupAd.ad.id, ad: r.adGroupAd.ad.name || `Anúncio ${r.adGroupAd.ad.id}`, ad_type: r.adGroupAd.ad.type, status: r.adGroupAd.status,
    }),
  },
};

const G_METRICS = 'metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value';
// categorias de conversão do Google agrupadas nas colunas separadas (o detalhe completo vai em conversions_by_category)
const G_CAT = {
  purchases: ['PURCHASE'],
  leads: ['SUBMIT_LEAD_FORM', 'QUALIFIED_LEAD', 'CONVERTED_LEAD', 'REQUEST_QUOTE', 'BOOK_APPOINTMENT'],
  conversations: ['PHONE_CALL_LEAD', 'CONTACT'],
  landing_page_views: ['PAGE_VIEW'],
};

function gRaw(r) {
  const m = r.metrics ?? {};
  return {
    spend: num(m.costMicros) / 1e6, impressions: num(m.impressions), reach: null, clicks: num(m.clicks), link_clicks: null,
    landing_page_views: null, conversations: null, leads: null, purchases: null, purchase_value: null,
    conversions: num(m.conversions), conversions_value: num(m.conversionsValue),
  };
}

const cidOf = (ch) => ch.account_id.replace(/\D/g, '');
const gWhere = (def, from, to, campaignId) => {
  const parts = [`segments.date BETWEEN '${from}' AND '${to}'`];
  if (def.where) parts.push(def.where);
  if (campaignId) parts.push(`campaign.id = ${String(campaignId).replace(/\D/g, '') || 0}`);
  return parts.join(' AND ');
};

/** `tracked` = categorias que a conta realmente mede (ações de conversão ativas); as demais ficam null, não 0. */
function applyCategories(raw, cats, tracked) {
  const by = {};
  for (const [c, v] of Object.entries(cats ?? {})) by[c] = round(v.conversions, 1);
  for (const [field, list] of Object.entries(G_CAT)) {
    raw[field] = list.some((c) => tracked.has(c)) ? list.reduce((s, c) => s + (cats?.[c]?.conversions ?? 0), 0) : null;
  }
  raw.purchase_value = tracked.has('PURCHASE') ? (cats?.PURCHASE?.value ?? 0) : null;
  return by;
}

async function googlePerformance(ch, o) {
  const { level, from, to, daily, campaignId } = o;
  const def = G_LEVEL[level];
  const cid = cidOf(ch);
  const where = gWhere(def, from, to, campaignId);
  const sel = def.select.length ? `${def.select.join(', ')}, ` : '';
  const run = (q) => limited(() => gaql(cid, q));
  const warnings = [];

  const rows = await run(`SELECT ${sel}${G_METRICS} FROM ${def.from} WHERE ${where} ORDER BY metrics.cost_micros DESC LIMIT ${MAX_ROWS}`);
  const entities = new Map();
  for (const r of rows) entities.set(def.key(r), { ...def.label(r), raw: gRaw(r), daily: [], conversions_by_category: {} });
  const truncated = rows.length >= MAX_ROWS;

  // conversões por categoria (leads, vendas, conversas, visitas) separadas, quando a conta permite
  let tracked = null;
  try { tracked = new Set((await googleConversionActions(ch)).map((x) => x.category)); } catch { /* tratado abaixo */ }
  const catKey = (r) => (level === 'account' ? 'account' : def.key(r));
  try {
    const idSel = def.select.length ? `${def.select.filter((s) => /\.id$/.test(s)).join(', ')}, ` : '';
    const cats = await run(`SELECT ${idSel}segments.conversion_action_category, metrics.conversions, metrics.conversions_value FROM ${def.from} WHERE ${where} LIMIT 20000`);
    const acc = new Map();
    for (const r of cats) {
      const k = catKey(r);
      const e = acc.get(k) ?? {};
      const c = r.segments.conversionActionCategory;
      e[c] = { conversions: (e[c]?.conversions ?? 0) + num(r.metrics.conversions), value: (e[c]?.value ?? 0) + num(r.metrics.conversionsValue) };
      acc.set(k, e);
    }
    if (!tracked) throw new Error('lista de ações de conversão indisponível');
    for (const [k, e] of entities) e.conversions_by_category = applyCategories(e.raw, acc.get(k), tracked);
    const untracked = Object.keys(G_CAT).filter((f) => !G_CAT[f].some((c) => tracked.has(c)));
    if (untracked.length) warnings.push(`Google: a conta não tem ação de conversão para ${untracked.join(', ')}; essas colunas ficam null (indisponível), não zero.`);
  } catch (e) { warnings.push(`Conversões por categoria indisponíveis no Google (${String(e.message).slice(0, 120)}); colunas de leads/conversas/vendas/visitas ficam null.`); }

  if (daily) {
    const d = await run(`SELECT ${sel}segments.date, ${G_METRICS} FROM ${def.from} WHERE ${where} ORDER BY segments.date LIMIT 20000`);
    for (const r of d) entities.get(def.key(r))?.daily.push({ date: r.segments.date, raw: gRaw(r) });
  }

  const accountRows = await run(`SELECT ${G_METRICS} FROM customer WHERE ${gWhere(G_LEVEL.account, from, to, campaignId)}`);
  const accountRaw = accountRows.length ? accountRows.map(gRaw).reduce((a, b) => Object.fromEntries(BASE.map((k) => [k, a[k] == null && b[k] == null ? null : (a[k] ?? 0) + (b[k] ?? 0)]))) : gRaw({});
  accountRaw.reach = null;
  const catAcc = {};
  try {
    const c = await run(`SELECT segments.conversion_action_category, metrics.conversions, metrics.conversions_value FROM customer WHERE ${gWhere(G_LEVEL.account, from, to, campaignId)}`);
    for (const r of c) {
      const k = r.segments.conversionActionCategory;
      catAcc[k] = { conversions: (catAcc[k]?.conversions ?? 0) + num(r.metrics.conversions), value: (catAcc[k]?.value ?? 0) + num(r.metrics.conversionsValue) };
    }
    if (tracked) applyCategories(accountRaw, catAcc, tracked);
  } catch { /* o aviso já foi registrado acima */ }

  let dailyTotals = null;
  if (daily) {
    const d = await run(`SELECT segments.date, ${G_METRICS} FROM customer WHERE ${gWhere(G_LEVEL.account, from, to, campaignId)} ORDER BY segments.date`);
    dailyTotals = d.map((r) => ({ date: r.segments.date, raw: gRaw(r) }));
  }
  return { entities: [...entities.values()], accountRaw, dailyTotals, truncated, warnings };
}

/* ------------------------------ Conta: moeda, fuso, conversões ------------------------------ */
export async function accountInfo(ch) {
  return cached(`acc|${ch.platform}|${ch.account_id}`, 3600_000, async () => {
    if (ch.platform === 'meta') {
      const ctx = metaCtx(ch);
      const j = await limited(() => http(`https://graph.facebook.com/${META_V}/${ctx.id}?fields=name,currency,timezone_name,account_status`, { headers: ctx.headers }));
      return { name: j.name, currency: j.currency, timezone: j.timezone_name, status: j.account_status === 1 ? 'ACTIVE' : `status ${j.account_status}` };
    }
    const r = await limited(() => gaql(cidOf(ch), 'SELECT customer.descriptive_name, customer.currency_code, customer.time_zone FROM customer'));
    const c = r[0]?.customer ?? {};
    return { name: c.descriptiveName, currency: c.currencyCode, timezone: c.timeZone, status: 'ACTIVE' };
  });
}

/** Ações de conversão do Google (o que conta como conversão e a janela de atribuição de cada uma). */
export async function googleConversionActions(ch) {
  return cached(`gca|${ch.account_id}`, 1800_000, async () => {
    const rows = await limited(() => gaql(cidOf(ch), "SELECT conversion_action.id, conversion_action.name, conversion_action.type, conversion_action.category, conversion_action.status, conversion_action.primary_for_goal, conversion_action.include_in_conversions_metric, conversion_action.counting_type, conversion_action.click_through_lookback_window_days, conversion_action.view_through_lookback_window_days, conversion_action.attribution_model_settings.attribution_model FROM conversion_action WHERE conversion_action.status = 'ENABLED'"));
    return rows.map(({ conversionAction: a }) => ({
      id: a.id, name: a.name, type: a.type, category: a.category,
      counts_in_conversions_column: a.includeInConversionsMetric !== false, primary_for_goal: a.primaryForGoal ?? null,
      counting: a.countingType, click_window_days: a.clickThroughLookbackWindowDays ? +a.clickThroughLookbackWindowDays : null,
      view_window_days: a.viewThroughLookbackWindowDays ? +a.viewThroughLookbackWindowDays : null,
      attribution_model: a.attributionModelSettings?.attributionModel ?? null,
    }));
  });
}

export function attributionInfo(ch) {
  if (ch.platform === 'meta') {
    return {
      model: 'Janela de atribuição Meta', click_window: '7 dias após o clique', view_window: '1 dia após a visualização',
      note: 'Valores somam as duas janelas (padrão do Gerenciador de Anúncios). Conversões dos últimos dias podem aumentar depois (atribuição tardia).',
    };
  }
  return {
    model: 'Definida por ação de conversão', note: 'A coluna "conversions" só soma ações marcadas para entrar em Conversões; janelas e modelo por ação estão em get_reporting_config. Conversões são registradas na data do clique/interação.',
  };
}

export function conversionDefinition(ch) {
  if (ch.platform === 'google') return 'conversions = todas as ações do Google marcadas para entrar na coluna Conversões (ver get_reporting_config).';
  const labels = { lead: 'leads (formulário/pixel)', message: 'conversas iniciadas (mensagens)', purchase: 'compras', click: 'cliques no link', lpv: 'visualizações da página de destino' };
  if (ch.metric === 'reach') return 'conversions = alcance (objetivo do canal é alcance).';
  if (ch.metric === 'followers') return 'conversions = novos seguidores do Instagram + curtidas da página.';
  const groups = metaResultGroups(ch);
  return `conversions = ${groups.map((g) => labels[g] ?? g).join(' + ') || 'não definido'} (resultado configurado para o canal).`;
}

/* ------------------------------ Desempenho (entrada principal) ------------------------------ */
const present = (raw) => shape(raw);
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));

function presentEntity(e, previous) {
  const { raw, daily, ...rest } = e;
  const out = { ...rest, metrics: present(raw) };
  if (previous) out.previous = present(previous.raw);
  if (previous) out.delta = deltas(out.metrics, out.previous);
  if (daily?.length) out.daily = daily.map((d) => ({ date: d.date, ...compact(present(d.raw)) }));
  return out;
}

async function platformPerformance(ch, o) {
  const warnings = [];
  const run = ch.platform === 'meta' ? metaPerformance : googlePerformance;
  const cur = await run(ch, o);
  warnings.push(...(cur.warnings ?? []));
  let prev = null;
  if (o.compare) prev = await run(ch, { ...o, from: o.compare.from, to: o.compare.to, daily: false });
  if (cur.truncated) warnings.push(`Resultado truncado em ${MAX_ROWS} linhas: refine por campanha ou reduza o período.`);
  if (ch.platform === 'google') warnings.push('Alcance e frequência não são fornecidos pelo Google Ads nesta consulta (campo null).');
  if (ch.platform === 'meta' && o.level !== 'account') warnings.push('Alcance/frequência por entidade não somam ao total da conta (pessoas únicas se repetem entre campanhas/anúncios).');
  const prevByKey = prev && new Map(prev.entities.map((e) => [e.ad_id ?? e.adset_id ?? e.campaign_id ?? 'account', e]));
  const keyOf = (e) => e.ad_id ?? e.adset_id ?? e.campaign_id ?? 'account';
  const entities = cur.entities.sort((a, b) => b.raw.spend - a.raw.spend);
  const totals = present(cur.accountRaw);
  return {
    entities: entities.map((e) => presentEntity(e, prevByKey?.get(keyOf(e)) ?? (prev ? { raw: shapeless() } : null))),
    totals,
    comparison: prev ? { totals: present(prev.accountRaw), delta: deltas(totals, present(prev.accountRaw)) } : null,
    daily_totals: cur.dailyTotals?.map((d) => ({ date: d.date, ...compact(present(d.raw)) })) ?? null,
    warnings,
  };
}

function shapeless() {
  return { spend: 0, impressions: 0, reach: null, clicks: 0, link_clicks: null, landing_page_views: null, conversations: null, leads: null, purchases: null, purchase_value: null, conversions: null, conversions_value: null };
}

export async function performance({ clientId, platform, level, from, to, daily, campaignId, compare, page, pageSize }) {
  checkRange(from, to);
  const client = clientOf(clientId);
  const chs = channelsOf(clientId, platform);
  const cmp = comparePeriod({ from, to, ...compare });
  const out = { client: { id: client.id, name: client.name }, level, period: { from, to, days: Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1 }, compare_period: cmp, platforms: [], warnings: [] };
  const flat = [];
  await Promise.all(chs.map(async (ch) => {
    const block = { platform: ch.platform, account_id: ch.account_id, objective: { metric: ch.metric, target: ch.target } };
    try {
      if (!REAL_ID.test(ch.account_id)) throw new ToolError('ID da conta não cadastrado ou inválido.');
      const key = `perf|${ch.id}|${ch.account_id}|${level}|${from}|${to}|${!!daily}|${campaignId ?? ''}|${cmp ? `${cmp.from}${cmp.to}` : ''}`;
      const info = await accountInfo(ch).catch(() => ({}));
      const r = await cached(key, 300_000, () => platformPerformance(ch, { level, from, to, daily, campaignId, compare: cmp }));
      Object.assign(block, {
        currency: info.currency ?? null, timezone: info.timezone ?? null, conversion_definition: conversionDefinition(ch),
        attribution: attributionInfo(ch), totals: r.totals, comparison: r.comparison, daily_totals: r.daily_totals, warnings: r.warnings,
      });
      for (const e of r.entities) flat.push({ platform: ch.platform, ...e });
    } catch (e) {
      block.error = String(e.message).slice(0, 300);
      out.warnings.push(`Dados de ${ch.platform} indisponíveis: ${block.error}`);
    }
    const st = get('SELECT last_sync, error FROM channel_status WHERE channel_id = ?', ch.id);
    block.panel_last_sync = st?.last_sync ? new Date(st.last_sync * 1000).toISOString() : null;
    out.platforms.push(block);
  }));
  out.platforms.sort((a, b) => a.platform.localeCompare(b.platform));
  const { rows, pagination } = paginate(flat, page, pageSize);
  out.rows = rows;
  out.pagination = pagination;
  if (to === todayBR()) out.warnings.push('O período inclui hoje: o dia está incompleto e os números ainda mudam.');
  out.warnings.push('Conversões podem ser atribuídas com atraso; os últimos 2-3 dias tendem a subir depois.');
  out.data_freshness = { fetched_at: new Date().toISOString(), source: 'consulta ao vivo nas APIs (cache de até 5 min)' };
  return out;
}

/* ------------------------------ Termos de pesquisa (Google) ------------------------------ */
export async function searchTerms({ clientId, from, to, campaignId, minCost, onlyConverting, orderBy, page, pageSize }) {
  checkRange(from, to);
  const client = clientOf(clientId);
  const chs = channelsOf(clientId, 'google');
  const ch = chs[0];
  if (!REAL_ID.test(ch.account_id)) throw new ToolError('ID da conta Google não cadastrado ou inválido.');
  const camp = campaignId ? ` AND campaign.id = ${String(campaignId).replace(/\D/g, '') || 0}` : '';
  const rows = await cached(`st|${ch.account_id}|${from}|${to}|${campaignId ?? ''}`, 300_000, () => limited(() => gaql(cidOf(ch),
    `SELECT search_term_view.search_term, search_term_view.status, campaign.id, campaign.name, ad_group.id, ad_group.name, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM search_term_view WHERE segments.date BETWEEN '${from}' AND '${to}'${camp} ORDER BY metrics.cost_micros DESC LIMIT ${MAX_ROWS}`)));
  const acc = new Map();
  for (const r of rows) {
    const k = `${r.searchTermView.searchTerm}|${r.adGroup.id}`;
    const a = acc.get(k) ?? { term: r.searchTermView.searchTerm, status: r.searchTermView.status, campaign_id: r.campaign.id, campaign: r.campaign.name, ad_group_id: r.adGroup.id, ad_group: r.adGroup.name, raw: { spend: 0, impressions: 0, clicks: 0, conversions: 0, conversions_value: 0 } };
    a.raw.spend += num(r.metrics.costMicros) / 1e6; a.raw.impressions += num(r.metrics.impressions); a.raw.clicks += num(r.metrics.clicks);
    a.raw.conversions += num(r.metrics.conversions); a.raw.conversions_value += num(r.metrics.conversionsValue);
    acc.set(k, a);
  }
  let list = [...acc.values()];
  if (minCost) list = list.filter((t) => t.raw.spend >= minCost);
  if (onlyConverting) list = list.filter((t) => t.raw.conversions > 0);
  const order = { cost: 'spend', clicks: 'clicks', impressions: 'impressions', conversions: 'conversions' }[orderBy] ?? 'spend';
  list.sort((a, b) => b.raw[order] - a.raw[order]);
  const totals = list.reduce((t, x) => ({ spend: t.spend + x.raw.spend, clicks: t.clicks + x.raw.clicks, impressions: t.impressions + x.raw.impressions, conversions: t.conversions + x.raw.conversions }), { spend: 0, clicks: 0, impressions: 0, conversions: 0 });
  const { rows: pageRows, pagination } = paginate(list, page, pageSize);
  const info = await accountInfo(ch).catch(() => ({}));
  return {
    client: { id: client.id, name: client.name }, platform: 'google', period: { from, to }, currency: info.currency ?? null,
    totals_listed: { spend: round(totals.spend), clicks: totals.clicks, impressions: totals.impressions, conversions: round(totals.conversions, 1) },
    terms: pageRows.map(({ raw, ...t }) => ({
      ...t, impressions: raw.impressions, clicks: raw.clicks, spend: round(raw.spend), conversions: round(raw.conversions, 1), conversions_value: round(raw.conversions_value),
      ctr_pct: round((div(raw.clicks, raw.impressions) ?? 0) * 100), cpc: round(div(raw.spend, raw.clicks)), cost_per_conversion: round(div(raw.spend, raw.conversions)),
    })),
    pagination,
    warnings: [
      'O Google oculta termos de baixo volume (agrupados como "outros"): a soma dos termos listados é menor que o total da conta.',
      ...(rows.length >= MAX_ROWS ? [`Lista limitada aos ${MAX_ROWS} termos de maior custo.`] : []),
    ],
    data_freshness: { fetched_at: new Date().toISOString() },
  };
}

/* ------------------------------ Criativos ------------------------------ */
const first = (list, key = 'text') => (list ?? []).map((x) => x?.[key]).filter(Boolean);

function metaCreative(a) {
  const c = a.creative ?? {};
  const oss = c.object_story_spec ?? {};
  const ld = oss.link_data ?? {};
  const vd = oss.video_data ?? {};
  const afs = c.asset_feed_spec ?? {};
  const cta = ld.call_to_action ?? vd.call_to_action ?? {};
  const urls = [...new Set([ld.link, cta.value?.link, vd.call_to_action?.value?.link, c.link_url, ...first(afs.link_urls, 'website_url')].filter(Boolean))];
  const images = [...new Set([c.image_url, ld.picture, vd.image_url, ...first(afs.images, 'url')].filter(Boolean))];
  return {
    ad_id: a.id, name: a.name, status: a.effective_status, campaign_id: a.campaign?.id, campaign: a.campaign?.name, adset_id: a.adset?.id, adset: a.adset?.name,
    format: vd.video_id || c.video_id || afs.videos?.length ? 'video' : (ld.child_attachments ? 'carrossel' : (afs.images?.length > 1 ? 'dinamico' : 'imagem')),
    primary_text: [...new Set([c.body, ld.message, vd.message, ...first(afs.bodies)].filter(Boolean))],
    headline: [...new Set([c.title, ld.name, vd.title, ...first(afs.titles)].filter(Boolean))],
    description: [...new Set([ld.description, ...first(afs.descriptions)].filter(Boolean))],
    call_to_action: cta.type ?? c.call_to_action_type ?? afs.call_to_action_types?.[0] ?? null,
    landing_page_urls: urls,
    image_urls: images, thumbnail_url: c.thumbnail_url ?? null, video_id: vd.video_id ?? c.video_id ?? afs.videos?.[0]?.video_id ?? null,
    carousel_items: ld.child_attachments?.map((x) => ({ headline: x.name, description: x.description, url: x.link, image_url: x.picture })) ?? undefined,
    preview_link: a.preview_shareable_link ?? null,
    url_tags: c.url_tags ?? null,
  };
}

export async function creatives({ clientId, platform, status, from, to, campaignId, includePerformance, page, pageSize }) {
  if (includePerformance) checkRange(from, to);
  const client = clientOf(clientId);
  const chs = channelsOf(clientId, platform);
  const out = { client: { id: client.id, name: client.name }, period: includePerformance ? { from, to } : null, platforms: [], warnings: [] };
  const flat = [];
  await Promise.all(chs.map(async (ch) => {
    const block = { platform: ch.platform, account_id: ch.account_id };
    try {
      if (!REAL_ID.test(ch.account_id)) throw new ToolError('ID da conta não cadastrado ou inválido.');
      const list = await cached(`cr|${ch.id}|${ch.account_id}|${status}|${campaignId ?? ''}|${includePerformance ? `${from}${to}` : ''}`, 300_000,
        () => (ch.platform === 'meta' ? metaCreatives(ch, { status, from, to, campaignId, includePerformance }) : googleCreatives(ch, { status, from, to, campaignId, includePerformance })));
      block.count = list.ads.length;
      block.warnings = list.warnings;
      for (const a of list.ads) flat.push({ platform: ch.platform, ...a });
    } catch (e) {
      block.error = String(e.message).slice(0, 300);
      out.warnings.push(`Criativos de ${ch.platform} indisponíveis: ${block.error}`);
    }
    out.platforms.push(block);
  }));
  out.platforms.sort((a, b) => a.platform.localeCompare(b.platform));
  flat.sort((a, b) => (b.metrics?.spend ?? 0) - (a.metrics?.spend ?? 0));
  const { rows, pagination } = paginate(flat, page, pageSize);
  out.ads = rows;
  out.pagination = pagination;
  out.warnings.push('Links de imagem/vídeo do Meta são temporários e podem expirar; use preview_link para abrir o anúncio.');
  out.data_freshness = { fetched_at: new Date().toISOString() };
  return out;
}

async function metaCreatives(ch, { status, from, to, campaignId, includePerformance }) {
  const ctx = metaCtx(ch);
  const eff = status === 'all' ? null : status === 'paused' ? ['PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED'] : ['ACTIVE'];
  const q = new URLSearchParams({
    limit: '100',
    fields: 'name,effective_status,preview_shareable_link,campaign{id,name},adset{id,name},creative.thumbnail_width(720).thumbnail_height(720){id,title,body,call_to_action_type,image_url,thumbnail_url,video_id,link_url,url_tags,object_story_spec,asset_feed_spec}',
  });
  const filters = [];
  if (eff) filters.push({ field: 'effective_status', operator: 'IN', value: eff });
  if (campaignId) filters.push({ field: 'campaign.id', operator: 'IN', value: [String(campaignId)] });
  if (filters.length) q.set('filtering', JSON.stringify(filters));
  const { rows, truncated } = await metaPaged(`${ctx.base}/ads?${q}`, ctx.headers, 1000);
  const perf = new Map();
  if (includePerformance) {
    const { rows: ins } = await metaInsights(ch, { level: 'ad', from, to, daily: false, campaignId });
    for (const r of ins) perf.set(r.ad_id, shape(metaRaw(r, ch)));
  }
  return {
    ads: rows.map((a) => ({ ...metaCreative(a), ...(includePerformance ? { metrics: perf.get(a.id) ?? shape(metaRaw({}, ch)) } : {}) })),
    warnings: truncated ? ['Lista truncada em 1000 anúncios.'] : [],
  };
}

async function googleCreatives(ch, { status, from, to, campaignId, includePerformance }) {
  const cid = cidOf(ch);
  const st = status === 'all' ? "ad_group_ad.status != 'REMOVED'" : status === 'paused' ? "ad_group_ad.status = 'PAUSED'" : "ad_group_ad.status = 'ENABLED' AND ad_group.status = 'ENABLED' AND campaign.status = 'ENABLED'";
  const camp = campaignId ? ` AND campaign.id = ${String(campaignId).replace(/\D/g, '') || 0}` : '';
  const metrics = includePerformance ? `, ${G_METRICS}` : '';
  const dates = includePerformance ? ` AND segments.date BETWEEN '${from}' AND '${to}'` : '';
  const rows = await limited(() => gaql(cid, `SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group_ad.status, ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.type, ad_group_ad.ad.final_urls, ad_group_ad.ad.display_url, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.ad.responsive_display_ad.headlines, ad_group_ad.ad.responsive_display_ad.long_headline, ad_group_ad.ad.responsive_display_ad.descriptions, ad_group_ad.ad.responsive_display_ad.call_to_action_text, ad_group_ad.ad.responsive_display_ad.marketing_images, ad_group_ad.ad.responsive_display_ad.square_marketing_images${metrics} FROM ad_group_ad WHERE ${st}${camp}${dates} LIMIT ${MAX_ROWS}`));
  const acc = new Map();
  for (const r of rows) {
    const ad = r.adGroupAd.ad;
    const rsa = ad.responsiveSearchAd ?? {};
    const rda = ad.responsiveDisplayAd ?? {};
    const a = acc.get(ad.id) ?? {
      ad_id: ad.id, name: ad.name || first(rsa.headlines ?? rda.headlines).slice(0, 2).join(' | ') || `Anúncio ${ad.id}`, status: r.adGroupAd.status, ad_type: ad.type,
      campaign_id: r.campaign.id, campaign: r.campaign.name, adset_id: r.adGroup.id, adset: r.adGroup.name,
      headline: [...first(rsa.headlines), ...first(rda.headlines), ...(rda.longHeadline?.text ? [rda.longHeadline.text] : [])],
      description: [...first(rsa.descriptions), ...first(rda.descriptions)],
      call_to_action: rda.callToActionText ?? null,
      landing_page_urls: ad.finalUrls ?? [], display_url: ad.displayUrl ?? null,
      _assets: [...first(rda.marketingImages, 'asset'), ...first(rda.squareMarketingImages, 'asset')],
      raw: includePerformance ? { spend: 0, impressions: 0, clicks: 0, conversions: 0, conversions_value: 0 } : null,
    };
    if (includePerformance) {
      a.raw.spend += num(r.metrics.costMicros) / 1e6; a.raw.impressions += num(r.metrics.impressions); a.raw.clicks += num(r.metrics.clicks);
      a.raw.conversions += num(r.metrics.conversions); a.raw.conversions_value += num(r.metrics.conversionsValue);
    }
    acc.set(ad.id, a);
  }
  // URLs das imagens dos anúncios de display
  const names = [...new Set([...acc.values()].flatMap((a) => a._assets))].slice(0, 300);
  const urls = new Map();
  if (names.length) {
    try {
      const list = names.map((n) => `'${n.replace(/'/g, '')}'`).join(',');
      const res = await limited(() => gaql(cid, `SELECT asset.resource_name, asset.image_asset.full_size.url FROM asset WHERE asset.resource_name IN (${list})`));
      for (const r of res) urls.set(r.asset.resourceName, r.asset.imageAsset?.fullSize?.url);
    } catch { /* imagens são opcionais */ }
  }
  const ads = [...acc.values()].map(({ _assets, raw, ...a }) => ({
    ...a, image_urls: _assets.map((n) => urls.get(n)).filter(Boolean),
    ...(raw ? { metrics: shape({ ...raw, reach: null, link_clicks: null, landing_page_views: null, conversations: null, leads: null, purchases: null, purchase_value: null }) } : {}),
  }));
  return { ads, warnings: ['Criativos de vídeo (YouTube/Demand Gen/Performance Max) não são detalhados pela API de anúncios; só texto e imagens de anúncios responsivos.'] };
}

/* ------------------------------ Configurações das campanhas ------------------------------ */
const TARGETING_KEYS = ['geo_locations', 'excluded_geo_locations', 'age_min', 'age_max', 'genders', 'publisher_platforms', 'facebook_positions', 'instagram_positions', 'device_platforms', 'custom_audiences', 'excluded_custom_audiences', 'flexible_spec', 'targeting_automation', 'locales'];
const cents = (v) => (v == null ? null : +v / 100);

async function metaSettings(ch, { status, campaignId }) {
  const ctx = metaCtx(ch);
  const eff = status === 'all' ? null : status === 'paused' ? ['PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED'] : ['ACTIVE'];
  const filters = [];
  if (eff) filters.push({ field: 'effective_status', operator: 'IN', value: eff });
  const cFilter = campaignId ? [{ field: 'campaign.id', operator: 'IN', value: [String(campaignId)] }] : [];
  const mk = (fields, extra) => new URLSearchParams({ limit: '100', fields, ...(extra.length ? { filtering: JSON.stringify(extra) } : {}) });
  const [camps, sets] = await Promise.all([
    metaPaged(`${ctx.base}/campaigns?${mk('name,objective,status,effective_status,buying_type,bid_strategy,daily_budget,lifetime_budget,budget_remaining,special_ad_categories,start_time,stop_time,created_time,updated_time', [...filters, ...(campaignId ? [{ field: 'id', operator: 'IN', value: [String(campaignId)] }] : [])])}`, ctx.headers, 1000),
    metaPaged(`${ctx.base}/adsets?${mk('name,campaign_id,status,effective_status,optimization_goal,billing_event,bid_strategy,bid_amount,daily_budget,lifetime_budget,destination_type,promoted_object,start_time,end_time,created_time,updated_time,targeting', [...filters, ...cFilter])}`, ctx.headers, 1000),
  ]);
  const setsBy = new Map();
  for (const s of sets.rows) {
    const t = Object.fromEntries(TARGETING_KEYS.filter((k) => s.targeting?.[k] != null).map((k) => [k, s.targeting[k]]));
    const e = {
      adset_id: s.id, name: s.name, status: s.effective_status, optimization_goal: s.optimization_goal, billing_event: s.billing_event, bid_strategy: s.bid_strategy,
      bid_amount: cents(s.bid_amount), daily_budget: cents(s.daily_budget), lifetime_budget: cents(s.lifetime_budget), destination_type: s.destination_type,
      promoted_object: s.promoted_object ?? null, start_time: s.start_time ?? null, end_time: s.end_time ?? null, updated_time: s.updated_time, targeting: t,
    };
    setsBy.set(s.campaign_id, [...(setsBy.get(s.campaign_id) ?? []), e]);
  }
  return camps.rows.map((c) => ({
    campaign_id: c.id, name: c.name, objective: c.objective, status: c.effective_status, buying_type: c.buying_type, bid_strategy: c.bid_strategy ?? null,
    daily_budget: cents(c.daily_budget), lifetime_budget: cents(c.lifetime_budget), budget_remaining: cents(c.budget_remaining),
    special_ad_categories: c.special_ad_categories ?? [], start_time: c.start_time ?? null, stop_time: c.stop_time ?? null, created_time: c.created_time, updated_time: c.updated_time,
    adsets: setsBy.get(c.id) ?? [],
  }));
}

async function googleSettings(ch, { status, campaignId }) {
  const cid = cidOf(ch);
  const st = status === 'all' ? "campaign.status != 'REMOVED'" : status === 'paused' ? "campaign.status = 'PAUSED'" : "campaign.status = 'ENABLED'";
  const camp = campaignId ? ` AND campaign.id = ${String(campaignId).replace(/\D/g, '') || 0}` : '';
  const rows = await limited(() => gaql(cid, `SELECT campaign.id, campaign.name, campaign.status, campaign.serving_status, campaign.advertising_channel_type, campaign.advertising_channel_sub_type, campaign.bidding_strategy_type, campaign.start_date_time, campaign.end_date_time, campaign.network_settings.target_google_search, campaign.network_settings.target_search_network, campaign.network_settings.target_content_network, campaign.geo_target_type_setting.positive_geo_target_type, campaign.target_cpa.target_cpa_micros, campaign.maximize_conversions.target_cpa_micros, campaign.target_roas.target_roas, campaign.maximize_conversion_value.target_roas, campaign_budget.amount_micros, campaign_budget.delivery_method FROM campaign WHERE ${st}${camp} LIMIT 1000`));
  const ids = rows.map((r) => r.campaign.id);
  const groups = new Map();
  const locs = new Map();
  const warnings = [];
  if (ids.length) {
    try {
      const g = await limited(() => gaql(cid, `SELECT campaign.id, ad_group.id, ad_group.name, ad_group.status, ad_group.cpc_bid_micros FROM ad_group WHERE ad_group.status != 'REMOVED' AND campaign.id IN (${ids.join(',')}) LIMIT 5000`));
      for (const r of g) groups.set(r.campaign.id, [...(groups.get(r.campaign.id) ?? []), { adset_id: r.adGroup.id, name: r.adGroup.name, status: r.adGroup.status, cpc_bid: r.adGroup.cpcBidMicros ? +r.adGroup.cpcBidMicros / 1e6 : null }]);
    } catch (e) { warnings.push(`Grupos de anúncios indisponíveis: ${String(e.message).slice(0, 100)}`); }
    try {
      const l = await limited(() => gaql(cid, `SELECT campaign.id, campaign_criterion.negative, campaign_criterion.location.geo_target_constant, campaign_criterion.proximity.radius, campaign_criterion.proximity.radius_units, campaign_criterion.proximity.address.city_name FROM campaign_criterion WHERE campaign_criterion.type IN ('LOCATION','PROXIMITY') AND campaign.id IN (${ids.join(',')}) LIMIT 5000`));
      const consts = [...new Set(l.map((r) => r.campaignCriterion.location?.geoTargetConstant).filter(Boolean))];
      const names = new Map();
      if (consts.length) {
        const n = await limited(() => gaql(cid, `SELECT geo_target_constant.resource_name, geo_target_constant.canonical_name FROM geo_target_constant WHERE geo_target_constant.resource_name IN (${consts.map((c) => `'${c}'`).join(',')})`));
        for (const r of n) names.set(r.geoTargetConstant.resourceName, r.geoTargetConstant.canonicalName);
      }
      for (const r of l) {
        const c = r.campaignCriterion;
        const label = c.location ? (names.get(c.location.geoTargetConstant) ?? c.location.geoTargetConstant) : `raio ${c.proximity?.radius ?? '?'} ${c.proximity?.radiusUnits ?? ''} ${c.proximity?.address?.cityName ?? ''}`.trim();
        locs.set(r.campaign.id, [...(locs.get(r.campaign.id) ?? []), { location: label, excluded: !!c.negative }]);
      }
    } catch (e) { warnings.push(`Segmentação geográfica indisponível: ${String(e.message).slice(0, 100)}`); }
  }
  return {
    warnings,
    campaigns: rows.map(({ campaign: c, campaignBudget: b }) => ({
      campaign_id: c.id, name: c.name, status: c.status, serving_status: c.servingStatus, channel_type: c.advertisingChannelType, channel_subtype: c.advertisingChannelSubType,
      bidding_strategy: c.biddingStrategyType, target_cpa: ((c.targetCpa?.targetCpaMicros ?? c.maximizeConversions?.targetCpaMicros) ? +(c.targetCpa?.targetCpaMicros ?? c.maximizeConversions?.targetCpaMicros) / 1e6 : null),
      target_roas: c.targetRoas?.targetRoas ?? c.maximizeConversionValue?.targetRoas ?? null,
      daily_budget: b?.amountMicros ? +b.amountMicros / 1e6 : null, budget_delivery: b?.deliveryMethod ?? null,
      start_date: c.startDateTime ?? null, end_date: c.endDateTime && !c.endDateTime.startsWith('2037') ? c.endDateTime : null,
      networks: { google_search: c.networkSettings?.targetGoogleSearch ?? null, search_partners: c.networkSettings?.targetSearchNetwork ?? null, display: c.networkSettings?.targetContentNetwork ?? null },
      geo_target_type: c.geoTargetTypeSetting?.positiveGeoTargetType ?? null, locations: locs.get(c.id) ?? [], adsets: groups.get(c.id) ?? [],
    })),
  };
}

export async function campaignSettings({ clientId, platform, status, campaignId }) {
  const client = clientOf(clientId);
  const chs = channelsOf(clientId, platform);
  const out = { client: { id: client.id, name: client.name }, platforms: [], warnings: [] };
  await Promise.all(chs.map(async (ch) => {
    const block = { platform: ch.platform, account_id: ch.account_id };
    try {
      if (!REAL_ID.test(ch.account_id)) throw new ToolError('ID da conta não cadastrado ou inválido.');
      const info = await accountInfo(ch).catch(() => ({}));
      block.currency = info.currency ?? null;
      const r = await cached(`set|${ch.id}|${ch.account_id}|${status}|${campaignId ?? ''}`, 300_000,
        async () => (ch.platform === 'meta' ? { campaigns: await metaSettings(ch, { status, campaignId }), warnings: [] } : googleSettings(ch, { status, campaignId })));
      block.campaigns = r.campaigns;
      block.warnings = r.warnings;
    } catch (e) {
      block.error = String(e.message).slice(0, 300);
      out.warnings.push(`Configurações de ${ch.platform} indisponíveis: ${block.error}`);
    }
    out.platforms.push(block);
  }));
  out.platforms.sort((a, b) => a.platform.localeCompare(b.platform));
  out.data_freshness = { fetched_at: new Date().toISOString() };
  return out;
}

/* ------------------------------ Histórico de alterações ------------------------------ */
const camel = (p) => p.split('.').map((s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase()));
/** Valores longos (listas de regras, públicos…) são cortados para não estourar o contexto. */
const clip = (v) => {
  if (v === undefined) return null;
  const t = JSON.stringify(v);
  return t.length > 400 ? `${t.slice(0, 400)}…` : v;
};
const clipDeep = (o) => {
  if (o == null || typeof o !== 'object') return typeof o === 'string' && o.length > 300 ? `${o.slice(0, 300)}…` : o ?? null;
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, clipDeep(v)]));
};
const pick = (obj, path) => camel(path).reduce((o, k) => (o == null ? undefined : o[k]), obj);

async function googleChanges(ch, { from, to, limit }) {
  const cid = cidOf(ch);
  const today = todayBR();
  const min = addDays(today, -29); // a API só guarda 30 dias
  const warnings = [];
  let f = from;
  if (f < min) { f = min; warnings.push(`O histórico de alterações do Google cobre só os últimos 30 dias; período ajustado para ${min}.`); }
  const rows = await limited(() => gaql(cid, `SELECT change_event.change_date_time, change_event.user_email, change_event.client_type, change_event.change_resource_type, change_event.change_resource_name, change_event.resource_change_operation, change_event.changed_fields, change_event.old_resource, change_event.new_resource, campaign.name FROM change_event WHERE change_event.change_date_time >= '${f} 00:00:00' AND change_event.change_date_time <= '${to} 23:59:59' ORDER BY change_event.change_date_time DESC LIMIT ${Math.min(limit, 1000)}`));
  return {
    warnings,
    changes: rows.map((r) => {
      const e = r.changeEvent;
      const kind = String(e.changeResourceType ?? '').toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase()); // AD_GROUP_AD -> adGroupAd
      const paths = String(e.changedFields ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 25);
      const fields = paths.map((p) => ({ field: p, before: clip(pick(e.oldResource?.[kind], p)), after: clip(pick(e.newResource?.[kind], p)) }));
      return {
        time: e.changeDateTime, user: e.userEmail, source: e.clientType, resource_type: e.changeResourceType, operation: e.resourceChangeOperation,
        campaign: r.campaign?.name ?? null, resource: e.changeResourceName, changed_fields: fields,
      };
    }),
  };
}

async function metaChanges(ch, { from, to, limit }) {
  const ctx = metaCtx(ch);
  const q = new URLSearchParams({
    fields: 'event_time,event_type,translated_event_type,object_id,object_name,object_type,actor_name,application_name,extra_data',
    since: from, until: addDays(to, 1), limit: '100',
  });
  const { rows } = await metaPaged(`${ctx.base}/activities?${q}`, ctx.headers, 1000);
  const parsed = rows.map((a) => {
    let extra = a.extra_data;
    try { extra = typeof extra === 'string' ? JSON.parse(extra) : extra; } catch { /* mantém texto */ }
    return { a, extra };
  }).filter(({ extra }) => extra?.type !== 'payment_amount'); // cobranças diárias não são alterações de campanha
  return {
    warnings: rows.length >= 1000 ? ['Histórico do Meta truncado em 1000 eventos; reduza o período.'] : [],
    changes: parsed.slice(0, limit).map(({ a, extra }) => {
      return {
        time: a.event_time, user: a.actor_name, source: a.application_name ?? null, event: a.translated_event_type ?? a.event_type, object_type: a.object_type,
        object_id: a.object_id, object_name: a.object_name, details: clipDeep(extra),
      };
    }),
  };
}

export async function changeHistory({ clientId, platform, from, to, limit }) {
  checkRange(from, to);
  const client = clientOf(clientId);
  const chs = channelsOf(clientId, platform);
  const out = { client: { id: client.id, name: client.name }, period: { from, to }, platforms: [], warnings: [] };
  await Promise.all(chs.map(async (ch) => {
    const block = { platform: ch.platform, account_id: ch.account_id };
    try {
      if (!REAL_ID.test(ch.account_id)) throw new ToolError('ID da conta não cadastrado ou inválido.');
      const r = await cached(`chg|${ch.id}|${ch.account_id}|${from}|${to}|${limit}`, 300_000,
        () => (ch.platform === 'meta' ? metaChanges(ch, { from, to, limit }) : googleChanges(ch, { from, to, limit })));
      block.changes = r.changes;
      block.count = r.changes.length;
      block.warnings = r.warnings;
    } catch (e) {
      block.error = String(e.message).slice(0, 300);
      out.warnings.push(`Histórico de ${ch.platform} indisponível: ${block.error}`);
    }
    out.platforms.push(block);
  }));
  out.platforms.sort((a, b) => a.platform.localeCompare(b.platform));
  out.data_freshness = { fetched_at: new Date().toISOString() };
  return out;
}
