import { reportHtml, liveHtml } from './js/report-view.js';
import { esc } from './js/core.js';

const token = location.pathname.split('/')[2];
const root = document.getElementById('report');
const picker = document.getElementById('month');
const liveBox = document.getElementById('live');
const dmy = (d) => d.split('-').reverse().join('/');
const today = new Date().toLocaleDateString('sv', { timeZone: 'America/Sao_Paulo' });
picker.max = today.slice(0, 7);
let range = null; // período do relatório (mês)

async function loadLive(from, to, label) {
  liveBox.querySelector('.live-body').innerHTML = '<div class="skeleton" style="min-height:160px"></div>';
  const res = await fetch(`/r/${encodeURIComponent(token)}/live?from=${from}&to=${to}`);
  const data = await res.json().catch(() => ({}));
  liveBox.querySelector('.live-body').innerHTML = res.ok
    ? liveHtml(data, label)
    : `<div class="muted">${esc(data.error || 'Não foi possível carregar.')}</div>`;
}

function setupLive() {
  liveBox.innerHTML = `<div class="live-bar hide-print">
      <label>Ver por dia <input type="date" id="day" min="${range.from}" max="${range.to}"></label>
      <button class="btn" id="whole" type="button">Mês inteiro</button></div><div class="live-body"></div>`;
  const day = liveBox.querySelector('#day');
  const whole = () => { day.value = ''; loadLive(range.from, range.to, range.from === range.to ? dmy(range.from) : `${dmy(range.from)} a ${dmy(range.to)}`); };
  day.onchange = () => (day.value ? loadLive(day.value, day.value, dmy(day.value)) : whole());
  liveBox.querySelector('#whole').onclick = whole;
  whole();
}

async function load() {
  root.innerHTML = '<div class="skeleton" style="min-height:300px"></div>';
  liveBox.innerHTML = '';
  const res = await fetch(`/r/${encodeURIComponent(token)}/data${picker.value ? `?month=${picker.value}` : ''}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { document.getElementById('bar').classList.add('hidden'); liveBox.classList.add('hidden'); root.innerHTML = `<div class="empty panel">${esc(data.error || 'Relatório indisponível.')}</div>`; return; }
  if (!picker.value) picker.value = data.month;
  document.title = `${data.client} · ${data.label}`;
  root.innerHTML = reportHtml(data);
  range = data.range;
  setupLive();
}

picker.onchange = load;
document.getElementById('print').onclick = () => window.print();
load();
