import { all } from './db.js';

const TZ = 'America/Sao_Paulo';

export const todayBR = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
export const hourBR = () => +new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(new Date());

export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

export function resolveRange(range, from, to) {
  const today = todayBR();
  if (range === 'yesterday') { const y = addDays(today, -1); return { from: y, to: y, label: 'Ontem' }; }
  if (range === 'custom' && isDate(from) && isDate(to) && from <= to) return { from, to, label: 'Personalizado' };
  const n = { '7': 7, '14': 14, '30': 30 }[range];
  if (n) return { from: addDays(today, -(n - 1)), to: today, label: `${n} dias` };
  return { from: today, to: today, label: 'Hoje' };
}

const round = (n, d = 2) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

function sum(days, from, to) {
  let spend = 0, conv = 0;
  for (const [d, v] of days) if (d >= from && d <= to) { spend += v.spend; conv += v.conv; }
  return { spend, conv };
}

/** Status do canal: depende SOMENTE do saldo (crítico < 1,5 dia, atenção < 4 dias). Métricas de resultado não alteram o status. */
function classify(ch, m) {
  const reasons = [];
  let level = 0;
  const bump = (l, why) => { level = Math.max(level, l); reasons.push(why); };
  if (m.daysLeft != null) {
    if (m.daysLeft < 1.5) bump(2, 'Saldo acaba em menos de 2 dias');
    else if (m.daysLeft < 4) bump(1, 'Saldo baixo');
  } else if (m.balance != null && m.balance <= 0 && m.avg7 > 0) bump(2, 'Conta sem saldo');
  const status = level === 2 ? 'critical' : level === 1 ? 'warning' : (m.spend > 0 || m.balance != null ? 'ok' : 'idle');
  return { status, reasons };
}

