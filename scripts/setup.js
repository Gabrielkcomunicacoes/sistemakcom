// Primeira execução: gera o .env (MASTER_KEY) e cria o administrador com senha aleatória.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');

if (!fs.existsSync(envPath)) {
  const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  fs.writeFileSync(envPath, example.replace(/^MASTER_KEY=.*$/m, `MASTER_KEY=${crypto.randomBytes(32).toString('hex')}`), { mode: 0o600 });
  console.log('✔ .env criado com MASTER_KEY nova (faça backup deste arquivo!)');
}
process.loadEnvFile(envPath);

const { get, run } = await import('../server/db.js');
const { hashPassword } = await import('../server/security.js');

const email = (process.argv[2] || 'admin@kcom.local').toLowerCase();
if (get('SELECT 1 FROM users WHERE email = ?', email)) {
  console.log(`Usuário ${email} já existe. Nada a fazer.`);
} else {
  const pick = (s) => s[crypto.randomInt(s.length)];
  const all = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%&*';
  const pw = [pick('abcdefghijkmnpqrstuvwxyz'), pick('ABCDEFGHJKLMNPQRSTUVWXYZ'), pick('23456789'), pick('!@#$%&*'),
    ...Array.from({ length: 12 }, () => pick(all))].sort(() => crypto.randomInt(3) - 1).join('');
  run("INSERT INTO users (name,email,pass_hash,role,must_change) VALUES ('Administrador',?,?,'admin',1)", email, await hashPassword(pw));
  console.log(`\n✔ Administrador criado\n   e-mail: ${email}\n   senha : ${pw}\n   (será exigida a troca no primeiro acesso)\n`);
}
console.log('Agora rode: npm start');
