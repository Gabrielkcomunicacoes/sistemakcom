import { api, esc, brl, num, icon, ago, toast, state, METRIC } from '../core.js';
import { sparkline } from '../charts.js';

const STATUS = { critical: 'Crítico', warning: 'Atenção', ok: 'Saudável', idle: 'Sem dados' };
const PLAT = { google: 'Google Ads', meta: 'Meta Ads' };
const RANK = { critical: 0, warning: 1, ok: 2, idle: 3 };
const RANGES = [['today', 'Hoje'], ['yesterday', 'Ontem'], ['7', '7 dias'], ['14', '14 dias'], ['30', '30 dias'], ['custom', 'Personalizado']];

const prefs = { range: 'today', from: '', to: '', google: false, meta: false, status: '', metric: '', q: '', mine: false };
let timer, data, tvPage = 0, tvPages = 1, lastKey = '';
const lastKpi = {};
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Anima o número do valor anterior até o novo (ease-out); sem animação se o usuário preferir menos movimento. */
function countUp(el, to, fmt, from = 0) {
  if (to == null || reduceMotion() || from === to) { el.textContent = fmt(to); return; }
  const t0 = performance.now(), dur = 700;
  const step = (now) => {
    const p = Math.min(1, (now - t0) / dur), e = 1 - (1 - p) ** 3;
    el.textContent = fmt(from + (to - from) * e);
    if (p < 1 && el.isConnected) requestAnimationFrame(step); else el.textContent = fmt(to);
  };
  requestAnimationFrame(step);
}

function trend(v, higherBetter) {
  if (v == null) return '<span class="trend">—</span>';
  const bad = higherBetter ? v < 0 : v > 0;
  return `<span class="trend ${bad ? 'up' : 'down'}">${v > 0 ? '▲' : '▼'} ${Math.abs(v)}%</span>`;
}

function channelHtml(ch) {
  const reach = ch.metric === 'reach';
  const pct = ch.target > 0 && ch.cpr != null ? Math.min(100, (ch.cpr / ch.target) * 100) : 0;
  const big = reach ? `${Math.round(ch.cpr ?? 0).toLocaleString('pt-BR')}<small class="unit">/dia</small>` : (ch.cpr != null ? brl(ch.cpr) : '—');
  const days = ch.daysLeft != null ? `<span class="badge ${ch.daysLeft < 1.5 ? 'critical' : ch.daysLeft < 4 ? 'warning' : 'ok'}">≈ ${num(ch.daysLeft)} d de saldo</span>` : '';
  return `<div class="ch">
    <div class="ch-top"><span class="plat ${ch.platform}">${PLAT[ch.platform]}</span><span class="metric">// ${METRIC[ch.metric]}</span>
      <span class="ml badge ${ch.status}">${STATUS[ch.status]}</span></div>
    <div class="ch-main">
      <div><div class="big">${big}</div></div>
      <div class="side-info">meta <b>${reach ? `${ch.target.toLocaleString('pt-BR')}/dia` : brl(ch.target)}</b><br>hoje <b>${num(ch.todayConv)}</b> ${reach ? 'alcance' : 'conv.'}</div>
    </div>
    <div class="bar" title="Custo em relação à meta"><i style="width:${pct}%"></i></div>
    <div class="foot"><span>Gasto <b>${brl(ch.spend)}</b></span><span>${reach ? 'Alcance' : 'Conv.'} <b>${num(ch.conversions)}</b></span>
      ${ch.funding === 'card' || ch.funding === 'auto' ? `<span class="badge" title="Pagamento automático: sem recarga manual">${ch.funding === 'card' ? '💳 Cartão automático' : 'Pagamento automático'}</span>` : `<span>Saldo <b>${ch.balance != null ? brl(ch.balance) : '—'}</b></span>${days}`}</div>
    <div class="foot"><div class="trends" title="Variação do custo vs. meta">
      <span class="muted">7D</span>${trend(ch.trends[7], reach)}<span class="muted">14D</span>${trend(ch.trends[14], reach)}<span class="muted">30D</span>${trend(ch.trends[30], reach)}</div>
      ${sparkline(ch.spark, ch.platform === 'google' ? 'var(--google)' : 'var(--meta)')}</div>
    ${ch.error ? `<div class="foot" style="color:var(--warn)">⚠ ${esc(ch.error)}</div>` : ''}
  </div>`;
}

