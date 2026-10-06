// Backup consistente do banco (seguro com o app rodando): VACUUM INTO gera uma cópia íntegra em um único arquivo.
// Uso: npm run backup [pasta-destino]   (padrão: data/backups). Guarde também a MASTER_KEY, em local separado.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'data', 'kcom.db');
const outDir = path.resolve(process.argv[2] || path.join(root, 'data', 'backups'));
if (!fs.existsSync(src)) { console.error(`Banco não encontrado em ${src}`); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const dest = path.join(outDir, `kcom-${stamp}.db`);

const db = new DatabaseSync(src);
db.exec('PRAGMA busy_timeout = 10000');
db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
db.close();

// confere a cópia: integridade e contagem de tabelas-chave
const chk = new DatabaseSync(dest, { readOnly: true });
const integrity = chk.prepare('PRAGMA integrity_check').get().integrity_check;
const n = (t) => chk.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
const summary = { users: n('users'), clients: n('clients'), channels: n('channels'), settings: n('settings') };
chk.close();
if (integrity !== 'ok') { console.error(`Backup corrompido (${integrity}); removendo.`); fs.rmSync(dest); process.exit(1); }
fs.chmodSync(dest, 0o600);
console.log(`✔ Backup: ${dest} (${(fs.statSync(dest).size / 1024).toFixed(0)} KB) · integridade ok · ${JSON.stringify(summary)}`);
console.log('  Copie o arquivo para fora do servidor. Ele contém chaves cifradas: só abre com a MASTER_KEY correspondente.');
