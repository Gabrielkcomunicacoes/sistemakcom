import { get, run } from './db.js';
import { sha256, randomToken, safeEqual } from './security.js';

export const SECURE = process.env.COOKIE_SECURE === '1';
export const COOKIE = SECURE ? '__Host-kcom_sid' : 'kcom_sid';
const IDLE = (+process.env.SESSION_IDLE_MIN || 240) * 60;
const ABS = (+process.env.SESSION_ABS_HOURS || 24) * 3600;
const TV_ABS = 30 * 24 * 3600;
const TV_IDLE = 30 * 24 * 3600;
const now = () => Math.floor(Date.now() / 1000);

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function createSession(req, res, user) {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const abs = user.role === 'tv' ? TV_ABS : ABS;
  run(
    'INSERT INTO sessions (id,user_id,csrf,ip,ua,created_at,last_seen,expires_at) VALUES (?,?,?,?,?,?,?,?)',
    sha256(token), user.id, csrf, req.ip, String(req.get('user-agent') || '').slice(0, 200), now(), now(), now() + abs,
  );
  res.cookie(COOKIE, token, { httpOnly: true, secure: SECURE, sameSite: 'strict', path: '/', maxAge: abs * 1000 });
  return csrf;
}

export function destroySession(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) run('DELETE FROM sessions WHERE id = ?', sha256(token));
  res.clearCookie(COOKIE, { httpOnly: true, secure: SECURE, sameSite: 'strict', path: '/' });
}

/** Anexa req.user / req.session quando o cookie é válido. */
export function attachSession(req, _res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return next();
  const row = get(
    `SELECT s.id sid, s.csrf, s.last_seen, s.expires_at, u.id, u.name, u.email, u.role, u.active, u.must_change,
            (u.totp_secret_enc IS NOT NULL) AS has_2fa
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    sha256(token),
  );
  if (!row) return next();
  const idle = row.role === 'tv' ? TV_IDLE : IDLE;
  if (!row.active || row.expires_at < now() || row.last_seen + idle < now()) {
    run('DELETE FROM sessions WHERE id = ?', row.sid);
    return next();
  }
  if (now() - row.last_seen > 60) run('UPDATE sessions SET last_seen = ? WHERE id = ?', now(), row.sid);
  req.session = { id: row.sid, csrf: row.csrf };
  req.user = {
    id: row.id, name: row.name, email: row.email, role: row.role,
    must_change: !!row.must_change, has_2fa: !!row.has_2fa,
  };
  next();
}

export function revokeOtherSessions(userId, keepId) {
  run('DELETE FROM sessions WHERE user_id = ? AND id != ?', userId, keepId);
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sessão expirada.' });
  if (req.user.must_change && !req.originalUrl.startsWith('/api/auth/')) {
    return res.status(403).json({ error: 'Troque sua senha para continuar.', code: 'password_change_required' });
  }
  next();
}

export const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user?.role) ? next() : res.status(403).json({ error: 'Sem permissão.' });

/** CSRF: token por sessão no header + checagem de Origin em métodos que alteram estado. */
export function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Origem não permitida.' });
    } catch { return res.status(403).json({ error: 'Origem inválida.' }); }
  }
  // login ainda não tem sessão; é protegido por SameSite=Strict + Origin + rate limit
  if (req.path === '/auth/login') return next();
  if (!req.session || !safeEqual(req.get('x-csrf-token') || '', req.session.csrf)) {
    return res.status(403).json({ error: 'Token CSRF inválido. Recarregue a página.' });
  }
  next();
}

export function purgeExpired() {
  run('DELETE FROM sessions WHERE expires_at < ?', now());
}
