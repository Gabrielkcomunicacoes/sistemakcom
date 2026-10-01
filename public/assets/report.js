import { reportHtml } from './js/report-view.js';
import { esc } from './js/core.js';

const token = location.pathname.split('/')[2];
const root = document.getElementById('report');
const picker = document.getElementById('month');
picker.max = new Date().toISOString().slice(0, 7);

async function load() {
  root.innerHTML = '<div class="skeleton" style="min-height:300px"></div>';
  const res = await fetch(`/r/${encodeURIComponent(token)}/data${picker.value ? `?month=${picker.value}` : ''}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { document.getElementById('bar').classList.add('hidden'); root.innerHTML = `<div class="empty panel">${esc(data.error || 'Relatório indisponível.')}</div>`; return; }
  if (!picker.value) picker.value = data.month;
  document.title = `${data.client} · ${data.label}`;
  root.innerHTML = reportHtml(data);
}

picker.onchange = load;
document.getElementById('print').onclick = () => window.print();
load();
