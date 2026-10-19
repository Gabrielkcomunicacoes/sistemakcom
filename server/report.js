import { get, all } from './db.js';
import { clientDetail, addDays, todayBR, isDate } from './metrics.js';
import { ensureReach } from './sync.js';

export const isMonth = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

const prevMonth = (m) => {
  const [y, mo] = m.split('-').map(Number);
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
};
const monthEnd = (m) => {
  const [y, mo] = m.split('-').map(Number);
  return `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}`;
};
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
export const monthLabel = (m) => `${MESES[+m.slice(5) - 1]} de ${m.slice(0, 4)}`;

const pctChange = (cur, prev) => (cur == null || prev == null || prev === 0 ? null : Math.round(((cur - prev) / prev) * 1000) / 10);

const dmy = (d) => d.split('-').reverse().join('/');
const MAX_SPAN_DAYS = 366;

/** Período livre (data específica ou intervalo) a partir de ?from=&to=; null se ausente/inválido. */
export function customRange(from, to = from) {
  if (!isDate(from) || !isDate(to)) return null;
  const today = todayBR();
  if (to > today) to = today;
  if (from > to || (Date.parse(to) - Date.parse(from)) / 864e5 >= MAX_SPAN_DAYS) return null;
  return { from, to };
}

/** Período pedido na query: ?from=&to= (dia único se só `from`) tem prioridade; senão ?month=; senão o mês atual. */
export function periodFromQuery(q) {
  const range = q.from ? customRange(q.from, q.to || q.from) : null;
  return range ? { range } : { month: isMonth(q.month) ? q.month : todayBR().slice(0, 7) };
}

/** Relatório mensal de um cliente: mês escolhido vs. mesmo período do mês anterior + histórico de 6 meses. */
export const monthReport = (clientId, month, opts) => periodReport(clientId, { month }, opts);

/** Período atual e o anterior (mesmo tamanho) de uma consulta de relatório. */
function periodRanges({ month, range }) {
  const today = todayBR();
  let cur, prev, label;
  if (range) {
    cur = range;
    const spanDays = Math.round((Date.parse(cur.to) - Date.parse(cur.from)) / 864e5) + 1;
    prev = { from: addDays(cur.from, -spanDays), to: addDays(cur.from, -1) };
    label = cur.from === cur.to ? dmy(cur.from) : `${dmy(cur.from)} a ${dmy(cur.to)}`;
    month = cur.to.slice(0, 7);
  } else {
    cur = { from: `${month}-01`, to: monthEnd(month) };
    if (cur.to > today) cur.to = today; // mês em andamento: só até hoje
    if (cur.from > today) cur.to = cur.from;
    const spanDays = Math.round((Date.parse(cur.to) - Date.parse(cur.from)) / 864e5) + 1;
    const pm = prevMonth(month);
    prev = { from: `${pm}-01`, to: addDays(`${pm}-01`, spanDays - 1) };
    if (prev.to > monthEnd(pm)) prev.to = monthEnd(pm); // mês anterior mais curto
    label = monthLabel(month);
  }
  return { cur, prev, label, month };
}

/** Busca na Meta o alcance único dos períodos do relatório (cacheado) e então monta o relatório. */
export async function periodReportAsync(clientId, period, opts = {}) {
  const { cur, prev } = periodRanges(period);
  await ensureReach(clientId, opts.showChanges === false ? [cur] : [cur, prev]);
  return periodReport(clientId, period, opts);
}

/** Relatório de um período: mês inteiro, intervalo ou dia único. `showChanges: false` remove tudo que indica crescimento/queda. */
export function periodReport(clientId, period, { showChanges = true } = {}) {
  const today = todayBR();
  const { cur, prev, label, month } = periodRanges(period);
  const range = period.range;

  const now = clientDetail(clientId, cur);
  const t = now.totals;
  const p = showChanges ? clientDetail(clientId, prev).totals : null;

  const history = [];
  let m = month;
  for (let i = 0; showChanges && i < 6; i++) {
    const end = monthEnd(m) > today ? today : monthEnd(m);
    if (`${m}-01` <= end) {
      const d = clientDetail(clientId, { from: `${m}-01`, to: end }).totals;
      history.unshift({ month: m, label: monthLabel(m), spend: d.spend, results: d.results, cpr: d.cpr, clicks: d.clicks });
    }
    m = prevMonth(m);
  }

  const budget = get('SELECT monthly_budget b FROM clients WHERE id = ?', clientId)?.b ?? null;
  return {
    client: now.name, month, label, range: cur, partial: !range && cur.to < monthEnd(month),
    showChanges,
    budget,
    totals: t,
    // com showChanges=false nada de comparação sai do servidor (não basta esconder no navegador)
    ...(showChanges ? {
      previousRange: prev, previous: p,
      deltas: {
        spend: pctChange(t.spend, p.spend), results: pctChange(t.results, p.results), cpr: pctChange(t.cpr, p.cpr),
        clicks: pctChange(t.clicks, p.clicks), impressions: pctChange(t.impressions, p.impressions), reach: pctChange(t.reach, p.reach),
      },
    } : {}),
    // sem saldo/erros/IDs de conta: o relatório pode sair do sistema
    platforms: now.platforms.map((x) => ({ platform: x.platform, metric: x.metric, target: x.target, totals: x.totals, series: x.series })),
    dates: now.dates,
    history,
  };
}

export const activeLink = (hash) => get(
  `SELECT l.client_id, l.show_changes, c.name FROM report_links l JOIN clients c ON c.id = l.client_id
    WHERE l.token_hash = ? AND l.revoked_at IS NULL AND l.expires_at > unixepoch() AND c.active = 1`, hash,
);

export const linksOf = (clientId) => all(
  'SELECT id, created_at, expires_at, revoked_at, show_changes FROM report_links WHERE client_id = ? ORDER BY id DESC LIMIT 20', clientId,
);
