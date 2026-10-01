import { Router } from 'express';
import { get, all, run, tx, audit } from '../db.js';
import { requireRole } from '../session.js';
import { buildDashboard, clientSeries, clientDetail, resolveRange } from '../metrics.js';
import { publicSettings, setSetting, SETTING_DEFS } from '../settings.js';
import { syncAll, isSyncing, fetchCampaigns } from '../sync.js';
import { evaluateAlerts, openAlertCount } from '../alerts.js';
import { hashPassword, passwordProblem, randomToken, sha256 } from '../security.js';
import { monthReport, linksOf, isMonth } from '../report.js';
import { todayBR } from '../metrics.js';

const METRICS = ['cpl', 'cpa', 'followers', 'reach'];
const PAY_MODES = ['detect', 'card', 'manual'];
const RESULT_TYPES = ['auto', 'lead', 'message', 'purchase', 'click', 'lpv'];
const r = Router();
const staff = requireRole('admin', 'manager');
const admin = requireRole('admin');
const asInt = (v) => (/^\d{1,9}$/.test(String(v)) ? +v : null);
const fail = (res, msg, code = 400) => res.status(code).json({ error: msg });

/* ------------------------------ Dashboard ------------------------------ */
r.get('/dashboard', (req, res) => {
  const range = resolveRange(req.query.range, req.query.from, req.query.to);
  res.json({ ...buildDashboard(range), range: range.label, syncing: isSyncing(), openAlerts: openAlertCount() });
});

r.get('/clients/:id/series', (req, res) => {
  const id = asInt(req.params.id);
  const days = [7, 14, 30].includes(+req.query.days) ? +req.query.days : 30;
  if (!id || !get('SELECT 1 FROM clients WHERE id = ?', id)) return fail(res, 'Cliente não encontrado.', 404);
  res.json({ channels: clientSeries(id, days) });
});

r.get('/clients/:id/detail', (req, res) => {
  const id = asInt(req.params.id);
  if (!id || !get('SELECT 1 FROM clients WHERE id = ?', id)) return fail(res, 'Cliente não encontrado.', 404);
  const range = resolveRange(req.query.range, req.query.from, req.query.to);
  const metric = METRICS.includes(req.query.metric) ? req.query.metric : '';
  res.json({ ...clientDetail(id, range, metric), range: range.label });
});

// consulta ao vivo nas APIs; erro de uma plataforma não derruba a outra
r.get('/clients/:id/campaigns', async (req, res) => {
  const id = asInt(req.params.id);
  if (!id || !get('SELECT 1 FROM clients WHERE id = ?', id)) return fail(res, 'Cliente não encontrado.', 404);
  const range = resolveRange(req.query.range, req.query.from, req.query.to);
  const chs = all('SELECT * FROM channels WHERE client_id = ? AND active = 1 ORDER BY platform', id);
  res.json(await Promise.all(chs.map(async (ch) => {
    try { return { platform: ch.platform, metric: ch.metric, campaigns: await fetchCampaigns(ch, range.from, range.to) }; }
    catch (e) { return { platform: ch.platform, metric: ch.metric, campaigns: [], error: String(e.message).slice(0, 300) }; }
  })));
});

/* ------------------------------ Relatórios ------------------------------ */
const monthParam = (q) => (isMonth(q) ? q : todayBR().slice(0, 7));

r.get('/clients/:id/report', (req, res) => {
  const id = asInt(req.params.id);
  if (!id || !get('SELECT 1 FROM clients WHERE id = ?', id)) return fail(res, 'Cliente não encontrado.', 404);
  res.json(monthReport(id, monthParam(req.query.month)));
});

r.get('/clients/:id/report-links', staff, (req, res) => {
  const id = asInt(req.params.id);
  if (!id) return fail(res, 'Cliente inválido.');
  res.json(linksOf(id));
});

