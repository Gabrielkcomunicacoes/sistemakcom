import { api, state, esc, brl, num, icon, toast, dateTime, METRIC, RESULT_NAME } from '../core.js';
import { reportHtml } from '../report-view.js';
import { lineChart, multiChart } from '../charts.js';

const PLAT = { google: 'Google Ads', meta: 'Meta Ads' };
const COLOR = { google: 'var(--google)', meta: 'var(--meta)' };
const RANGES = [['today', 'Hoje'], ['yesterday', 'Ontem'], ['7', '7 dias'], ['14', '14 dias'], ['30', '30 dias'], ['custom', 'Personalizado']];
const int = (n) => (n == null ? '—' : Math.round(n).toLocaleString('pt-BR'));
const pct = (n) => (n == null ? '—' : `${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`);
const fmtTarget = (p) => (p.metric === 'reach' ? `${int(p.target)}/dia` : brl(p.target));

const prefs = { range: 'today', from: '', to: '', metric: '' };

function kpi(label, value, k) {
  return `<div class="kpi" style="--k:${k}"><small>${label}</small><strong>${value}</strong></div>`;
}

function platformBlock(p) {
  const t = p.totals, reach = p.metric === 'reach';
  const row = (l, v) => `<div class="kv"><span>${l}</span><b>${v}</b></div>`;
  return `<section class="panel">
    <h2 style="display:flex;align-items:center;gap:10px"><span style="color:${COLOR[p.platform]}">${PLAT[p.platform]}</span>
      <span class="badge" style="margin-left:auto">Tipo: ${METRIC[p.metric]} · meta ${fmtTarget(p)}</span></h2>
    ${row('Investimento', brl(t.spend))}
    ${reach ? row('Alcance médio/dia', int(t.avgReach)) : row(RESULT_NAME[p.metric], num(t.results))}
    ${reach ? '' : row('Custo por resultado', t.cpr != null ? brl(t.cpr) : '—')}
    ${row('Alcance', int(t.reach))}${row('Impressões', int(t.impressions))}${row('Cliques', int(t.clicks))}
    ${row('CTR', pct(t.ctr))}${row('CPC', t.cpc != null ? brl(t.cpc) : '—')}${row('CPM', t.cpm != null ? brl(t.cpm) : '—')}
    ${row('Saldo', p.funding === 'card' ? '💳 Cartão automático' : p.funding === 'auto' ? 'Pagamento automático' : p.balance != null ? brl(p.balance) : '—')}
    ${p.error ? `<div class="foot" style="color:var(--warn);margin-top:8px">⚠ ${esc(p.error)}</div>` : ''}
  </section>`;
}

function campaignsHtml(groups) {
  const total = groups.reduce((s, g) => s + g.campaigns.length, 0);
  return `<div class="panel" style="margin-bottom:16px"><h2 style="display:flex;align-items:center">Campanhas ativas <span class="badge" style="margin-left:auto">Total: ${total}</span></h2>
    <div class="grid cols-2">${groups.map((g) => `<div class="ch"><div class="ch-top"><span class="plat ${g.platform}">${PLAT[g.platform]} (${g.campaigns.length})</span></div>
      ${g.error ? `<div style="color:var(--crit);font-size:12.5px;word-break:break-word">${esc(g.error)}</div>`
        : g.campaigns.length ? `<div class="scroll-x"><table class="table compact"><thead><tr><th>Campanha</th><th>Orç./dia</th><th>Gasto</th><th>${g.metric === 'reach' ? 'Alcance' : 'Result.'}</th><th>Cliques</th></tr></thead><tbody>
          ${g.campaigns.map((c) => `<tr><td>${esc(c.name)}</td><td>${c.budget != null ? brl(c.budget) : '—'}</td><td>${brl(c.spend)}</td><td>${num(c.results)}</td><td>${int(c.clicks)}</td></tr>`).join('')}</tbody></table></div>`
          : '<div class="muted">Sem campanhas ativas.</div>'}</div>`).join('')}</div></div>`;
}

