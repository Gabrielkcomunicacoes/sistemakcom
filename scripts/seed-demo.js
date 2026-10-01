// Dados fictícios para visualizar o painel sem chaves de API. Canais "demo" nunca são sincronizados.
import { run, get, tx } from '../server/db.js';
import { addDays, todayBR } from '../server/metrics.js';
import { evaluateAlerts } from '../server/alerts.js';

if (get('SELECT 1 FROM clients LIMIT 1')) { console.log('Já existem clientes; seed cancelado.'); process.exit(0); }

// [nome, google(meta,metric)|null, meta(meta,metric)|null, saldo, fator de desempenho]
const DEMO = [
  ['Agronegócia', null, [25, 'cpl'], 644, 0.8], ['Infinity Odontologia', null, [10, 'cpl'], 95, 1.0],
  ['Lisboa', [20, 'cpl'], [10, 'cpl'], 1133, 0.7], ['Nargos', null, [9, 'cpl'], 60, 1.0],
  ['Posto Mercolub', [10, 'cpl'], [9, 'cpa'], 210, 1.6], ['Smile Odonto', null, [12, 'cpl'], 88, 0.9],
  ['Smile Skin', [25, 'cpl'], [8, 'cpl'], 49, 1.1], ['The Bus', [6, 'cpl'], [3.5, 'cpl'], 16, 0.85],
  ['Shopping Bresser', [27, 'cpl'], [80, 'cpa'], 96, 1.3], ['Sandri & Athenas', [15, 'cpl'], [43, 'cpl'], 120, 0.9],
  ['Ultraseguros', null, [10, 'cpl'], 12, 1.0], ['Ecodecor Toledo', null, [12, 'cpl'], 9, 1.7],
  ['Barra Forte', null, [7, 'cpl'], 140, 0.55], ['MS Tintas', null, [15, 'cpl'], 30, 0.75],
  ['Franguinho de Itapemirim', null, [6, 'cpa'], 60, 2.4], ['Autentika', null, [20, 'cpl'], 61, 0.83],
  ['Clínica Beleza Atual', null, [12, 'cpl'], 85, 1.0], ['Biorevitale', null, [13, 'cpl'], 82, 1.0],
  ['Noova', null, [5, 'cpl'], 101, 0.02], ['Selaria Cavalo Real', [20, 'cpa'], [70, 'cpa'], 2146, 1.2],
];

const rnd = (a, b) => a + Math.random() * (b - a);
const today = todayBR();

tx(() => {
  for (const [name, g, m, balance, factor] of DEMO) {
    const { id } = run('INSERT INTO clients (name, monthly_budget) VALUES (?, ?)', name, Math.round(rnd(1500, 6000)));
    for (const [platform, cfg] of [['google', g], ['meta', m]]) {
      if (!cfg) continue;
      const [target, metric] = cfg;
      const ch = run('INSERT INTO channels (client_id, platform, account_id, metric, target) VALUES (?,?,?,?,?)', id, platform, 'demo', metric, target).id;
      const daily = target * rnd(2.5, 9);
      for (let i = 0; i < 30; i++) {
        const spend = i === 0 && balance < 20 ? 0 : daily * rnd(0.6, 1.4);
        const conv = Math.max(0, Math.round((spend / (target * factor)) * rnd(0.8, 1.2)));
        run('INSERT INTO metrics_daily VALUES (?,?,?,?)', ch, addDays(today, -i), Math.round(spend * 100) / 100, conv);
      }
      const low = balance < 20 || balance === 49 || balance === 16;
      run('INSERT INTO channel_status (channel_id, balance, last_sync) VALUES (?,?,unixepoch())', ch, low ? Math.round(daily * rnd(0.3, 1.2)) : Math.round(daily * rnd(5, 18)));
    }
  }
});
console.log(`✔ ${DEMO.length} clientes de demonstração criados. Alertas gerados: ${evaluateAlerts()}`);
