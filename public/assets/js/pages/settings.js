import { api, esc, icon, toast } from '../core.js';

const GROUPS = {
  meta: ['Meta Ads API', 'Token de acesso de usuário do sistema com permissão ads_read.'],
  google: ['Google Ads API', 'Developer token, cliente OAuth e refresh token. O login customer ID é o MCC, quando usado.'],
  notify: ['Notificações de alerta', 'Receba alertas novos por webhook HTTPS (WhatsApp via Z-API/Evolution, Slack, Zapier…) e/ou Telegram.'],
};

export default {
  title: 'Configurações',
  async render(root) {
    let s;
    try { s = await api('/settings'); } catch (e) { toast(e.message, 'err'); return; }
    root.innerHTML = `<div class="top"><div><h1>Chaves e integrações</h1><div class="sub">${icon('shield')} Tudo é cifrado (AES-256-GCM) no banco. Valores salvos nunca voltam para o navegador.</div></div></div>
      <form id="f" class="grid" style="max-width:760px" autocomplete="off">
      ${Object.entries(GROUPS).map(([g, [title, desc]]) => `<section class="panel"><h2>${title}</h2><p class="muted" style="margin:-8px 0 14px">${desc}</p><div class="grid">
        ${Object.entries(s).filter(([, d]) => d.group === g).map(([k, d]) => `<div class="field"><label for="${k}">${esc(d.label)} ${d.set ? '<span class="badge ok">configurado</span>' : ''}</label>
          <input id="${k}" name="${k}" ${d.secret ? 'type="password"' : ''} autocomplete="off" value="${esc(d.value)}" placeholder="${d.secret ? (d.set ? `${d.preview} — deixe em branco para manter` : 'não configurado') : ''}">
          ${d.secret && d.set ? `<label class="hint"><input type="checkbox" data-clear="${k}" style="width:auto"> remover este valor</label>` : ''}</div>`).join('')}
        </div></section>`).join('')}
        <div style="display:flex;gap:10px"><button class="btn primary" type="submit">${icon('check')} Salvar chaves</button>
        <button class="btn" type="button" id="test">${icon('refresh')} Salvar e sincronizar agora</button></div></form>`;

    const save = async () => {
      const body = {};
      for (const [k, d] of Object.entries(s)) {
        const el = root.querySelector(`#${k}`);
        const clear = root.querySelector(`[data-clear="${k}"]`)?.checked;
        if (clear) body[k] = '';
        else if (d.secret ? el.value.trim() : el.value.trim() !== d.value) body[k] = el.value.trim();
      }
      if (!Object.keys(body).length) return toast('Nada para salvar.');
      await api('/settings', { method: 'PUT', body });
      toast('Chaves salvas com segurança.', 'ok');
    };
    root.querySelector('#f').onsubmit = async (e) => { e.preventDefault(); try { await save(); this.render(root); } catch (err) { toast(err.message, 'err'); } };
    root.querySelector('#test').onclick = async () => {
      try {
        await save().catch(() => {});
        const r = await api('/sync', { method: 'POST' });
        toast(`Sincronização: ${r.ok ?? 0} ok · ${r.failed ?? 0} falhas`, r.failed ? 'err' : 'ok');
      } catch (err) { toast(err.message, 'err'); }
    };
  },
};