/** Relatório mensal: comparativo mês a mês + link público somente leitura (staff). */
function reportPanel(box, id) {
  const staff = ['admin', 'manager'].includes(state.user.role);
  const month = new Date().toISOString().slice(0, 7);
  box.innerHTML = `<section class="panel" style="margin-bottom:16px"><h2 style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">Relatório do cliente
      <span style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap"><input type="month" id="rmonth" value="${month}" max="${month}" style="width:auto">
      ${staff ? '<select id="rdays" style="width:auto" aria-label="Validade do link"><option value="7">Link: 7 dias</option><option value="30" selected>Link: 30 dias</option><option value="90">Link: 90 dias</option></select><button class="btn primary" id="rlink">Gerar link público</button>' : ''}</span></h2>
    <div id="rout" class="muted" style="margin-top:8px"></div>${staff ? '<div id="rlinks" style="margin-top:10px"></div>' : ''}</section>`;
  const out = box.querySelector('#rout');
  const showLinks = async () => {
    if (!staff) return;
    const ls = await api(`/clients/${id}/report-links`).catch(() => []);
    box.querySelector('#rlinks').innerHTML = ls.length ? `<small class="muted">Links gerados:</small>` + ls.map((l) => {
      const live = !l.revoked_at && l.expires_at * 1000 > Date.now();
      return `<div class="kv"><span>${dateTime(l.created_at)} · ${live ? `expira ${dateTime(l.expires_at)}` : l.revoked_at ? 'revogado' : 'expirado'}</span>${live ? `<button class="btn" data-rev="${l.id}">Revogar</button>` : ''}</div>`;
    }).join('') : '';
  };
  const drawReport = async () => {
    out.innerHTML = '<div class="skeleton" style="min-height:120px"></div>';
    try {
      const r = await api(`/clients/${id}/report?month=${box.querySelector('#rmonth').value || month}`);
      out.innerHTML = `<div style="color:var(--text)">${reportHtml(r)}</div>`;
    } catch (e) { out.textContent = e.message; }
  };
  box.querySelector('#rmonth').onchange = drawReport;
  box.querySelector('#rlink')?.addEventListener('click', async () => {
    try {
      const r = await api(`/clients/${id}/report-links`, { method: 'POST', body: { days: +box.querySelector('#rdays').value } });
      const url = `${location.origin}${r.path}`;
      await navigator.clipboard?.writeText(url).catch(() => {});
      toast('Link copiado! Válido por ' + r.days + ' dias.', 'ok');
      box.querySelector('#rlinks').insertAdjacentHTML('afterbegin', `<div class="kv"><span class="mono" style="word-break:break-all">${esc(url)}</span><a class="btn" href="${esc(r.path)}" target="_blank" rel="noopener">Abrir</a></div>`);
      showLinks();
    } catch (e) { toast(e.message, 'err'); }
  });
  box.addEventListener('click', async (e) => {
    const rev = e.target.dataset?.rev; if (!rev) return;
    await api(`/report-links/${rev}`, { method: 'DELETE' }).catch((er) => toast(er.message, 'err'));
    showLinks();
  });
  showLinks();
  drawReport();
}

