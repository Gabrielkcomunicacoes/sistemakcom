import { api, esc, icon, toast, dateTime, ago, state } from '../core.js';

const PLAT = { google: 'Google Ads', meta: 'Meta Ads' };
const TYPES = { low_balance: 'Saldo baixo', cost_high: 'Custo alto', no_conversion: 'Sem conversão', no_spend: 'Sem gasto', reach_low: 'Alcance baixo', spend_spike: 'Gasto disparou', conv_drop: 'Conversões zeradas', budget_overrun: 'Verba estourando', sync_error: 'Erro de sincronização' };

export default {
  title: 'Alertas',
  async render(root) {
    let tab = 'open';
    const canAck = ['admin', 'manager'].includes(state.user.role);
    const draw = async () => {
      let list;
      try { list = await api(`/alerts?status=${tab}`); } catch (e) { toast(e.message, 'err'); return; }
      root.innerHTML = `<div class="top"><div><h1>Alertas</h1><div class="sub">Problemas detectados automaticamente a cada sincronização</div></div><div class="sp"></div>
        <div class="seg" id="t"><button data-t="open" class="${tab === 'open' ? 'on' : ''}">Ativos</button><button data-t="history" class="${tab === 'history' ? 'on' : ''}">Histórico</button></div></div>
        ${list.length ? list.map((a) => `<div class="alert ${a.severity}">
          <div class="ic">${icon('alert')}</div>
          <div class="body"><b>${esc(a.client)}</b> <span class="muted">· ${PLAT[a.platform]} · ${esc(TYPES[a.type] ?? a.type)}</span><br><small>${esc(a.message)} — ${tab === 'open' ? `há ${ago(a.created_at)}` : `resolvido ${dateTime(a.resolved_at)}`}</small></div>
          ${a.ack_at ? '<span class="badge ok">Visto</span>' : ''}
          ${tab === 'open' && canAck && !a.ack_at ? `<button class="btn sm" data-ack="${a.id}">Marcar como visto</button>` : ''}
          <a class="btn sm" href="#/cliente/${a.client_id}">Abrir</a></div>`).join('')
          : `<div class="empty panel">${icon('shield')}<p style="margin-top:8px">${tab === 'open' ? 'Tudo certo! Nenhum alerta ativo.' : 'Nenhum alerta no histórico.'}</p></div>`}`;
      root.querySelector('#t').onclick = (e) => { if (e.target.dataset.t) { tab = e.target.dataset.t; draw(); } };
      root.querySelectorAll('[data-ack]').forEach((b) => { b.onclick = async () => { await api(`/alerts/${b.dataset.ack}/ack`, { method: 'POST' }); draw(); }; });
    };
    draw();
  },
};
