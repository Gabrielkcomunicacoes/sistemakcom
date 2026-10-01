import { get, all, run } from './db.js';
import { buildDashboard, todayBR, hourBR, addDays } from './metrics.js';
import { getSetting } from './settings.js';

const brl = (n) => `R$ ${Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const METRIC_LABEL = { cpl: 'CPL', cpa: 'CPA', followers: 'Custo/seguidor' };
const NAMES = { google: 'Google Ads', meta: 'Meta Ads' };

async function notify(text) {
  const hook = getSetting('notify_webhook_url');
  if (hook && /^https:\/\//i.test(hook)) {
    fetch(hook, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, message: text, source: 'kcom-monitor' }),
      signal: AbortSignal.timeout(10000),
    }).catch((e) => console.error('[notify] webhook:', e.message));
  }
  const tg = getSetting('notify_telegram_token');
  const chat = getSetting('notify_telegram_chat');
  if (tg && chat) {
    fetch(`https://api.telegram.org/bot${tg}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text }),
      signal: AbortSignal.timeout(10000),
    }).catch((e) => console.error('[notify] telegram:', e.message));
  }
}

/** Condições ativas de um canal → [{type, severity, message}] */
function conditions(client, ch, d3, first) {
  const out = [];
  if (ch.daysLeft != null && ch.daysLeft < 3) {
    out.push({
      type: 'low_balance', severity: ch.daysLeft < 1.5 ? 'critical' : 'warning',
      message: ch.daysLeft <= 0.05
        ? `Saldo ${brl(ch.balance)} — esgotado. Faça a recarga`
        : `Saldo ${brl(ch.balance)} dura ~${ch.daysLeft.toFixed(1).replace('.', ',')} dia(s) — zera em ${ch.depletionDate.split('-').reverse().join('/')}. Programe a recarga`,
    });
  } else if (ch.balance != null && ch.balance <= 0 && ch._avg7 > 0) {
    out.push({ type: 'low_balance', severity: 'critical', message: 'Conta sem saldo' });
  }
  if (ch.metric === 'reach') {
    if (ch.target > 0 && d3.spend > 0 && ch._reach3 < ch.target * 0.8) {
      out.push({
        type: 'reach_low', severity: 'warning',
        message: `Alcance médio ${Math.round(ch._reach3).toLocaleString('pt-BR')}/dia (meta ${ch.target.toLocaleString('pt-BR')})`,
      });
    }
  } else if (ch.target > 0) {
    if (d3.conv > 0 && d3.spend / d3.conv > ch.target * 1.25) {
      const v = d3.spend / d3.conv;
      out.push({
        type: 'cost_high', severity: 'warning',
        message: `${METRIC_LABEL[ch.metric]} 3 dias ${brl(v)} (meta ${brl(ch.target)})`,
      });
    } else if (d3.conv === 0 && d3.spend >= ch.target * 2) {
      out.push({ type: 'no_conversion', severity: 'warning', message: `${brl(d3.spend)} gastos em 3 dias sem conversão` });
    }
  }
  if (ch._avg7 > 0 && ch.todaySpend === 0 && hourBR() >= 12) {
    out.push({ type: 'no_spend', severity: 'warning', message: 'Sem gasto hoje (campanha parada?)' });
  }
  if (ch._avgPrev7 > 0 && ch.todaySpend > ch._avgPrev7 * 1.6 && ch.todaySpend - ch._avgPrev7 >= 20) {
    out.push({
      type: 'spend_spike', severity: 'warning',
      message: `Gasto de hoje ${brl(ch.todaySpend)} vs. média diária ${brl(ch._avgPrev7)} (+${Math.round((ch.todaySpend / ch._avgPrev7 - 1) * 100)}%)`,
    });
  }
  if (ch.metric !== 'reach' && ch._priorConv >= 3 && ch._conv2 === 0 && ch._spend2 > 0) {
    out.push({ type: 'conv_drop', severity: 'warning', message: `Conversões caíram a zero (${brl(ch._spend2)} gastos em 2 dias; ${Math.round(ch._priorConv)} na semana anterior)` });
  }
  if (first && client.projectedPct != null && client.dayOfMonth >= 3 && client.projectedPct > 105) {
    out.push({
      type: 'budget_overrun', severity: client.projectedPct > 120 ? 'critical' : 'warning',
      message: `Projeção do mês ${brl(client.projectedSpend)} = ${client.projectedPct}% da verba de ${brl(client.monthlyBudget)}`,
    });
  }
  if (ch.error) out.push({ type: 'sync_error', severity: 'warning', message: `Falha ao sincronizar: ${ch.error}` });
  return out;
}

export function evaluateAlerts() {
  const today = todayBR();
  const dash = buildDashboard({ from: today, to: today });
  const fresh = [];
  const from3 = addDays(today, -2);
  const sums = new Map(all(
    'SELECT channel_id, SUM(spend) s, SUM(conversions) c FROM metrics_daily WHERE date >= ? GROUP BY channel_id', from3,
  ).map((r) => [r.channel_id, { spend: r.s, conv: r.c }]));

  for (const client of dash.clients) {
    for (const [i, ch] of client.channels.entries()) {
      const active = new Map(conditions(client, ch, sums.get(ch.id) ?? { spend: 0, conv: 0 }, i === 0).map((c) => [c.type, c]));
      const open = all('SELECT * FROM alerts WHERE channel_id = ? AND resolved_at IS NULL', ch.id);
      for (const a of open) {
        const c = active.get(a.type);
        if (!c) run('UPDATE alerts SET resolved_at = unixepoch() WHERE id = ?', a.id);
        else { run('UPDATE alerts SET severity = ?, message = ? WHERE id = ?', c.severity, c.message, a.id); active.delete(a.type); }
      }
      for (const c of active.values()) {
        run('INSERT INTO alerts (channel_id, type, severity, message, created_at) VALUES (?,?,?,?,unixepoch())',
          ch.id, c.type, c.severity, c.message);
        fresh.push({ client: client.name, platform: ch.platform, ...c });
      }
    }
  }
  for (const f of fresh) {
    const icon = f.severity === 'critical' ? '🔴' : '🟡';
    notify(`${icon} ${f.client} · ${NAMES[f.platform]}\n${f.message}`);
  }
  return fresh.length;
}

export const openAlertCount = () => get('SELECT COUNT(*) n FROM alerts WHERE resolved_at IS NULL').n;
