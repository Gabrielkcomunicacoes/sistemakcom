import { api, esc, brl, icon, toast, modal, confirmBox, state, METRIC } from '../core.js';

const PLAT = { google: 'Google Ads', meta: 'Meta Ads' };
const metricOptions = (platform) => [['cpl', 'CPL'], ['cpa', 'CPA (Vendas)'], ...(platform === 'meta' ? [['followers', 'Seguidores'], ['reach', 'Alcance']] : [])];
const HINTS = {
  cpl: 'Custo máximo por lead.', cpa: 'Custo máximo por venda.',
  followers: 'Custo máximo por seguidor (seguidores do Instagram + curtidas da página).',
  reach: 'Meta de pessoas alcançadas por dia. O saldo vem da API (teto − gasto).',
};
const RESULTS = [['auto', 'Automático'], ['lead', 'Leads (formulário)'], ['message', 'Conversas de mensagem'], ['purchase', 'Compras'], ['click', 'Cliques no link'], ['lpv', 'Visualizações da página']];

function channelBox(platform, ch) {
  const on = !!ch;
  return `<div class="ch-box ${on ? '' : 'off'}" data-p="${platform}">
    <label class="check"><input type="checkbox" data-on ${on ? 'checked' : ''}><b style="color:var(--${platform})">${PLAT[platform]}</b></label>
    <div class="grid cols-2">
      <div class="field"><label>ID da conta</label><input data-acc value="${esc(ch?.account_id ?? '')}" placeholder="${platform === 'google' ? '1234567890' : 'act_123456789'}" maxlength="32"></div>
      <div class="field"><label>Métrica</label><select data-metric>${metricOptions(platform).map(([v, l]) => `<option value="${v}" ${(ch?.metric ?? 'cpl') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field" data-resfield><label>Evento de resultado</label><select data-result>${RESULTS.map(([v, l]) => `<option value="${v}" ${(ch?.result_type ?? 'auto') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <span class="hint">${platform === 'meta' ? 'O que conta como resultado nessa conta' : 'Google usa as conversões da conta'}</span></div>
      <div class="field"><label data-tlabel>Meta (R$)</label><input data-target type="number" step="0.01" min="0" value="${ch?.target ?? ''}"><span class="hint" data-thint></span></div>
    </div></div>`;
}

async function openForm(client, team, done) {
  const c = client ?? { channels: [] };
  const { el, close } = modal(`<h2>${client ? 'Editar cliente' : 'Novo cliente'}</h2>
    <form class="grid" id="f" novalidate>
      <div class="field"><label>Nome do cliente</label><input id="name" maxlength="80" required value="${esc(c.name ?? '')}" placeholder="Ex: Solar Prime"></div>
      <div class="grid cols-2">
        <div class="field"><label>Responsável</label><select id="mgr"><option value="">— ninguém —</option>${team.map((u) => `<option value="${u.id}" ${u.id === c.manager_id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Verba mensal (R$)</label><input id="budget" type="number" step="1" min="0" value="${c.monthly_budget ?? ''}" placeholder="opcional"></div>
      </div>
      ${channelBox('google', c.channels.find((x) => x.platform === 'google'))}
      ${channelBox('meta', c.channels.find((x) => x.platform === 'meta'))}
      <div class="field"><label>Observações</label><textarea id="notes" maxlength="500">${esc(c.notes ?? '')}</textarea></div>
      <div class="actions"><button type="button" class="btn" data-x>Cancelar</button><button class="btn primary" type="submit">${client ? 'Salvar' : 'Ativar monitoramento'}</button></div>
    </form>`);
  el.querySelector('[data-x]').onclick = close;
  el.querySelectorAll('.ch-box').forEach((box) => {
    box.querySelector('[data-on]').onchange = (e) => box.classList.toggle('off', !e.target.checked);
    const sync = () => {
      const m = box.querySelector('[data-metric]').value;
      box.querySelector('[data-resfield]').classList.toggle('hidden', !['cpl', 'cpa'].includes(m));
      box.querySelector('[data-tlabel]').textContent = m === 'reach' ? 'Meta de alcance por dia' : 'Meta (R$)';
      box.querySelector('[data-thint]').textContent = HINTS[m];
      box.querySelector('[data-target]').step = m === 'reach' ? '1' : '0.01';
    };
    box.querySelector('[data-metric]').onchange = sync;
    sync();
  });
  el.querySelector('#f').onsubmit = async (e) => {
    e.preventDefault();
    const channels = [...el.querySelectorAll('.ch-box')].filter((b) => b.querySelector('[data-on]').checked).map((b) => ({
      platform: b.dataset.p, account_id: b.querySelector('[data-acc]').value.trim(),
      metric: b.querySelector('[data-metric]').value, result_type: b.querySelector('[data-result]').value, target: b.querySelector('[data-target]').value || 0,
    }));
    const body = {
      name: el.querySelector('#name').value, manager_id: el.querySelector('#mgr').value || null,
      monthly_budget: el.querySelector('#budget').value, notes: el.querySelector('#notes').value, channels,
    };
    try {
      await api(client ? `/clients/${client.id}` : '/clients', { method: client ? 'PUT' : 'POST', body });
      close(); toast('Cliente salvo.', 'ok'); done();
    } catch (err) { toast(err.message, 'err'); }
  };
}

export default {
  title: 'Clientes',
  async render(root) {
    const isAdmin = state.user.role === 'admin';
    let q = '';
    const draw = async () => {
      let clients, team;
      try { [clients, team] = await Promise.all([api('/clients'), api('/team')]); } catch (e) { toast(e.message, 'err'); return; }
      const rows = clients.filter((c) => c.name.toLowerCase().includes(q.toLowerCase()));
      root.innerHTML = `<div class="top"><div><h1>Clientes</h1><div class="sub">${clients.length} monitorados</div></div><div class="sp"></div>
        <div class="search" style="position:relative;width:240px"><input id="q" placeholder="Buscar…" value="${esc(q)}" aria-label="Buscar"></div>
        <button class="btn primary" id="new">${icon('plus')} Novo cliente</button></div>
        <div class="panel scroll-x" style="padding:6px"><table class="table"><thead><tr><th>Cliente</th><th>Canais</th><th>Responsável</th><th>Verba</th><th class="act">Ações</th></tr></thead><tbody>
        ${rows.map((c) => `<tr><td><b>${esc(c.name)}</b>${c.active ? '' : ' <span class="badge">inativo</span>'}</td>
          <td style="display:flex;gap:6px;flex-wrap:wrap">${c.channels.map((ch) => `<span class="badge" style="color:var(--${ch.platform})">${PLAT[ch.platform]} · ${METRIC[ch.metric]} ${ch.metric === 'reach' ? `${ch.target.toLocaleString('pt-BR')}/dia` : brl(ch.target)}${/^(act_)?\d[\d-]{5,}$/.test(ch.account_id) ? '' : ' · demo'}</span>`).join('')}</td>
          <td>${esc(c.manager ?? '—')}</td><td>${c.monthly_budget ? brl(c.monthly_budget, 0) : '—'}</td>
          <td class="act"><button class="btn sm ghost" data-edit="${c.id}">${icon('edit')} Editar</button>${isAdmin ? ` <button class="btn sm danger" data-del="${c.id}">${icon('trash')}</button>` : ''}</td></tr>`).join('')
          || '<tr><td colspan="5" class="empty">Nenhum cliente.</td></tr>'}
        </tbody></table></div>`;
      const qi = root.querySelector('#q');
      qi.oninput = (e) => { q = e.target.value; const pos = e.target.selectionStart; draw().then(() => { const n = root.querySelector('#q'); n.focus(); n.setSelectionRange(pos, pos); }); };
      root.querySelector('#new').onclick = () => openForm(null, team, draw);
      root.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => openForm(clients.find((c) => c.id === +b.dataset.edit), team, draw); });
      root.querySelectorAll('[data-del]').forEach((b) => {
        b.onclick = async () => {
          const c = clients.find((x) => x.id === +b.dataset.del);
          if (await confirmBox(`Excluir "${c.name}" e todo o histórico?`, 'Excluir')) {
            try { await api(`/clients/${c.id}`, { method: 'DELETE' }); toast('Cliente excluído.', 'ok'); draw(); } catch (e) { toast(e.message, 'err'); }
          }
        };
      });
    };
    draw();
  },
};