export function buildDashboard({ from, to }) {
  const today = todayBR();
  const channels = all(
    `SELECT ch.*, c.name AS client_name, c.manager_id, c.monthly_budget, u.name AS manager_name,
            cs.balance, cs.last_sync, cs.error, cs.funding
       FROM channels ch
       JOIN clients c ON c.id = ch.client_id
       LEFT JOIN users u ON u.id = c.manager_id
       LEFT JOIN channel_status cs ON cs.channel_id = ch.id
      WHERE c.active = 1 AND ch.active = 1
      ORDER BY c.name, ch.platform`,
  );
  const rows = all('SELECT channel_id, date, spend, conversions, reach FROM metrics_daily WHERE date >= ?', addDays(today, -59));
  const byChannel = new Map();
  const reachIds = new Set(channels.filter((c) => c.metric === 'reach').map((c) => c.id)); // em canais de alcance, o "resultado" é o alcance
  for (const r of rows) {
    if (!byChannel.has(r.channel_id)) byChannel.set(r.channel_id, new Map());
    byChannel.get(r.channel_id).set(r.date, { spend: r.spend, conv: reachIds.has(r.channel_id) ? r.reach : r.conversions });
  }
  const monthStart = `${today.slice(0, 7)}-01`;
  const clients = new Map();

  for (const ch of channels) {
    const days = byChannel.get(ch.id) ?? new Map();
    const range = sum(days, from, to);
    const t = sum(days, today, today);
    const avg7 = sum(days, addDays(today, -6), today).spend / 7;
    // cartão/pagamento automático: não há recarga manual, então não há saldo a monitorar
    const autoPay = ch.funding === 'card' || ch.funding === 'auto';
    if (autoPay) ch.balance = null;
    const daysLeft = ch.balance != null && avg7 > 0 ? ch.balance / avg7 : null;
    const isReach = ch.metric === 'reach';
    const nDays = Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1;
    const cpr = isReach ? range.conv / nDays : (range.conv > 0 ? range.spend / range.conv : null);
    const trends = {};
    for (const n of [7, 14, 30]) {
      const s = isReach ? sum(days, addDays(today, -n), addDays(today, -1)) : sum(days, addDays(today, -(n - 1)), today);
      const v = isReach ? (s.spend > 0 ? s.conv / n : null) : (s.conv > 0 ? s.spend / s.conv : null);
      trends[n] = v != null && ch.target > 0 ? round(((v - ch.target) / ch.target) * 100, 0) : null;
    }
    const spark = [];
    for (let i = 13; i >= 0; i--) spark.push(round(days.get(addDays(today, -i))?.spend ?? 0));
    const month = sum(days, monthStart, today);
    const s3 = sum(days, addDays(today, -2), today);
    const r3 = sum(days, addDays(today, -3), addDays(today, -1));
    // anomalias: ritmo de hoje vs. semana anterior; conversões que somem após período saudável
    const prev7 = sum(days, addDays(today, -7), addDays(today, -1));
    const prior = sum(days, addDays(today, -9), addDays(today, -2));
    const last2 = sum(days, addDays(today, -1), today);
    const m = {
      reach3: r3.conv / 3,
      spend: range.spend, conv: range.conv, cpr, avg7, daysLeft, balance: ch.balance, error: ch.error,
      cpr3: s3.conv > 0 ? s3.spend / s3.conv : null, spend3: s3.spend,
    };
    const { status, reasons } = classify(ch, m);
    const item = {
      id: ch.id, platform: ch.platform, metric: ch.metric, target: ch.target,
      spend: round(range.spend), conversions: round(range.conv, 1), cpr: round(cpr),
      todaySpend: round(t.spend), todayConv: round(t.conv, 1),
      balance: round(ch.balance), funding: ch.funding ?? null, daysLeft: round(daysLeft, 1), trends, spark,
      monthSpend: round(month.spend), lastSync: ch.last_sync, error: ch.error, status, reasons,
      higherBetter: isReach, _avg7: avg7, _reach3: r3.conv / 3,
      depletionDate: daysLeft != null ? addDays(today, Math.max(0, Math.floor(daysLeft))) : null,
      _avgPrev7: prev7.spend / 7, _priorConv: prior.conv, _spend2: last2.spend, _conv2: last2.conv,
    };
    if (!clients.has(ch.client_id)) {
      clients.set(ch.client_id, {
        id: ch.client_id, name: ch.client_name, manager_id: ch.manager_id, manager: ch.manager_name,
        monthlyBudget: ch.monthly_budget, channels: [],
      });
    }
    clients.get(ch.client_id).channels.push(item);
  }

  const rank = { critical: 3, warning: 2, ok: 1, idle: 0 };
  const list = [...clients.values()].map((c) => {
    c.status = c.channels.reduce((w, x) => (rank[x.status] > rank[w] ? x.status : w), 'idle');
    c.monthSpend = round(c.channels.reduce((s, x) => s + x.monthSpend, 0));
    c.pacing = c.monthlyBudget > 0 ? round((c.monthSpend / c.monthlyBudget) * 100, 0) : null;
    // previsão de fechamento do mês: gasto até hoje + ritmo médio dos últimos 7 dias × dias restantes
    const [y, mo, dd] = today.split('-').map(Number);
    const remaining = new Date(Date.UTC(y, mo, 0)).getUTCDate() - dd;
    c.projectedSpend = round(c.monthSpend + c.channels.reduce((s, x) => s + x._avg7, 0) * remaining);
    c.projectedPct = c.monthlyBudget > 0 ? round((c.projectedSpend / c.monthlyBudget) * 100, 0) : null;
    c.dayOfMonth = dd;
    return c;
  });

  const totals = { spend: 0, conversions: 0, critical: 0, warning: 0, ok: 0, channels: 0 };
  for (const c of list) {
    totals[c.status === 'critical' ? 'critical' : c.status === 'warning' ? 'warning' : 'ok']++;
    for (const x of c.channels) {
      totals.spend += x.spend; totals.channels++;
      if (x.metric !== 'reach') totals.conversions += x.conversions; // alcance não é "resultado" comparável
    }
  }
  totals.spend = round(totals.spend);
  totals.conversions = round(totals.conversions, 0);
  totals.cpr = totals.conversions > 0 ? round(totals.spend / totals.conversions) : null;

  return { from, to, clients: list, totals, generatedAt: Date.now() };
}

