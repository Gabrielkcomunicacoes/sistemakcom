import { esc, brl, num } from './core.js';
import { multiChart } from './charts.js';

const PLAT = { google: 'Google Ads', meta: 'Meta Ads' };
const COLOR = { google: 'var(--google)', meta: 'var(--meta)' };
const int = (n) => (n == null ? '—' : Math.round(n).toLocaleString('pt-BR'));
const dmy = (d) => d.split('-').reverse().join('/');

/** Variação vs. período anterior. goodUp: true = subir é bom, false = subir é ruim, null = neutro. */
function delta(v, goodUp) {
  if (v == null) return '<span class="muted">—</span>';
  const cls = goodUp == null || v === 0 ? 'muted' : (v > 0) === goodUp ? 'dpos' : 'dneg';
  return `<span class="${cls}" style="font-weight:700">${v > 0 ? '▲' : v < 0 ? '▼' : ''} ${Math.abs(v).toLocaleString('pt-BR')}%</span>`;
}

function compareRow(label, cur, prev, d, goodUp) {
  return `<tr><td>${label}</td><td><b>${cur}</b></td><td class="muted">${prev}</td><td>${delta(d, goodUp)}</td></tr>`;
}

export function reportHtml(r) {
  const t = r.totals, p = r.previous, d = r.deltas;
  const reachOnly = r.platforms.length > 0 && r.platforms.every((x) => x.metric === 'reach');
  const kpi = (l, v, sub, k) => `<div class="kpi" style="--k:${k}"><small>${l}</small><strong>${v}</strong><em>${sub}</em></div>`;
  const maxSpend = Math.max(...r.history.map((h) => h.spend), 1);
  const budgetPct = r.budget > 0 ? Math.round((t.spend / r.budget) * 100) : null;

  return `
    <div class="rep-head"><div><h1>${esc(r.client)}</h1>
      <div class="sub">Relatório de desempenho · ${esc(r.label)}${r.partial ? ` (parcial: ${dmy(r.range.from)} a ${dmy(r.range.to)})` : ''}</div></div></div>
    <div class="kpis">
      ${kpi('Investimento', brl(t.spend), `${delta(d.spend, null)} vs. período anterior`, 'var(--accent)')}
      ${kpi('Resultados', reachOnly ? '—' : num(t.results), `${delta(d.results, true)} vs. período anterior`, 'var(--ok)')}
      ${kpi('Custo por resultado', t.cpr != null ? brl(t.cpr) : '—', `${delta(d.cpr, false)} vs. período anterior`, 'var(--warn)')}
      ${kpi('Cliques', int(t.clicks), `${delta(d.clicks, true)} vs. período anterior`, 'var(--accent2)')}
      ${budgetPct != null ? kpi('Verba utilizada', `${budgetPct}%`, `de ${brl(r.budget)}`, 'var(--ok)') : ''}
    </div>

    <section class="panel" style="margin-bottom:16px"><h2>Comparativo com o período anterior
      <span class="muted" style="font-weight:400">· ${dmy(r.range.from)}–${dmy(r.range.to)} vs. ${dmy(r.previousRange.from)}–${dmy(r.previousRange.to)}</span></h2>
      <div class="scroll-x"><table class="table compact"><thead><tr><th>Métrica</th><th>Atual</th><th>Anterior</th><th>Variação</th></tr></thead><tbody>
        ${compareRow('Investimento', brl(t.spend), brl(p.spend), d.spend, null)}
        ${compareRow('Resultados', num(t.results), num(p.results), d.results, true)}
        ${compareRow('Custo por resultado', t.cpr != null ? brl(t.cpr) : '—', p.cpr != null ? brl(p.cpr) : '—', d.cpr, false)}
        ${compareRow('Impressões', int(t.impressions), int(p.impressions), d.impressions, true)}
        ${compareRow('Alcance', int(t.reach), int(p.reach), d.reach, true)}
        ${compareRow('Cliques', int(t.clicks), int(p.clicks), d.clicks, true)}
      </tbody></table></div></section>

    <div class="grid cols-2" style="margin-bottom:16px;align-items:start">
      ${r.platforms.map((x) => `<section class="panel"><h2 style="color:${COLOR[x.platform]}">${PLAT[x.platform]}</h2>
        ${[['Investimento', brl(x.totals.spend)],
          x.metric === 'reach' ? ['Alcance médio/dia', int(x.totals.avgReach)] : ['Resultados', num(x.totals.results)],
          x.metric === 'reach' ? null : ['Custo por resultado', x.totals.cpr != null ? brl(x.totals.cpr) : '—'],
          ['Impressões', int(x.totals.impressions)], ['Cliques', int(x.totals.clicks)],
          ['CTR', x.totals.ctr != null ? `${x.totals.ctr.toLocaleString('pt-BR')}%` : '—'],
          ['CPC', x.totals.cpc != null ? brl(x.totals.cpc) : '—']].filter(Boolean)
        .map(([l, v]) => `<div class="kv"><span>${l}</span><b>${v}</b></div>`).join('')}</section>`).join('')}
    </div>

    <section class="panel" style="margin-bottom:16px"><h2>Investimento por dia</h2>
      ${multiChart({ labels: r.dates, formats: [(v) => brl(v, 0).replace('R$ ', ''), (v) => v],
        series: r.platforms.map((x) => ({ name: `${PLAT[x.platform]} (R$)`, color: COLOR[x.platform], values: x.series.map((s) => s.spend), type: r.dates.length === 1 ? 'bar' : 'line' })) })}</section>

    <section class="panel" style="margin-bottom:16px"><h2>Evolução mês a mês</h2>
      <div class="scroll-x"><table class="table compact"><thead><tr><th>Mês</th><th>Investimento</th><th></th><th>Resultados</th><th>Custo/resultado</th></tr></thead><tbody>
        ${r.history.map((h) => `<tr><td>${esc(h.label)}</td><td>${brl(h.spend)}</td>
          <td style="width:30%"><div class="bar"><i style="width:${Math.round((h.spend / maxSpend) * 100)}%"></i></div></td>
          <td>${num(h.results)}</td><td>${h.cpr != null ? brl(h.cpr) : '—'}</td></tr>`).join('')}
      </tbody></table></div></section>`;
}
