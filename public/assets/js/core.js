/* Utilidades compartilhadas: API com CSRF, escape de HTML, formatação, ícones, toasts, modal. */
export const state = { user: null, csrf: '' };

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method, credentials: 'same-origin',
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), 'x-csrf-token': state.csrf },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { location.replace('/login'); throw new Error('Sessão expirada'); }
  if (!res.ok) {
    if (data.code === 'password_change_required') location.hash = '#/perfil';
    throw new Error(data.error || `Erro ${res.status}`);
  }
  return data;
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const brl = (n, d = 2) => (n == null ? '—' : `R$ ${Number(n).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d })}`);
export const num = (n) => (n == null ? '—' : Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 1 }));
export const dateTime = (ts) => (ts ? new Date(ts * 1000).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
export const ago = (ts) => {
  if (!ts) return 'nunca';
  const m = Math.round((Date.now() / 1000 - ts) / 60);
  return m < 1 ? 'agora' : m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
};

const ICONS = {
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.5 3-6 6.5-6s6.5 2.5 6.5 6M17 4.5a3.5 3.5 0 010 7M21.5 20c0-2.6-1.6-4.7-4-5.6"/>',
  briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2M3 13h18"/>',
  bell: '<path d="M6 9a6 6 0 1112 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9zM10 20a2 2 0 004 0"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.5-7 8-7s8 3 8 7"/>',
  logout: '<path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/>',
  refresh: '<path d="M21 12a9 9 0 01-15.5 6.2L3 16M3 12A9 9 0 0118.5 5.8L21 8M21 3v5h-5M3 21v-5h5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  tv: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 13A9 9 0 1111 3a7 7 0 0010 10z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>',
  trash: '<path d="M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  alert: '<path d="M12 3l10 18H2zM12 10v5M12 18h.01"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
};
export const icon = (name) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;

export function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), 4200);
}

/** Modal genérico. `html` já deve estar escapado. Retorna o elemento e uma função close(). */
export function modal(html) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  const close = () => bg.remove();
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
  bg.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  document.body.append(bg);
  bg.querySelector('input, select, button')?.focus();
  return { el: bg.firstElementChild, close };
}

export function confirmBox(message, okLabel = 'Confirmar') {
  return new Promise((resolve) => {
    const { el, close } = modal(`<h2>${esc(message)}</h2>
      <div class="actions"><button class="btn" data-x>Cancelar</button><button class="btn danger" data-ok>${esc(okLabel)}</button></div>`);
    el.querySelector('[data-x]').onclick = () => { close(); resolve(false); };
    el.querySelector('[data-ok]').onclick = () => { close(); resolve(true); };
  });
}

export const METRIC = { cpl: 'CPL', cpa: 'CPA', followers: 'SEGUIDORES', reach: 'ALCANCE' };
export const RESULT_NAME = { cpl: 'Leads', cpa: 'Vendas', followers: 'Seguidores', reach: 'Alcance' };
export const initials = (n) => String(n).split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
export const ROLES = { admin: 'Administrador', manager: 'Gestor', viewer: 'Visualização', tv: 'TV' };
