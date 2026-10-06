import { get, run, audit } from './db.js';
import { hashPassword, verifyPassword, decrypt, verifyTotp } from './security.js';

const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const DUMMY = await hashPassword('dummy-password-for-timing');

/**
 * Confere e-mail, senha e 2FA com bloqueio por tentativas (mesmas regras do login do painel).
 * Retorna { user } em caso de sucesso, ou { status, body } para responder ao cliente.
 */
export async function authenticate({ email, password, code, ip }) {
  if (typeof email !== 'string' || typeof password !== 'string' || email.length > 254 || password.length > 200) {
    return { status: 400, body: { error: 'Dados inválidos.' } };
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
    audit({ ip, user: u }, 'login_fail', `${why} ${email.slice(0, 80)}`);
    return { status: 401, body: generic };
  };

  if (locked) {
    audit({ ip, user: u }, 'login_blocked', email.slice(0, 80));
    return { status: 429, body: { error: 'Conta temporariamente bloqueada. Tente novamente em 15 minutos.' } };
  }
  if (!u || !u.active || !passOk) return fail('senha');

  if (u.totp_secret_enc) {
    if (!code) return { status: 401, body: { error: 'Informe o código do autenticador.', code: '2fa_required' } };
    if (!verifyTotp(decrypt(u.totp_secret_enc), String(code).trim())) return fail('2fa');
  }

  run('UPDATE users SET failed_attempts = 0, locked_until = 0, last_login = unixepoch() WHERE id = ?', u.id);
  audit({ ip, user: u }, 'login_ok');
  return { user: { ...u, has_2fa: !!u.totp_secret_enc } };
}
