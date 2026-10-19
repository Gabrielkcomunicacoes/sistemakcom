import { reportHtml, liveHtml } from './js/report-view.js?v=3';
import { esc } from './js/core.js';

const token = location.pathname.split('/')[2];
const root = document.getElementById('report');
const $ = (id) => document.getElementById(id);
const [modeSel, picker, fromIn, toIn, dayIn] = ['mode', 'month', 'from', 'to', 'day'].map($);
const liveBox = $('live');
const dmy = (d) => d.split('-').reverse().join('/');
const today = new Date().toLocaleDateString('sv', { timeZone: 'America/Sao_Paulo' });
picker.max = today.slice(0, 7);
for (const el of [fromIn, toIn, dayIn]) el.max = today;
let range = null; // período do relatório

/** Query do período escolhido; null enquanto o preenchimento estiver incompleto/inválido. */
function periodQuery() {
  const mode = modeSel.value;
  if (mode === 'day') return dayIn.value ? `from=${dayIn.value}` : null;
  if (mode === 'range') return fromIn.value && toIn.value && fromIn.value <= toIn.value ? `from=${fromIn.value}&to=${toIn.value}` : null;
  return picker.value ? `month=${picker.value}` : '';
}

function syncMode() {
  $('rangeBox').classList.toggle('hidden', modeSel.value !== 'range');
  dayIn.classList.toggle('hidden', modeSel.value !== 'day');
  picker.classList.toggle('hidden', modeSel.value !== 'month');
}

async function loadLive(from, to, label) {
  liveBox.querySelector('.live-body').innerHTML = '<div class="skeleton" style="min-height:160px"></div>';
  const res = await fetch(`/r/${encodeURIComponent(token)}/live?from=${from}&to=${to}`);
  const data = await res.json().catch(() => ({}));
  liveBox.querySelector('.live-body').innerHTML = res.ok
    ? liveHtml(data, label)
    : `<div class="muted">${esc(data.error || 'Não foi possível carregar.')}</div>`;
}

function setupLive() {
  const single = range.from === range.to;
  const rangeLabel = single ? dmy(range.from) : `${dmy(range.from)} a ${dmy(range.to)}`;
  liveBox.innerHTML = `<div class="live-bar hide-print">
      ${single ? '' : `<label>Ver por dia <input type="date" id="liveday" min="${range.from}" max="${range.to}"></label>
      <button class="btn" id="whole" type="button">Período inteiro</button>`}</div><div class="live-body"></div>`;
  const day = liveBox.querySelector('#liveday');
  const whole = () => { if (day) day.value = ''; loadLive(range.from, range.to, rangeLabel); };
  if (day) {
    day.onchange = () => (day.value ? loadLive(day.value, day.value, dmy(day.value)) : whole());
    liveBox.querySelector('#whole').onclick = whole;
  }
  whole();
}

async function load() {
  const q = periodQuery();
  if (q === null) return; // período incompleto: espera o preenchimento
  root.innerHTML = '<div class="skeleton" style="min-height:300px"></div>';
  liveBox.innerHTML = '';
  const res = await fetch(`/r/${encodeURIComponent(token)}/data${q ? `?${q}` : ''}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { $('bar').classList.add('hidden'); liveBox.classList.add('hidden'); root.innerHTML = `<div class="empty panel">${esc(data.error || 'Relatório indisponível.')}</div>`; return; }
  if (modeSel.value === 'month' && !picker.value) picker.value = data.month;
  document.title = `${data.client} · ${data.label}`;
  root.innerHTML = reportHtml(data);
  range = data.range;
  setupLive();
}

modeSel.onchange = () => {
  // ao trocar de modo, parte do período já exibido
  if (range) { fromIn.value = range.from; toIn.value = range.to; dayIn.value = range.to; }
  syncMode();
  load();
};
for (const el of [picker, fromIn, toIn, dayIn]) el.onchange = load;
$('print').onclick = () => window.print();
syncMode();
load();