// o link só é exibido na criação (guardamos apenas o hash)
r.post('/clients/:id/report-links', staff, (req, res) => {
  const id = asInt(req.params.id);
  if (!id || !get('SELECT 1 FROM clients WHERE id = ?', id)) return fail(res, 'Cliente não encontrado.', 404);
  const days = Math.min(365, Math.max(1, asInt(req.body?.days) ?? 30));
  const token = randomToken(24);
  run('INSERT INTO report_links (client_id, token_hash, created_by, expires_at) VALUES (?,?,?,unixepoch() + ?)',
    id, sha256(token), req.user.id, days * 86400);
  audit(req, 'report_link_create', `cliente ${id}, ${days} dias`);
  res.status(201).json({ path: `/r/${token}`, days });
});

r.delete('/report-links/:id', staff, (req, res) => {
  const id = asInt(req.params.id);
  if (!id) return fail(res, 'Link inválido.');
  run('UPDATE report_links SET revoked_at = unixepoch() WHERE id = ? AND revoked_at IS NULL', id);
  audit(req, 'report_link_revoke', String(id));
  res.json({ ok: true });
});

r.post('/sync', staff, async (req, res) => {
  audit(req, 'sync_manual');
  res.json(await syncAll());
});

/* ------------------------------ Alertas ------------------------------ */
r.get('/alerts', (req, res) => {
  const status = req.query.status === 'history' ? 'a.resolved_at IS NOT NULL' : 'a.resolved_at IS NULL';
  res.json(all(
    `SELECT a.id, a.type, a.severity, a.message, a.created_at, a.resolved_at, a.ack_at, ch.platform, c.id client_id, c.name client
       FROM alerts a JOIN channels ch ON ch.id = a.channel_id JOIN clients c ON c.id = ch.client_id
      WHERE ${status}
      ORDER BY CASE a.severity WHEN 'critical' THEN 0 ELSE 1 END, a.created_at DESC LIMIT 200`,
  ));
});

r.post('/alerts/:id/ack', staff, (req, res) => {
  const id = asInt(req.params.id);
  if (!id) return fail(res, 'Alerta inválido.');
  run('UPDATE alerts SET ack_by = ?, ack_at = unixepoch() WHERE id = ? AND ack_at IS NULL', req.user.id, id);
  res.json({ ok: true });
});

/* ------------------------------ Clientes ------------------------------ */
function listClients() {
  const clients = all(
    `SELECT c.id, c.name, c.manager_id, c.monthly_budget, c.notes, c.active, u.name manager
       FROM clients c LEFT JOIN users u ON u.id = c.manager_id ORDER BY c.name COLLATE NOCASE`,
  );
  const chs = all('SELECT id, client_id, platform, account_id, metric, result_type, pay_mode, target, active FROM channels');
  return clients.map((c) => ({ ...c, channels: chs.filter((x) => x.client_id === c.id) }));
}

function validateClient(body) {
  const name = String(body?.name ?? '').trim().toLocaleUpperCase('pt-BR');
  if (name.length < 2 || name.length > 80) return { error: 'Nome deve ter entre 2 e 80 caracteres.' };
  const manager_id = body.manager_id ? asInt(body.manager_id) : null;
  if (body.manager_id && !get('SELECT 1 FROM users WHERE id = ? AND active = 1', manager_id)) return { error: 'Responsável inválido.' };
  const budget = body.monthly_budget === '' || body.monthly_budget == null ? null : Number(body.monthly_budget);
  if (budget != null && (!Number.isFinite(budget) || budget < 0 || budget > 1e8)) return { error: 'Orçamento mensal inválido.' };
  const notes = String(body.notes ?? '').slice(0, 500);
  const seen = new Set();
  const channels = [];
  for (const c of Array.isArray(body.channels) ? body.channels : []) {
    if (!['google', 'meta'].includes(c.platform) || seen.has(c.platform)) return { error: 'Canal inválido ou duplicado.' };
    seen.add(c.platform);
    const account_id = String(c.account_id ?? '').trim();
    if (!/^[A-Za-z0-9_-]{0,32}$/.test(account_id)) return { error: `ID da conta ${c.platform} inválido.` };
    if (c.platform === 'google' && ['followers', 'reach'].includes(c.metric)) return { error: 'Seguidores e Alcance só existem no Meta Ads.' };
    const target = Number(c.target);
    if (!Number.isFinite(target) || target < 0 || target > 1e6) return { error: 'Meta inválida.' };
    channels.push({ platform: c.platform, account_id, metric: METRICS.includes(c.metric) ? c.metric : 'cpl', result_type: RESULT_TYPES.includes(c.result_type) ? c.result_type : 'auto', pay_mode: PAY_MODES.includes(c.pay_mode) ? c.pay_mode : 'detect', target, active: c.active === false ? 0 : 1 });
  }
  if (!channels.length) return { error: 'Ative pelo menos um canal (Google ou Meta).' };
  return { name, manager_id, budget, notes, channels };
}

