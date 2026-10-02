import { all, run, tx } from './db.js';
import { getSetting } from './settings.js';
import { todayBR, addDays, isDate } from './metrics.js';
import { evaluateAlerts } from './alerts.js';

const META_V = process.env.META_API_VERSION || 'v21.0';
const GADS_V = process.env.GOOGLE_ADS_API_VERSION || 'v25';
const WINDOW_DAYS = 30;
const REAL_ID = /^(act_)?\d[\d-]{5,}$/;

const META_GROUPS = {
  lead: ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead'],
  message: ['onsite_conversion.messaging_conversation_started_7d'],
  purchase: ['purchase', 'offsite_conversion.fb_pixel_purchase', 'omni_purchase'],
  click: ['link_click'],
  lpv: ['landing_page_view'],
  follow: ['follow', 'onsite_conversion.follow', 'instagram_profile_follow'],
  pagelike: ['like'],
};
// "auto": CPL = leads + conversas iniciadas; CPA = compras; seguidores = follows do Instagram + curtidas da página
const AUTO = { cpl: ['lead', 'message'], cpa: ['purchase'], followers: ['follow', 'pagelike'] };

async function http(url, opts = {}) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(30000) });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  if (!r.ok) {
    const looksHtml = /^\s*<(!doctype|html)/i.test(text);
    const msg = json?.error?.message || json?.error_description || json?.[0]?.error?.message
      || (looksHtml ? (r.status === 404 ? 'endereço da API não encontrado (versão da API desativada? confira GOOGLE_ADS_API_VERSION no .env)' : 'resposta inesperada do servidor') : text.slice(0, 160));
    throw new Error(`HTTP ${r.status}: ${msg}`);
  }
  return json;
}

/* ------------------------------ Meta ------------------------------ */
async function fetchMeta(ch, from, to) {
  const token = getSetting('meta_access_token');
  if (!token) throw new Error('Meta Access Token não configurado');
  const id = `act_${ch.account_id.replace(/^act_/, '')}`;
  const headers = { authorization: `Bearer ${token}` };
  const reach = ch.metric === 'reach';
  // seguidores/alcance têm evento próprio; "evento de resultado" só vale para CPL/CPA
  const groups = META_GROUPS[ch.result_type] && ['cpl', 'cpa'].includes(ch.metric) ? [ch.result_type] : (AUTO[ch.metric] ?? []);

  const q = new URLSearchParams({
    level: 'account', time_increment: '1', fields: 'spend,actions,reach,impressions,clicks', limit: '100',
    time_range: JSON.stringify({ since: from, until: to }),
  });
  const ins = await http(`https://graph.facebook.com/${META_V}/${id}/insights?${q}`, { headers });
  const days = (ins.data ?? []).map((d) => {
    // cada grupo conta uma vez (lead e lead_grouped descrevem o mesmo evento); grupos se somam
    const conv = groups.reduce((sum, g) => {
      const v = (d.actions ?? []).filter((a) => META_GROUPS[g].includes(a.action_type)).map((a) => +a.value);
      return sum + (v.length ? Math.max(...v) : 0);
    }, 0);
    return {
      date: d.date_start, spend: +d.spend || 0, conv: reach ? +d.reach || 0 : conv,
      impressions: +d.impressions || 0, clicks: +d.clicks || 0, reach: +d.reach || 0,
    };
  });

  let balance = null, problem = null, funding = null;
  const acc = await http(
    `https://graph.facebook.com/${META_V}/${id}?fields=account_status,is_prepay_account,funding_source_details,spend_cap,amount_spent`, { headers },
  );
  if (acc.account_status && acc.account_status !== 1) problem = 'Conta Meta não está ativa';
  const display = acc.funding_source_details?.display_string || '';
  // forma de pagamento: pré-pago (recarga manual), cartão (cobrança automática) ou outro meio automático
  if (acc.is_prepay_account) funding = 'prepaid';
  else if (acc.funding_source_details?.type === 1) funding = 'card';
  else if (acc.funding_source_details) funding = 'auto';
  const m = display.match(/(\d{1,3}(?:\.\d{3})*,\d{2})/);
  if (acc.is_prepay_account && m) balance = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
  // conta com teto de gastos: saldo = teto − gasto (valores vêm em centavos)
  else if (+acc.spend_cap > 0) balance = Math.max(0, (+acc.spend_cap - (+acc.amount_spent || 0)) / 100);
  return { days, balance, problem, funding };
}

