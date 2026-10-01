import { api, state, esc, icon, initials, ROLES, toast } from './core.js';
import monitor from './pages/monitor.js';
import client from './pages/client.js';
import alerts from './pages/alerts.js';
import clients from './pages/clients.js';
import users from './pages/users.js';
import settings from './pages/settings.js';
import profile from './pages/profile.js';

const ROUTES = {
  monitor: { page: monitor, roles: null },
  cliente: { page: client, roles: null },
  alertas: { page: alerts, roles: null },
  clientes: { page: clients, roles: ['admin', 'manager'] },
  usuarios: { page: users, roles: ['admin'] },
  config: { page: settings, roles: ['admin'] },
  perfil: { page: profile, roles: null },
};

const view = document.getElementById('view');
let current;

function nav(openAlerts = 0) {
  const r = state.user.role;
  const item = (id, ic, label, extra = '') => `<a class="nav" data-r="${id}" href="#/${id}">${icon(ic)}<span>${label}</span>${extra}</a>`;
  document.getElementById('side').innerHTML = `
    <div class="brand"><img class="logo" src="/images/logo-branca.png" alt="KCOM" width="110" height="45"><small>Monitor de saldos</small></div>
    ${item('monitor', 'monitor', 'Monitoramento')}
    ${r === 'tv' ? '' : item('alertas', 'bell', 'Alertas', openAlerts ? `<span class="badge critical">${openAlerts}</span>` : '')}
    ${['admin', 'manager'].includes(r) ? `<div class="sep">Gestão</div>${item('clientes', 'briefcase', 'Clientes')}` : ''}
    ${r === 'admin' ? `${item('usuarios', 'users', 'Usuários e auditoria')}${item('config', 'key', 'Chaves e integrações')}` : ''}
    <div class="grow"></div>
    <a class="userbox nav" href="#/perfil" style="padding:10px"><div class="avatar">${esc(initials(state.user.name))}</div>
      <div class="who"><b>${esc(state.user.name)}</b><small>${ROLES[r]}</small></div></a>
    <button class="nav" id="logout">${icon('logout')}<span>Sair</span></button>`;
  document.getElementById('logout').onclick = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    location.replace('/login');
  };
}

function mark(id) {
  document.querySelectorAll('.nav[data-r]').forEach((a) => a.classList.toggle('on', a.dataset.r === id || (id === 'cliente' && a.dataset.r === 'monitor')));
}

async function route() {
  const [id = 'monitor', ...args] = location.hash.replace(/^#\//, '').split('/');
  let def = ROUTES[id] ?? ROUTES.monitor;
  let key = ROUTES[id] ? id : 'monitor';
  if (state.user.must_change) { def = ROUTES.perfil; key = 'perfil'; }
  if (def.roles && !def.roles.includes(state.user.role)) { def = ROUTES.monitor; key = 'monitor'; }
  current?.page.destroy?.();
  document.body.classList.remove('menu');
  document.title = `${def.page.title} · KCOM Monitor`;
  mark(key);
  current = def;
  view.innerHTML = '';
  await def.page.render(view, args);
}

async function boot() {
  try {
    const me = await api('/auth/me');
    state.user = me.user; state.csrf = me.csrf;
  } catch { return; }
  document.getElementById('burger').innerHTML = icon('menu');
  document.getElementById('burger').onclick = () => document.body.classList.toggle('menu');
  nav();
  if (state.user.role !== 'tv' && !state.user.must_change) {
    api('/dashboard?range=today').then((d) => nav(d.openAlerts)).then(() => mark(location.hash.split('/')[1] || 'monitor')).catch(() => {});
  }
  addEventListener('hashchange', route);
  route();
}

boot().catch((e) => toast(e.message, 'err'));