function saveChannels(clientId, channels) {
  const keep = channels.map((c) => c.platform);
  run(`DELETE FROM channels WHERE client_id = ? AND platform NOT IN (${keep.map(() => '?').join(',')})`, clientId, ...keep);
  for (const c of channels) {
    run(`INSERT INTO channels (client_id, platform, account_id, metric, result_type, pay_mode, target, active) VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(client_id, platform) DO UPDATE SET account_id=excluded.account_id, metric=excluded.metric, result_type=excluded.result_type, pay_mode=excluded.pay_mode, target=excluded.target, active=excluded.active`,
    clientId, c.platform, c.account_id, c.metric, c.result_type, c.pay_mode, c.target, c.active);
  }
}

r.get('/clients', (_req, res) => res.json(listClients()));

r.post('/clients', staff, (req, res) => {
  const v = validateClient(req.body);
  if (v.error) return fail(res, v.error);
  const id = tx(() => {
    const { id } = run('INSERT INTO clients (name, manager_id, monthly_budget, notes) VALUES (?,?,?,?)', v.name, v.manager_id, v.budget, v.notes);
    saveChannels(id, v.channels);
    return id;
  });
  audit(req, 'client_create', `${id} ${v.name}`);
  res.status(201).json({ id });
  syncAll().catch(() => {}); // já busca os dados do novo cliente
});

r.put('/clients/:id', staff, (req, res) => {
  const id = asInt(req.params.id);
  if (!id || !get('SELECT 1 FROM clients WHERE id = ?', id)) return fail(res, 'Cliente não encontrado.', 404);
  const v = validateClient(req.body);
  if (v.error) return fail(res, v.error);
  tx(() => {
    run('UPDATE clients SET name=?, manager_id=?, monthly_budget=?, notes=?, active=? WHERE id=?',
      v.name, v.manager_id, v.budget, v.notes, req.body.active === false ? 0 : 1, id);
    saveChannels(id, v.channels);
  });
  audit(req, 'client_update', `${id} ${v.name}`);
  res.json({ ok: true });
  syncAll().catch(() => {}); // recalcula com a métrica/conta novas
});

r.delete('/clients/:id', admin, (req, res) => {
  const id = asInt(req.params.id);
  const c = id && get('SELECT name FROM clients WHERE id = ?', id);
  if (!c) return fail(res, 'Cliente não encontrado.', 404);
  run('DELETE FROM clients WHERE id = ?', id);
  audit(req, 'client_delete', `${id} ${c.name}`);
  res.json({ ok: true });
});

/* ------------------------------ Usuários ------------------------------ */
r.get('/team', (_req, res) => res.json(all("SELECT id, name FROM users WHERE active = 1 AND role IN ('admin','manager') ORDER BY name")));

r.get('/users', admin, (_req, res) => res.json(all(
  'SELECT id, name, email, role, active, last_login, (totp_secret_enc IS NOT NULL) has_2fa FROM users ORDER BY name COLLATE NOCASE',
)));