/* ------------------------------ Google ------------------------------ */
let gToken = { value: '', exp: 0 };
async function googleAccessToken() {
  if (gToken.exp > Date.now() + 60000) return gToken.value;
  const body = new URLSearchParams({
    client_id: getSetting('google_client_id'), client_secret: getSetting('google_client_secret'),
    refresh_token: getSetting('google_refresh_token'), grant_type: 'refresh_token',
  });
  if (!body.get('client_id') || !body.get('client_secret') || !body.get('refresh_token')) {
    throw new Error('Credenciais OAuth do Google incompletas');
  }
  const j = await http('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
  });
  gToken = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return gToken.value;
}

async function gaql(customerId, query) {
  const dev = getSetting('google_developer_token');
  if (!dev) throw new Error('Google Developer Token não configurado');
  const headers = {
    authorization: `Bearer ${await googleAccessToken()}`, 'developer-token': dev, 'content-type': 'application/json',
  };
  const login = getSetting('google_login_customer_id').replace(/\D/g, '');
  if (login) headers['login-customer-id'] = login;
  const j = await http(`https://googleads.googleapis.com/${GADS_V}/customers/${customerId}/googleAds:searchStream`, {
    method: 'POST', headers, body: JSON.stringify({ query }),
  });
  return (Array.isArray(j) ? j : [j]).flatMap((b) => b.results ?? []);
}

async function fetchGoogle(ch, from, to) {
  if (![from, to].every(isDate)) throw new Error('intervalo inválido');
  const cid = ch.account_id.replace(/\D/g, '');
  const rows = await gaql(cid, `SELECT segments.date, metrics.cost_micros, metrics.conversions, metrics.impressions, metrics.clicks FROM customer WHERE segments.date BETWEEN '${from}' AND '${to}'`);
  const days = rows.map((r) => ({ date: r.segments.date, spend: (+r.metrics.costMicros || 0) / 1e6, conv: +r.metrics.conversions || 0, impressions: +r.metrics.impressions || 0, clicks: +r.metrics.clicks || 0, reach: 0 }));

  let balance = null, funding = null;
  try {
    const all = await gaql(cid, "SELECT account_budget.approved_spending_limit_type, account_budget.approved_spending_limit_micros, account_budget.adjusted_spending_limit_micros, account_budget.amount_served_micros, account_budget.approved_start_date_time, account_budget.approved_end_date_time FROM account_budget WHERE account_budget.status = 'APPROVED'");
    // só o orçamento vigente hoje: orçamentos antigos/encerrados continuam APPROVED e distorciam o saldo
    const now = new Date().toISOString().slice(0, 10);
    const cur = all.filter((x) => {
      const a = x.accountBudget || {};
      const start = (a.approvedStartDateTime || '').slice(0, 10);
      const end = (a.approvedEndDateTime || '').slice(0, 10);
      return (!start || start <= now) && (!end || end >= now);
    });
    const b = cur.length ? cur : all;
    const limitOf = (x) => +(x.accountBudget.adjustedSpendingLimitMicros || x.accountBudget.approvedSpendingLimitMicros || 0);
    if (b.length && b.every((x) => limitOf(x))) {
      const raw = b.reduce((s, x) => s + (limitOf(x) - +(x.accountBudget.amountServedMicros || 0)), 0) / 1e6;
      balance = Math.max(0, raw);
    }
    // orçamento ilimitado = sem recarga manual (cartão/faturamento); com teto = recarga manual
    if (b.length) funding = b.some((x) => x.accountBudget?.approvedSpendingLimitType === 'INFINITE') ? 'auto' : 'prepaid';
  } catch { /* contas com faturamento mensal não têm account_budget */ }
  // sem orçamento de conta, mas com cobrança aprovada: pagamento automático (cartão ou faturamento mensal)
  if (!funding) {
    try {
      const bs = await gaql(cid, "SELECT billing_setup.status FROM billing_setup WHERE billing_setup.status = 'APPROVED'");
      if (bs.length) funding = 'auto';
    } catch { /* sem permissão de leitura da cobrança: deixa indefinido */ }
  }
  return { days, balance, problem: null, funding };
}

/* ------------------------------ Orquestração ------------------------------ */
async function syncChannel(ch) {
  const to = todayBR();
  const from = addDays(to, -(WINDOW_DAYS - 1));
  try {
    const res = ch.platform === 'meta' ? await fetchMeta(ch, from, to) : await fetchGoogle(ch, from, to);
    tx(() => {
      for (const d of res.days) {
        run(`INSERT INTO metrics_daily (channel_id,date,spend,conversions,impressions,clicks,reach) VALUES (?,?,?,?,?,?,?)
             ON CONFLICT(channel_id,date) DO UPDATE SET spend=excluded.spend, conversions=excluded.conversions,
               impressions=excluded.impressions, clicks=excluded.clicks, reach=excluded.reach`,
        ch.id, d.date, d.spend, d.conv, d.impressions ?? 0, d.clicks ?? 0, d.reach ?? 0);
      }
      run(`INSERT INTO channel_status (channel_id,balance,last_sync,error,funding) VALUES (?,?,unixepoch(),?,?)
           ON CONFLICT(channel_id) DO UPDATE SET balance=excluded.balance, last_sync=excluded.last_sync, error=excluded.error, funding=excluded.funding`,
      ch.id, res.balance, res.problem, res.funding ?? null);
    });
    return true;
  } catch (e) {
    const msg = String(e.message).slice(0, 200);
    console.error(`[sync] canal ${ch.id} (${ch.platform}):`, msg);
    run(`INSERT INTO channel_status (channel_id,last_sync,error) VALUES (?,unixepoch(),?)
         ON CONFLICT(channel_id) DO UPDATE SET last_sync=excluded.last_sync, error=excluded.error`, ch.id, msg);
    return false;
  }
}

