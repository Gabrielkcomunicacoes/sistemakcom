import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { InvalidGrantError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { get, all, run, tx, audit } from '../db.js';
import { sha256, randomToken } from '../security.js';
import { authenticate } from '../login.js';

const now = () => Math.floor(Date.now() / 1000);
const ACCESS_TTL = 3600;
const REFRESH_TTL = 30 * 24 * 3600;
const CODE_TTL = 120;
const PENDING_TTL = 600;
const MAX_CLIENTS = 300;
export const SCOPES = ['mcp:read'];
const ALLOWED_ROLES = ['admin', 'manager', 'viewer'];

const trimSlash = (s) => String(s).replace(/#.*$/, '').replace(/\/$/, '');

/** URL pública do sistema (HTTPS em produção) e URL do recurso MCP. */
export function publicBase() {
  return new URL(process.env.PUBLIC_URL || `http://localhost:${+process.env.PORT || 3000}`);
}
export const resourceUrl = () => new URL('/mcp', publicBase());

/**
 * Lista de e-mails liberados para o MCP (MCP_ALLOWED_EMAILS, separados por vírgula).
 * Vazia = ninguém: o acesso é negado por padrão até haver acesso por cliente.
 */
export const mcpAllowedEmails = () => String(process.env.MCP_ALLOWED_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
export const mcpAllowed = (email) => mcpAllowedEmails().includes(String(email ?? '').trim().toLowerCase());

/** Revalidada a cada uso do token: desativar o usuário ou tirá-lo da lista derruba o acesso na hora. */
function userOk(userId) {
  const u = get('SELECT id, name, email, role, active FROM users WHERE id = ?', userId);
  return u && u.active && ALLOWED_ROLES.includes(u.role) && mcpAllowed(u.email) ? u : null;
}

function issueTokens({ clientId, userId, resource, scopes, family }) {
  const access = randomToken(32);
  const refresh = randomToken(32);
  const t = now();
  const ins = 'INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, resource, scopes, expires_at, family) VALUES (?,?,?,?,?,?,?,?)';
  run(ins, sha256(access), 'access', clientId, userId, resource, scopes, t + ACCESS_TTL, family);
  run(ins, sha256(refresh), 'refresh', clientId, userId, resource, scopes, t + REFRESH_TTL, family);
  return { access_token: access, token_type: 'bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope: scopes };
}

const clientsStore = {
  getClient(id) {
    const row = get('SELECT info FROM oauth_clients WHERE client_id = ?', String(id));
    return row ? JSON.parse(row.info) : undefined;
  },
  registerClient(info) {
    // limita o crescimento da tabela: remove registros antigos sem nenhum token ativo
    const n = get('SELECT COUNT(*) n FROM oauth_clients').n;
    if (n >= MAX_CLIENTS) {
      run(`DELETE FROM oauth_clients WHERE client_id IN (
             SELECT client_id FROM oauth_clients WHERE created_at < unixepoch() - 86400
               AND client_id NOT IN (SELECT client_id FROM oauth_tokens))`);
      if (get('SELECT COUNT(*) n FROM oauth_clients').n >= MAX_CLIENTS) throw new Error('Limite de aplicações registradas atingido.');
    }
    run('INSERT INTO oauth_clients (client_id, info) VALUES (?,?)', info.client_id, JSON.stringify(info));
    return info;
  },
};

/** Provedor OAuth 2.1 para o SDK do MCP: o login é feito com os usuários do próprio painel. */
export const provider = {
  clientsStore,

  async authorize(client, params, res) {
    const id = randomToken(32);
    const data = {
      client_id: client.client_id, redirect_uri: params.redirectUri, challenge: params.codeChallenge,
      state: params.state ?? null, scopes: (params.scopes?.length ? params.scopes : SCOPES).filter((s) => SCOPES.includes(s)),
      resource: params.resource ? trimSlash(params.resource.href) : null,
    };
    if (data.resource && data.resource !== trimSlash(resourceUrl().href)) {
      throw new InvalidTargetError('Recurso desconhecido.');
    }
    run('INSERT INTO oauth_pending (id_hash, data, expires_at) VALUES (?,?,?)', sha256(id), JSON.stringify(data), now() + PENDING_TTL);
    res.redirect(302, `/oauth/consent?p=${id}`);
  },

  async challengeForAuthorizationCode(client, code) {
    const row = get('SELECT challenge, client_id, expires_at FROM oauth_codes WHERE code_hash = ?', sha256(code));
    if (!row || row.client_id !== client.client_id || row.expires_at < now()) throw new InvalidGrantError('Código inválido ou expirado.');
    return row.challenge;
  },

  async exchangeAuthorizationCode(client, code, _verifier, redirectUri, resource) {
    const h = sha256(code);
    const row = tx(() => {
      const r = get('SELECT * FROM oauth_codes WHERE code_hash = ?', h);
      run('DELETE FROM oauth_codes WHERE code_hash = ?', h); // uso único
      return r;
    });
    if (!row || row.client_id !== client.client_id || row.expires_at < now()) throw new InvalidGrantError('Código inválido ou expirado.');
    if (redirectUri && redirectUri !== row.redirect_uri) throw new InvalidGrantError('redirect_uri não confere.');
    if (resource && row.resource && trimSlash(resource.href) !== row.resource) throw new InvalidTargetError('Recurso não confere.');
    if (!userOk(row.user_id)) throw new InvalidGrantError('Usuário sem acesso.');
    return issueTokens({
      clientId: client.client_id, userId: row.user_id, resource: row.resource, scopes: row.scopes, family: randomToken(12),
    });
  },

  async exchangeRefreshToken(client, refreshToken) {
    const h = sha256(refreshToken);
    const row = tx(() => {
      const r = get("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'", h);
      if (r) run('DELETE FROM oauth_tokens WHERE family = ?', r.family); // rotação: o refresh antigo e o access par morrem
      return r;
    });
    if (!row || row.client_id !== client.client_id || row.expires_at < now()) throw new InvalidGrantError('Refresh token inválido ou expirado.');
    if (!userOk(row.user_id)) throw new InvalidGrantError('Usuário sem acesso.');
    return issueTokens({ clientId: row.client_id, userId: row.user_id, resource: row.resource, scopes: row.scopes, family: row.family });
  },

  async verifyAccessToken(token) {
    const row = get("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'", sha256(token));
    if (!row || row.expires_at < now()) throw new InvalidTokenError('Token inválido ou expirado.');
    const u = userOk(row.user_id);
    if (!u) throw new InvalidTokenError('Usuário sem acesso.');
    return {
      token, clientId: row.client_id, scopes: row.scopes.split(' ').filter(Boolean), expiresAt: row.expires_at,
      resource: row.resource ? new URL(row.resource) : undefined,
      extra: { userId: u.id, userName: u.name, role: u.role },
    };
  },

  async revokeToken(client, { token }) {
    const row = get('SELECT family, client_id FROM oauth_tokens WHERE token_hash = ?', sha256(token));
    if (row && row.client_id === client.client_id) run('DELETE FROM oauth_tokens WHERE family = ?', row.family);
  },
};

/* ---------- Tela de login/consentimento (usa os usuários do painel) ---------- */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Muitas tentativas. Aguarde alguns minutos.' },
});
const pendingOf = (p) => {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(p ?? ''))) return null;
  const row = get('SELECT data, expires_at FROM oauth_pending WHERE id_hash = ?', sha256(p));
  return row && row.expires_at >= now() ? JSON.parse(row.data) : null;
};