export default {
  title: 'Cliente',
  async render(root, [id]) {
    const draw = async () => {
      const qs = new URLSearchParams({ range: prefs.range, metric: prefs.metric });
      if (prefs.range === 'custom') { qs.set('from', prefs.from); qs.set('to', prefs.to); }
      let d;
      try { d = await api(`/clients/${id}/detail?${qs}`); } catch (e) { toast(e.message, 'err'); root.innerHTML = `<div class="empty panel">${esc(e.message)}</div>`; return; }
      const t = d.totals;
      const single = d.dates.length === 1;
      const chartDates = d.dates.length > 1 ? d.dates : d.dates; // período de 1 dia vira um único ponto/barra
      const seriesOf = (p, key) => p.series.map((x) => x[key]);
      const reachOnly = d.platforms.length > 0 && d.platforms.every((p) => p.metric === 'reach');

      root.innerHTML = `
        <div class="top"><a class="btn icon" href="#/monitor" aria-label="Voltar">${icon('back')}</a>
          <div><h1 style="color:var(--accent)">${esc(d.name)}</h1><div class="sub">Detalhamento por período e plataforma</div></div><div class="sp"></div>
          <select id="metric" style="width:auto" aria-label="Tipo"><option value="">Todos os tipos</option><option value="cpl">CPL</option><option value="cpa">CPA (Vendas)</option><option value="followers">Seguidores</option><option value="reach">Alcance</option></select></div>
        <div class="filters"><div class="seg" id="range">${RANGES.map(([v, l]) => `<button data-v="${v}" class="${prefs.range === v ? 'on' : ''}">${l}</button>`).join('')}</div>
          <span class="${prefs.range === 'custom' ? '' : 'hidden'}" id="custom" style="display:flex;gap:6px"><input type="date" id="from" value="${prefs.from}" style="width:auto"><input type="date" id="to" value="${prefs.to}" style="width:auto"></span></div>
        <div class="kpis">
          ${kpi('Investimento total', brl(t.spend), 'var(--ok)')}${kpi('Resultados', reachOnly ? '—' : num(t.results), 'var(--accent)')}
          ${kpi('Custo por resultado', t.cpr != null ? brl(t.cpr) : '—', 'var(--warn)')}${kpi('Alcance', int(t.reach), 'var(--accent2)')}
          ${kpi('Impressões', int(t.impressions), 'var(--accent)')}${kpi('Cliques', int(t.clicks), 'var(--ok)')}
          ${kpi('CTR', pct(t.ctr), 'var(--accent2)')}${kpi('CPC', t.cpc != null ? brl(t.cpc) : '—', 'var(--warn)')}${kpi('CPM', t.cpm != null ? brl(t.cpm) : '—', 'var(--ok)')}</div>
        ${d.platforms.length ? `<div class="grid cols-2" style="margin-bottom:16px;align-items:start">${d.platforms.map(platformBlock).join('')}</div>` : '<div class="empty panel">Nenhum canal para esse filtro.</div>'}
        <div id="rep" class="hide-print"></div>
        <div id="camps"><div class="panel" style="margin-bottom:16px"><h2>Campanhas ativas</h2><div class="skeleton" style="min-height:90px"></div></div></div>
        <div class="grid cols-2" style="margin-bottom:16px">
          <div class="panel"><h2>Investimento por dia</h2>${multiChart({ labels: chartDates, formats: [(v) => brl(v, 0).replace('R$ ', ''), (v) => v],
            series: d.platforms.map((p) => ({ name: `${PLAT[p.platform]} (R$)`, color: COLOR[p.platform], values: seriesOf(p, 'spend'), type: single ? 'bar' : 'line' })) })}</div>
          <div class="panel"><h2>Resultados por dia</h2>${multiChart({ labels: chartDates,
            series: d.platforms.filter((p) => p.metric !== 'reach').map((p) => ({ name: `${PLAT[p.platform]} (${RESULT_NAME[p.metric].toLowerCase()})`, color: COLOR[p.platform], values: seriesOf(p, 'conv'), type: 'bar' })) })}</div>
        </div>
        <div class="panel" style="margin-bottom:16px"><h2>Impressões e cliques por dia</h2>${multiChart({ labels: chartDates,
          series: [
            ...d.platforms.map((p) => ({ name: `${PLAT[p.platform]} impressões`, color: COLOR[p.platform], values: seriesOf(p, 'impressions'), type: 'bar', axis: 0 })),
            ...d.platforms.map((p) => ({ name: `${PLAT[p.platform]} cliques`, color: p.platform === 'google' ? '#ffd23f' : '#6fb0ff', values: seriesOf(p, 'clicks'), type: 'line', axis: 1 })),
          ] })}</div>
        ${d.platforms.filter((p) => d.dates.length > 1).map((p) => {
          const rch = p.metric === 'reach';
          const vals = p.series.map((x) => (rch ? x.reach : x.conv > 0 ? x.spend / x.conv : null));
          return `<div class="panel" style="margin-bottom:16px"><h2><span style="color:${COLOR[p.platform]}">${PLAT[p.platform]}</span> <span class="muted">· ${rch ? 'alcance diário' : 'custo por resultado'} vs. meta</span></h2>
            ${lineChart({ labels: d.dates, values: vals, color: COLOR[p.platform], target: p.target, format: rch ? (v) => int(v) : undefined })}</div>`;
        }).join('')}`;

      root.querySelector('#metric').value = prefs.metric;
      root.querySelector('#metric').onchange = (e) => { prefs.metric = e.target.value; draw(); };
      root.querySelector('#range').onclick = (e) => {
        const v = e.target.dataset?.v; if (!v) return;
        prefs.range = v;
        if (v === 'custom') { root.querySelectorAll('#range button').forEach((b) => b.classList.toggle('on', b.dataset.v === v)); root.querySelector('#custom').classList.remove('hidden'); } else draw();
      };
      for (const k of ['from', 'to']) root.querySelector(`#${k}`).onchange = (e) => { prefs[k] = e.target.value; if (prefs.from && prefs.to) draw(); };

      reportPanel(root.querySelector('#rep'), id);

      // campanhas ativas: consulta ao vivo, carrega depois do resto
      api(`/clients/${id}/campaigns?${qs}`).then((g) => {
        const box = root.querySelector('#camps');
        if (box) box.innerHTML = campaignsHtml(g.filter((x) => !prefs.metric || x.metric === prefs.metric));
      }).catch((e) => { const box = root.querySelector('#camps'); if (box) box.innerHTML = `<div class="panel" style="margin-bottom:16px;color:var(--crit)">${esc(e.message)}</div>`; });
    };
    root.innerHTML = '<div class="skeleton" style="min-height:400px"></div>';
    draw();
  },
};