const dm = (d) => d.slice(8) + '/' + d.slice(5, 7);

/** Previsões: fechamento do mês vs. verba e data em que cada saldo zera. */
function forecastHtml(c) {
  const parts = [];
  if (c.projectedPct != null && c.dayOfMonth >= 3) {
    const cls = c.projectedPct > 105 ? 'bad' : c.projectedPct < 80 ? 'warn' : '';
    parts.push(`<span title="Gasto até hoje + ritmo dos últimos 7 dias">Fechamento <b class="${cls}">${brl(c.projectedSpend, 0)} (${c.projectedPct}%)</b></span>`);
  }
  for (const ch of c.channels) {
    if (ch.depletionDate && ch.daysLeft < 7) parts.push(`<span>${PLAT[ch.platform]} ${ch.daysLeft <= 0.05 ? '<b class="bad">sem saldo</b>' : `zera <b class="${ch.daysLeft < 3 ? 'bad' : 'warn'}">${dm(ch.depletionDate)}</b>`}</span>`);
  }
  return parts.length ? `<div class="fc">${parts.join('')}</div>` : '';
}

function cardHtml(c) {
  const pace = c.pacing != null ? `<div class="pace"><span>Verba do mês</span><div class="bar"><i class="${c.pacing > 100 ? 'critical' : c.pacing > 85 ? 'warning' : ''}" style="width:${Math.min(c.pacing, 100)}%"></i></div><b>${c.pacing}%</b></div>` : '';
  return `<article class="card ${c.status}" data-id="${c.id}" tabindex="0" role="link" aria-label="Abrir ${esc(c.name)}">
    <header><h3>${esc(c.name)}</h3>${c.manager ? `<span class="mgr">${esc(c.manager)}</span>` : ''}<span class="badge ${c.status}"><i class="dot"></i>${STATUS[c.status]}</span></header>
    ${c.channels.map(channelHtml).join('')}${pace}${forecastHtml(c)}</article>`;
}

function filtered() {
  const q = prefs.q.trim().toLowerCase();
  return data.clients
    .map((c) => ({ ...c, channels: c.channels.filter((ch) => (!(prefs.google || prefs.meta) || prefs[ch.platform]) && (!prefs.metric || ch.metric === prefs.metric)) }))
    .filter((c) => c.channels.length
      && (!q || c.name.toLowerCase().includes(q))
      && (!prefs.status || c.status === prefs.status)
      && (!prefs.mine || c.manager_id === state.user.id))
    .sort((a, b) => RANK[a.status] - RANK[b.status] || a.name.localeCompare(b.name));
}