export const consentRouter = Router();

consentRouter.get('/pending', (req, res) => {
  const data = pendingOf(req.query.p);
  if (!data) return res.status(404).json({ error: 'Solicitação expirada. Volte ao Claude e conecte de novo.' });
  const c = clientsStore.getClient(data.client_id);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ client_name: c?.client_name || 'Aplicação externa', scopes: data.scopes });
});

consentRouter.post('/login', loginLimiter, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const origin = req.get('origin');
  if (origin) {
    try { if (new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Origem não permitida.' }); }
    catch { return res.status(403).json({ error: 'Origem inválida.' }); }
  }
  const { p, email, password, code } = req.body ?? {};
  const data = pendingOf(p);
  if (!data) return res.status(400).json({ error: 'Solicitação expirada. Volte ao Claude e conecte de novo.' });

  const result = await authenticate({ email, password, code, ip: req.ip });
  if (!result.user) return res.status(result.status).json(result.body);
  if (!ALLOWED_ROLES.includes(result.user.role) || !mcpAllowed(result.user.email)) {
    audit({ ip: req.ip, user: result.user }, 'mcp_denied', 'usuário não liberado para o MCP');
    return res.status(403).json({ error: 'Seu usuário não está liberado para conectar o MCP nesta versão.' });
  }

  const authCode = randomToken(32);
  tx(() => {
    run('DELETE FROM oauth_pending WHERE id_hash = ?', sha256(p));
    run(
      'INSERT INTO oauth_codes (code_hash, client_id, user_id, challenge, redirect_uri, resource, scopes, expires_at) VALUES (?,?,?,?,?,?,?,?)',
      sha256(authCode), data.client_id, result.user.id, data.challenge, data.redirect_uri, data.resource, data.scopes.join(' '), now() + CODE_TTL,
    );
  });
  const c = clientsStore.getClient(data.client_id);
  audit({ ip: req.ip, user: result.user }, 'mcp_authorize', String(c?.client_name || data.client_id).slice(0, 100));

  const url = new URL(data.redirect_uri);
  url.searchParams.set('code', authCode);
  if (data.state) url.searchParams.set('state', data.state);
  res.json({ redirect: url.href });
});

export function purgeOauth() {
  const t = now();
  run('DELETE FROM oauth_pending WHERE expires_at < ?', t);
  run('DELETE FROM oauth_codes WHERE expires_at < ?', t);
  run('DELETE FROM oauth_tokens WHERE expires_at < ?', t);
}

/** Aplicações conectadas (para o painel de administração). */
export function connectedApps() {
  return all(
    `SELECT t.client_id, o.info, u.name user_name, u.email, MAX(t.expires_at) exp
       FROM oauth_tokens t JOIN users u ON u.id = t.user_id LEFT JOIN oauth_clients o ON o.client_id = t.client_id
      WHERE t.kind = 'refresh' AND t.expires_at > unixepoch() GROUP BY t.client_id, t.user_id`,
  ).map((r) => ({ client_id: r.client_id, name: r.info ? JSON.parse(r.info).client_name : null, user: r.user_name, email: r.email, expires_at: r.exp }));
}
