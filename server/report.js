import { get, all } from './db.js';
import { clientDetail, addDays, todayBR } from './metrics.js';

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

/** Relatório mensal de um cliente: mês escolhido vs. mesmo período do mês anterior + histórico de 6 meses. */
export function monthReport(clientId, month) {
  const today = todayBR();
  const cur = { from: `${month}-01`, to: monthEnd(month) };
  if (cur.to > today) cur.to = today; // mês em andamento: só até hoje
  if (cur.from > today) cur.to = cur.from;
  const spanDays = Math.round((Date.parse(cur.to) - Date.parse(cur.from)) / 864e5) + 1;
  const pm = prevMonth(month);
  const prev = { from: `${pm}-01`, to: addDays(`${pm}-01`, spanDays - 1) };
  if (prev.to > monthEnd(pm)) prev.to = monthEnd(pm); // mês anterior mais curto

  const now = clientDetail(clientId, cur);
  const before = clientDetail(clientId, prev);
  const t = now.totals, p = before.totals;

  const history = [];
  let m = month;
  for (let i = 0; i < 6; i++) {
    const end = monthEnd(m) > today ? today : monthEnd(m);
    if (`${m}-01` <= end) {
      const d = clientDetail(clientId, { from: `${m}-01`, to: end }).totals;
      history.unshift({ month: m, label: monthLabel(m), spend: d.spend, results: d.results, cpr: d.cpr, clicks: d.clicks });
    }
    m = prevMonth(m);
  }

  const budget = get('SELECT monthly_budget b FROM clients WHERE id = ?', clientId)?.b ?? null;
  return {
    client: now.name, month, label: monthLabel(month), range: cur, previousRange: prev, partial: cur.to < monthEnd(month),
    budget,
    totals: t, previous: p,
    deltas: {
      spend: pctChange(t.spend, p.spend), results: pctChange(t.results, p.results), cpr: pctChange(t.cpr, p.cpr),
      clicks: pctChange(t.clicks, p.clicks), impressions: pctChange(t.impressions, p.impressions), reach: pctChange(t.reach, p.reach),
    },
    // sem saldo/erros/IDs de conta: o relatório pode sair do sistema
    platforms: now.platforms.map((x) => ({ platform: x.platform, metric: x.metric, target: x.target, totals: x.totals, series: x.series })),
    dates: now.dates,
    history,
  };
}

export const activeLink = (hash) => get(
  `SELECT l.client_id, c.name FROM report_links l JOIN clients c ON c.id = l.client_id
    WHERE l.token_hash = ? AND l.revoked_at IS NULL AND l.expires_at > unixepoch() AND c.active = 1`, hash,
);

export const linksOf = (clientId) => all(
  'SELECT id, created_at, expires_at, revoked_at FROM report_links WHERE client_id = ? ORDER BY id DESC LIMIT 20', clientId,
);