r.post('/users', admin, async (req, res) => {
  const { name, email, role, password } = req.body ?? {};
  const mail = String(email ?? '').trim().toLowerCase();
  if (String(name ?? '').trim().length < 2) return fail(res, 'Nome inválido.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail) || mail.length > 254) return fail(res, 'E-mail inválido.');
  if (!['admin', 'manager', 'viewer', 'tv'].includes(role)) return fail(res, 'Perfil inválido.');
  const problem = passwordProblem(password);
  if (problem) return fail(res, problem);
  if (get('SELECT 1 FROM users WHERE email = ?', mail)) return fail(res, 'Já existe um usuário com esse e-mail.');
  const { id } = run('INSERT INTO users (name,email,pass_hash,role,must_change) VALUES (?,?,?,?,1)',
    String(name).trim(), mail, await hashPassword(password), role);
  audit(req, 'user_create', `${id} ${mail} ${role}`);
  res.status(201).json({ id });
});

r.put('/users/:id', admin, async (req, res) => {
  const id = asInt(req.params.id);
  const u = id && get('SELECT * FROM users WHERE id = ?', id);
  if (!u) return fail(res, 'Usuário não encontrado.', 404);
  const { name, role, active, password } = req.body ?? {};
  if (!['admin', 'manager', 'viewer', 'tv'].includes(role)) return fail(res, 'Perfil inválido.');
  if (id === req.user.id && (role !== 'admin' || active === false)) return fail(res, 'Você não pode remover seu próprio acesso de administrador.');
  run('UPDATE users SET name=?, role=?, active=? WHERE id=?', String(name ?? u.name).trim(), role, active === false ? 0 : 1, id);
  if (password) {
    const problem = passwordProblem(password);
    if (problem) return fail(res, problem);
    run('UPDATE users SET pass_hash=?, must_change=1, failed_attempts=0, locked_until=0 WHERE id=?', await hashPassword(password), id);
  }
  if (active === false || password) run('DELETE FROM sessions WHERE user_id = ?', id);
  audit(req, 'user_update', `${id} ${role}${active === false ? ' desativado' : ''}${password ? ' senha redefinida' : ''}`);
  res.json({ ok: true });
});

r.post('/users/:id/unlock', admin, (req, res) => {
  const id = asInt(req.params.id);
  if (!id) return fail(res, 'Usuário inválido.');
  run('UPDATE users SET failed_attempts = 0, locked_until = 0 WHERE id = ?', id);
  audit(req, 'user_unlock', String(id));
  res.json({ ok: true });
});

/* ------------------------------ Configurações ------------------------------ */
r.get('/settings', admin, (_req, res) => res.json(publicSettings()));

r.put('/settings', admin, (req, res) => {
  const changed = [];
  for (const [k, v] of Object.entries(req.body ?? {})) {
    if (!(k in SETTING_DEFS) || typeof v !== 'string') continue;
    const val = v.trim();
    if (val.length > 2000) return fail(res, `Valor muito longo em ${k}.`);
    if (k === 'notify_webhook_url' && val && !/^https:\/\/[^\s]+$/i.test(val)) return fail(res, 'O webhook precisa ser uma URL HTTPS.');
    if (k === 'google_login_customer_id' && val && !/^[\d-]{10,12}$/.test(val)) return fail(res, 'Customer ID do MCC inválido.');
    setSetting(k, val);
    changed.push(k);
  }
  audit(req, 'settings_update', changed.join(','));
  res.json({ ok: true, changed });
});

r.post('/alerts/evaluate', admin, (_req, res) => res.json({ created: evaluateAlerts() }));

r.get('/audit', admin, (_req, res) => res.json(all('SELECT id, ts, user_name, action, detail, ip FROM audit_log ORDER BY id DESC LIMIT 200')));

export default r;