/** Série diária de um cliente (todos os canais) para os gráficos. */
export function clientSeries(clientId, days) {
  const today = todayBR();
  const from = addDays(today, -(days - 1));
  const chs = all('SELECT id, platform, metric, target FROM channels WHERE client_id = ? AND active = 1', clientId);
  const out = [];
  for (const ch of chs) {
    const map = new Map(all('SELECT date, spend, conversions, reach FROM metrics_daily WHERE channel_id = ? AND date >= ?', ch.id, from)
      .map((r) => [r.date, r]));
    const points = [];
    for (let i = 0; i < days; i++) {
      const d = addDays(from, i);
      const r = map.get(d);
      const spend = r?.spend ?? 0, conv = (ch.metric === 'reach' ? r?.reach : r?.conversions) ?? 0;
      points.push({ date: d, spend: round(spend), conversions: round(conv, 1), cpr: ch.metric === 'reach' ? round(conv, 0) : (conv > 0 ? round(spend / conv) : null) });
    }
    out.push({ ...ch, points });
  }
  return out;
}

/** Detalhe de um cliente no período: totais, blocos por plataforma e séries diárias. */
export function clientDetail(clientId, { from, to }, metricFilter = '') {
  const chs = all(
    `SELECT ch.*, cs.balance, cs.error, cs.funding FROM channels ch LEFT JOIN channel_status cs ON cs.channel_id = ch.id
      WHERE ch.client_id = ? AND ch.active = 1 ORDER BY ch.platform`, clientId,
  ).filter((c) => !metricFilter || c.metric === metricFilter);
  const dates = [];
  for (let d = from; d <= to && dates.length < 400; d = addDays(d, 1)) dates.push(d);
  const zero = () => ({ spend: 0, conv: 0, impressions: 0, clicks: 0, reach: 0 });
  const tot = zero();
  const platforms = chs.map((ch) => {
    const rows = new Map(all('SELECT * FROM metrics_daily WHERE channel_id = ? AND date BETWEEN ? AND ?', ch.id, from, to).map((r) => [r.date, r]));
    const a = zero();
    const series = dates.map((date) => {
      const r = rows.get(date);
      const p = { date, spend: r?.spend ?? 0, conv: r?.conversions ?? 0, impressions: r?.impressions ?? 0, clicks: r?.clicks ?? 0, reach: r?.reach ?? 0 };
      for (const k of Object.keys(a)) a[k] += p[k];
      return p;
    });
    const isReach = ch.metric === 'reach';
    const results = isReach ? 0 : a.conv;
    for (const k of ['spend', 'impressions', 'clicks', 'reach']) tot[k] += a[k];
    tot.conv += results;
    return {
      id: ch.id, platform: ch.platform, metric: ch.metric, target: ch.target, balance: ch.funding === 'card' || ch.funding === 'auto' ? null : round(ch.balance), funding: ch.funding ?? null, error: ch.error,
      totals: {
        spend: round(a.spend), results: round(results, 1), reach: round(a.reach, 0), impressions: round(a.impressions, 0), clicks: round(a.clicks, 0),
        cpr: !isReach && results > 0 ? round(a.spend / results) : null,
        ctr: a.impressions > 0 ? round((a.clicks / a.impressions) * 100) : null,
        cpc: a.clicks > 0 ? round(a.spend / a.clicks) : null,
        cpm: a.impressions > 0 ? round((a.spend / a.impressions) * 1000) : null,
        avgReach: dates.length ? round(a.reach / dates.length, 0) : null,
      },
      series,
    };
  });
  const cl = all('SELECT name FROM clients WHERE id = ?', clientId)[0];
  return {
    name: cl?.name, from, to, dates, platforms,
    totals: {
      spend: round(tot.spend), results: round(tot.conv, 1), reach: round(tot.reach, 0), impressions: round(tot.impressions, 0), clicks: round(tot.clicks, 0),
      cpr: tot.conv > 0 ? round(tot.spend / tot.conv) : null,
      ctr: tot.impressions > 0 ? round((tot.clicks / tot.impressions) * 100) : null,
      cpc: tot.clicks > 0 ? round(tot.spend / tot.clicks) : null,
      cpm: tot.impressions > 0 ? round((tot.spend / tot.impressions) * 1000) : null,
    },
  };
}