function paint(root) {
  const t = data.totals;
  root.querySelector('#kpis').innerHTML = `
    <div class="kpi" style="--k:var(--accent);--i:0"><small>Investimento · ${esc(data.range)}</small><strong data-k="spend"></strong></div>
    <div class="kpi" style="--k:var(--ok);--i:1"><small>Conversões</small><strong data-k="conv"></strong></div>
    <div class="kpi" style="--k:var(--accent2);--i:2"><small>Custo por resultado</small><strong data-k="cpr"></strong></div>
    <div class="kpi" style="--k:var(--crit);--i:3"><small>Clientes críticos</small><strong data-k="crit"></strong><em>${t.warning} em atenção</em></div>
    <div class="kpi" style="--k:var(--ok);--i:4"><small>Saudáveis</small><strong data-k="ok"></strong><em>de ${data.clients.length}</em></div>`;
  const kv = { spend: [t.spend, brl], conv: [t.conversions, num], cpr: [t.cpr, brl], crit: [t.critical, (v) => String(Math.round(v))], ok: [t.ok, (v) => String(Math.round(v))] };
  for (const [k, [v, fmt]] of Object.entries(kv)) { countUp(root.querySelector(`[data-k="${k}"]`), v, fmt, lastKpi[k] ?? 0); lastKpi[k] = v ?? 0; }
  let list = filtered();
  const tv = document.body.classList.contains('tv');
  if (tv) {
    // grade que cabe inteira na tela: ~300px por coluna e ~220px por linha (cards compactos)
    const cols = Math.min(8, Math.max(3, Math.floor(innerWidth / 300)));
    const rows = Math.max(2, Math.floor((innerHeight - 130) / 220));
    const cardsEl = root.querySelector('#cards');
    cardsEl.style.setProperty('--tvc', cols); cardsEl.style.setProperty('--tvr', rows);
    const per = cols * rows;
    const pages = Math.max(1, Math.ceil(list.length / per));
    tvPage = Math.min(Math.max(tvPage, 0), pages - 1);
    tvPages = pages;
    list = list.slice(tvPage * per, tvPage * per + per);
    root.querySelector('#tvinfo').textContent = pages > 1 ? `Página ${tvPage + 1}/${pages}` : '';
  }
  for (const id of ['tvprev', 'tvnext']) root.querySelector('#' + id).classList.toggle('hidden', !(tv && tvPages > 1));
  // a animação de entrada só toca quando a lista de cards muda (filtro, página); a atualização de 60 s não reanima
  const key = list.map((c) => c.id).join(',') + '|' + tvPage;
  const cardsEl2 = root.querySelector('#cards');
  cardsEl2.classList.toggle('enter', key !== lastKey); lastKey = key;
  cardsEl2.innerHTML = list.length ? list.map((c, i) => cardHtml(c).replace('<article class="card', `<article style="--i:${Math.min(i, 24)}" class="card`)).join('') : '<div class="empty" style="grid-column:1/-1">Nenhum cliente encontrado com esses filtros.</div>';
  root.querySelector('#upd').innerHTML = `${icon('refresh')} atualizado ${ago(Math.floor(data.generatedAt / 1000))}`;
}

async function load(root, quiet) {
  const qs = new URLSearchParams({ range: prefs.range });
  if (prefs.range === 'custom') { qs.set('from', prefs.from); qs.set('to', prefs.to); }
  try {
    data = await api(`/dashboard?${qs}`);
    paint(root);
  } catch (e) { if (!quiet) toast(e.message, 'err'); }
}

function setTv(root, on) {
  document.body.classList.toggle('tv', on);
  tvPage = 0; // o modo TV sempre começa (e fica) na primeira página; a troca é manual
  if (on) document.documentElement.requestFullscreen?.().catch(() => {});
  else if (document.fullscreenElement) document.exitFullscreen?.();
  root.querySelector('#tvexit').classList.toggle('hidden', !on);
  if (data) paint(root);
}

