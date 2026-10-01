import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (n = 32) => crypto.randomBytes(n).toString('base64url');

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* ---------- Senhas (scrypt + salt, comparação em tempo constante) ---------- */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [algo, N, r, p, salt, hash] = stored.split('$');
    if (algo !== 'scrypt') return false;
    const expected = Buffer.from(hash, 'base64');
    const got = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, {
      N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem,
    });
    return crypto.timingSafeEqual(got, expected);
  } catch {
    return false;
  }
}

export function passwordProblem(pw) {
  if (typeof pw !== 'string') return 'Senha inválida.';
  if (pw.length < 12) return 'A senha precisa ter pelo menos 12 caracteres.';
  if (pw.length > 128) return 'A senha é longa demais.';
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  if (classes < 3) return 'Use ao menos 3 tipos: minúscula, maiúscula, número e símbolo.';
  if (/^(.)\1+$/.test(pw) || /(password|senha|123456|qwerty)/i.test(pw)) return 'Senha previsível demais.';
  return null;
}

/* ---------- Cifragem de segredos em repouso (AES-256-GCM) ---------- */
function masterKey() {
  const hex = process.env.MASTER_KEY || '';
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error('MASTER_KEY ausente ou inválida. Rode "npm run setup".');
  }
  return Buffer.from(hex, 'hex');
}

export function assertMasterKey() { masterKey(); }

export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function decrypt(blob) {
  const [v, iv, tag, ct] = String(blob).split(':');
  if (v !== 'v1') throw new Error('formato de segredo inválido');
  const d = crypto.createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

/* ---------- TOTP (RFC 6238) para 2FA ---------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of str.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) continue;
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newTotpSecret = () => base32Encode(crypto.randomBytes(20));

function hotp(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, '0');
}

export function verifyTotp(secret, code) {
  if (!/^\d{6}$/.test(String(code))) return false;
  const step = Math.floor(Date.now() / 30000);
  for (let w = -1; w <= 1; w++) if (safeEqual(hotp(secret, step + w), code)) return true;
  return false;
}