let running = false;
export const isSyncing = () => running;

export async function syncAll() {
  if (running) return { skipped: true };
  running = true;
  const result = { ok: 0, failed: 0, skipped: 0 };
  try {
    const chs = all(`SELECT ch.* FROM channels ch JOIN clients c ON c.id = ch.client_id WHERE ch.active = 1 AND c.active = 1`);
    const real = chs.filter((c) => REAL_ID.test(c.account_id));
    result.skipped = chs.length - real.length;
    const queue = [...real];
    await Promise.all(Array.from({ length: 3 }, async () => {
      for (let ch = queue.shift(); ch; ch = queue.shift()) (await syncChannel(ch)) ? result.ok++ : result.failed++;
    }));
    evaluateAlerts();
  } finally { running = false; }
  return result;
}

/* ------------------------------ Campanhas ativas (ao vivo) ------------------------------ */
/** Retorna [{name, budget, spend, results, impressions, clicks}] das campanhas ativas do canal. */
export async function fetchCampaigns(ch, from, to) {
  if (!REAL_ID.test(ch.account_id)) return [];
  if (ch.platform === 'meta') {
    const token = getSetting('meta_access_token');
    if (!token) throw new Error('Meta Access Token não configurado');
    const id = `act_${ch.account_id.replace(/^act_/, '')}`;
    const headers = { authorization: `Bearer ${token}` };
    const base = `https://graph.facebook.com/${META_V}/${id}`;
    const list = await http(`${base}/campaigns?${new URLSearchParams({
      fields: 'name,daily_budget,lifetime_budget,objective', effective_status: '["ACTIVE"]', limit: '100',
    })}`, { headers });
    const ins = await http(`${base}/insights?${new URLSearchParams({
      level: 'campaign', fields: 'campaign_id,spend,impressions,clicks,reach,actions', limit: '200',
      time_range: JSON.stringify({ since: from, until: to }),
    })}`, { headers });
    const byId = new Map((ins.data ?? []).map((r) => [r.campaign_id, r]));
    const groups = META_GROUPS[ch.result_type] && ['cpl', 'cpa'].includes(ch.metric) ? [ch.result_type] : (AUTO[ch.metric] ?? []);
    return (list.data ?? []).map((c) => {
      const r = byId.get(c.id) ?? {};
      const results = ch.metric === 'reach' ? +r.reach || 0 : groups.reduce((sum, g) => {
        const v = (r.actions ?? []).filter((a) => META_GROUPS[g].includes(a.action_type)).map((a) => +a.value);
        return sum + (v.length ? Math.max(...v) : 0);
      }, 0);
      return {
        name: c.name, objective: c.objective, budget: c.daily_budget ? +c.daily_budget / 100 : null,
        spend: +r.spend || 0, results, impressions: +r.impressions || 0, clicks: +r.clicks || 0,
      };
    });
  }
  if (![from, to].every(isDate)) throw new Error('intervalo inválido');
  const cid = ch.account_id.replace(/\D/g, '');
  const rows = await gaql(cid, `SELECT campaign.name, campaign_budget.amount_micros, metrics.cost_micros, metrics.conversions, metrics.impressions, metrics.clicks FROM campaign WHERE campaign.status = 'ENABLED' AND segments.date BETWEEN '${from}' AND '${to}'`);
  const acc = new Map();
  for (const r of rows) {
    const k = r.campaign.name;
    const a = acc.get(k) ?? { name: k, budget: r.campaignBudget?.amountMicros ? +r.campaignBudget.amountMicros / 1e6 : null, spend: 0, results: 0, impressions: 0, clicks: 0 };
    a.spend += (+r.metrics.costMicros || 0) / 1e6; a.results += +r.metrics.conversions || 0;
    a.impressions += +r.metrics.impressions || 0; a.clicks += +r.metrics.clicks || 0;
    acc.set(k, a);
  }
  return [...acc.values()];
}