export default {
  title: 'Monitoramento',
  render(root) {
    const canSync = ['admin', 'manager'].includes(state.user.role);
    root.innerHTML = `
      <div class="top"><div><h1>Monitoramento <span class="updated" id="upd"></span></h1><div class="sub">Saldos, custo por resultado e alertas em tempo real <span id="tvinfo"></span></div></div><div class="sp"></div>
        <div class="hide-tv" style="display:flex;gap:8px">
          ${canSync ? `<button class="btn" id="sync">${icon('refresh')} Sincronizar</button>` : ''}
          <button class="btn primary" id="tv">${icon('tv')} Modo TV</button></div></div>
      <div class="kpis" id="kpis">${'<div class="skeleton" style="min-height:84px"></div>'.repeat(5)}</div>
      <div class="filters">
        <div class="seg" id="range">${RANGES.map(([v, l]) => `<button data-v="${v}" class="${prefs.range === v ? 'on' : ''}">${l}</button>`).join('')}</div>
        <span id="custom" class="${prefs.range === 'custom' ? '' : 'hidden'}" style="display:flex;gap:6px"><input type="date" id="from" value="${prefs.from}" style="width:auto"><input type="date" id="to" value="${prefs.to}" style="width:auto"></span>
        <div class="search">${icon('search')}<input id="q" placeholder="Buscar cliente…" value="${esc(prefs.q)}" aria-label="Buscar cliente"></div>
        <label class="check" style="padding:7px 12px" title="Sem nenhuma marcada, mostra Google e Meta"><input type="checkbox" id="pgoogle" ${prefs.google ? 'checked' : ''}> Google Ads</label>
        <label class="check" style="padding:7px 12px" title="Sem nenhuma marcada, mostra Google e Meta"><input type="checkbox" id="pmeta" ${prefs.meta ? 'checked' : ''}> Meta Ads</label>
        <select id="metric" aria-label="Tipo"><option value="">Todos os tipos</option><option value="cpl">CPL</option><option value="cpa">CPA (Vendas)</option><option value="followers">Seguidores</option><option value="reach">Alcance</option></select>
        <select id="status" aria-label="Status"><option value="">Todos os status</option><option value="critical">Crítico</option><option value="warning">Atenção</option><option value="ok">Saudável</option></select>
        <label class="check" style="padding:7px 12px"><input type="checkbox" id="mine" ${prefs.mine ? 'checked' : ''}> Meus clientes</label>
      </div>
      <div class="cards" id="cards">${'<div class="skeleton"></div>'.repeat(6)}</div>
      <button class="tv-nav prev hidden" id="tvprev" aria-label="Página anterior">‹</button>
      <button class="tv-nav next hidden" id="tvnext" aria-label="Próxima página">›</button>
      <button class="btn primary tv-exit hidden" id="tvexit">${icon('x')} Sair do modo TV</button>`;

    root.querySelector('#status').value = prefs.status;
    root.querySelector('#metric').value = prefs.metric;
    const repaint = () => data && paint(root);

    root.querySelector('#range').onclick = (e) => {
      const v = e.target.dataset?.v; if (!v) return;
      prefs.range = v;
      root.querySelectorAll('#range button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
      root.querySelector('#custom').classList.toggle('hidden', v !== 'custom');
      if (v !== 'custom') load(root);
    };
    for (const id of ['from', 'to']) root.querySelector(`#${id}`).onchange = (e) => { prefs[id] = e.target.value; if (prefs.from && prefs.to) load(root); };
    root.querySelector('#q').oninput = (e) => { prefs.q = e.target.value; repaint(); };
    root.querySelector('#pgoogle').onchange = (e) => { prefs.google = e.target.checked; repaint(); };
    root.querySelector('#pmeta').onchange = (e) => { prefs.meta = e.target.checked; repaint(); };
    root.querySelector('#metric').onchange = (e) => { prefs.metric = e.target.value; repaint(); };
    root.querySelector('#status').onchange = (e) => { prefs.status = e.target.value; repaint(); };
    root.querySelector('#mine').onchange = (e) => { prefs.mine = e.target.checked; repaint(); };
    const open = (e) => { const c = e.target.closest('.card'); if (c) location.hash = `#/cliente/${c.dataset.id}`; };
    root.querySelector('#cards').onclick = open;
    root.querySelector('#cards').onkeydown = (e) => { if (e.key === 'Enter') open(e); };
    root.querySelector('#tv').onclick = () => setTv(root, true);
    root.querySelector('#tvexit').onclick = () => setTv(root, false);
    const go = (d) => { tvPage = (tvPage + d + tvPages) % tvPages; paint(root); };
    root.querySelector('#tvprev').onclick = () => go(-1);
    root.querySelector('#tvnext').onclick = () => go(1);
    document.addEventListener('keydown', this._kd = (e) => {
      if (!document.body.classList.contains('tv')) return;
      if (e.key === 'ArrowLeft') go(-1); else if (e.key === 'ArrowRight') go(1);
    });
    root.querySelector('#sync')?.addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try {
        const r = await api('/sync', { method: 'POST' });
        toast(r.skipped ? 'Sincronização já em andamento.' : `Sincronizado: ${r.ok} ok · ${r.failed} falhas · ${r.skipped} sem ID real`, r.failed ? 'err' : 'ok');
        await load(root);
      } catch (err) { toast(err.message, 'err'); } finally { e.currentTarget.disabled = false; }
    });
    document.addEventListener('fullscreenchange', this._fs = () => { if (!document.fullscreenElement && document.body.classList.contains('tv')) setTv(root, false); });

    load(root);
    timer = setInterval(() => load(root, true), 60000);
  },
  destroy() {
    clearInterval(timer);
    document.body.classList.remove('tv');
    if (this._fs) document.removeEventListener('fullscreenchange', this._fs);
    if (this._kd) document.removeEventListener('keydown', this._kd);
  },
};
