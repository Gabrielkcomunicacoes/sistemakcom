import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import QRCode from 'qrcode';
import { get, run, audit } from '../db.js';
import {
  hashPassword, verifyPassword, passwordProblem, encrypt, decrypt, newTotpSecret, verifyTotp,
} from '../security.js';
import { createSession, destroySession, requireAuth, revokeOtherSessions } from '../session.js';

const r = Router();
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const DUMMY = await hashPassword('dummy-password-for-timing');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Muitas tentativas. Aguarde alguns minutos.' },
});

const publicUser = (u, csrf) => ({
  user: { id: u.id, name: u.name, email: u.email, role: u.role, must_change: !!u.must_change, has_2fa: !!u.has_2fa },
  csrf,
});

r.post('/login', loginLimiter, async (req, res) => {
  const { email, password, code } = req.body ?? {};
  if (typeof email !== 'string' || typeof password !== 'string' || email.length > 254 || password.length > 200) {
    return res.status(400).json({ error: 'Dados inválidos.' });
  }
  const generic = { error: 'E-mail ou senha incorretos.' };
  const u = get('SELECT * FROM users WHERE email = ?', email.trim().toLowerCase());
  const locked = u && u.locked_until > Date.now();
  // sempre executa o hash, exista o usuário ou não (evita enumeração por tempo)
  const passOk = await verifyPassword(password, u?.pass_hash ?? DUMMY);

  const fail = (why) => {
    if (u) {
      const fails = u.failed_attempts + 1;
      if (fails >= MAX_FAILS) run('UPDATE users SET failed_attempts = 0, locked_until = ? WHERE id = ?', Date.now() + LOCK_MS, u.id);
      else run('UPDATE users SET failed_attempts = ? WHERE id = ?', fails, u.id);
    }
    audit({ ip: req.ip, user: u }, 'login_fail', `${why} ${email.slice(0, 80)}`);
    return res.status(401).json(generic);
  };

  if (locked) {
    audit({ ip: req.ip, user: u }, 'login_blocked', email.slice(0, 80));
    return res.status(429).json({ error: 'Conta temporariamente bloqueada. Tente novamente em 15 minutos.' });
  }
  if (!u || !u.active || !passOk) return fail('senha');

  if (u.totp_secret_enc) {
    if (!code) return res.status(401).json({ error: 'Informe o código do autenticador.', code: '2fa_required' });
    if (!verifyTotp(decrypt(u.totp_secret_enc), String(code).trim())) return fail('2fa');
  }

  run('UPDATE users SET failed_attempts = 0, locked_until = 0, last_login = unixepoch() WHERE id = ?', u.id);
  const csrf = createSession(req, res, u);
  audit({ ip: req.ip, user: u }, 'login_ok');
  res.json(publicUser({ ...u, has_2fa: !!u.totp_secret_enc }, csrf));
});

r.post('/logout', (req, res) => {
  if (req.user) audit(req, 'logout');
  destroySession(req, res);
  res.json({ ok: true });
});

r.get('/me', requireAuth, (req, res) => res.json(publicUser(req.user, req.session.csrf)));

r.post('/password', requireAuth, async (req, res) => {
  const { current, next } = req.body ?? {};
  const u = get('SELECT pass_hash FROM users WHERE id = ?', req.user.id);
  if (typeof current !== 'string' || !(await verifyPassword(current, u.pass_hash))) {
    return res.status(400).json({ error: 'Senha atual incorreta.' });
  }
  const problem = passwordProblem(next);
  if (problem) return res.status(400).json({ error: problem });
  if (next === current) return res.status(400).json({ error: 'A nova senha deve ser diferente da atual.' });
  run('UPDATE users SET pass_hash = ?, must_change = 0 WHERE id = ?', await hashPassword(next), req.user.id);
  revokeOtherSessions(req.user.id, req.session.id);
  audit(req, 'password_change');
  res.json({ ok: true });
});

/* ---- 2FA (TOTP) ---- */
r.post('/2fa/setup', requireAuth, async (req, res) => {
  const secret = newTotpSecret();
  run('UPDATE users SET totp_pending_enc = ? WHERE id = ?', encrypt(secret), req.user.id);
  const uri = `otpauth://totp/KCOM%20Monitor:${encodeURIComponent(req.user.email)}?secret=${secret}&issuer=KCOM%20Monitor`;
  res.json({ secret, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) });
});

r.post('/2fa/enable', requireAuth, (req, res) => {
  const u = get('SELECT totp_pending_enc FROM users WHERE id = ?', req.user.id);
  if (!u?.totp_pending_enc) return res.status(400).json({ error: 'Inicie a configuração primeiro.' });
  if (!verifyTotp(decrypt(u.totp_pending_enc), String(req.body?.code ?? '').trim())) {
    return res.status(400).json({ error: 'Código inválido.' });
  }
  run('UPDATE users SET totp_secret_enc = totp_pending_enc, totp_pending_enc = NULL WHERE id = ?', req.user.id);
  audit(req, '2fa_enabled');
  res.json({ ok: true });
});

r.post('/2fa/disable', requireAuth, async (req, res) => {
  const u = get('SELECT pass_hash, totp_secret_enc FROM users WHERE id = ?', req.user.id);
  if (!(await verifyPassword(String(req.body?.password ?? ''), u.pass_hash))) {
    return res.status(400).json({ error: 'Senha incorreta.' });
  }
  if (u.totp_secret_enc && !verifyTotp(decrypt(u.totp_secret_enc), String(req.body?.code ?? '').trim())) {
    return res.status(400).json({ error: 'Código inválido.' });
  }
  run('UPDATE users SET totp_secret_enc = NULL, totp_pending_enc = NULL WHERE id = ?', req.user.id);
  audit(req, '2fa_disabled');
  res.json({ ok: true });
});

export default r;
