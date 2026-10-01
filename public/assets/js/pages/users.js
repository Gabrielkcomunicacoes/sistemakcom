import { api, esc, icon, toast, modal, dateTime, ROLES, state } from '../core.js';

function openForm(u, done) {
  const { el, close } = modal(`<h2>${u ? 'Editar usuário' : 'Novo usuário'}</h2>
    <form class="grid" id="f" novalidate autocomplete="off">
      <div class="field"><label>Nome</label><input id="name" required maxlength="80" value="${esc(u?.name ?? '')}"></div>
      <div class="field"><label>E-mail</label><input id="email" type="email" required ${u ? 'disabled' : ''} value="${esc(u?.email ?? '')}"></div>
      <div class="grid cols-2">
        <div class="field"><label>Perfil</label><select id="role">${Object.entries(ROLES).map(([k, v]) => `<option value="${k}" ${u?.role === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
          <span class="hint">Admin: tudo · Gestor: clientes e alertas · Visualização: só leitura · TV: só o monitor, sessão longa</span></div>
        <div class="field"><label>${u ? 'Redefinir senha (opcional)' : 'Senha inicial'}</label><input id="pw" type="password" autocomplete="new-password" maxlength="128">
          <span class="hint">Mín. 12 caracteres. O usuário troca no primeiro acesso.</span></div>
      </div>
      ${u ? `<label class="check"><input type="checkbox" id="active" ${u.active ? 'checked' : ''}> Usuário ativo</label>` : ''}
      <div class="actions"><button type="button" class="btn" data-x>Cancelar</button><button class="btn primary" type="submit">Salvar</button></div></form>`);
  el.querySelector('[data-x]').onclick = close;
  el.querySelector('#f').onsubmit = async (e) => {
    e.preventDefault();
    const body = { name: el.querySelector('#name').value, role: el.querySelector('#role').value, password: el.querySelector('#pw').value || undefined };
    try {
      if (u) await api(`/users/${u.id}`, { method: 'PUT', body: { ...body, active: el.querySelector('#active').checked } });
      else await api('/users', { method: 'POST', body: { ...body, email: el.querySelector('#email').value } });
      close(); toast('Usuário salvo.', 'ok'); done();
    } catch (err) { toast(err.message, 'err'); }
  };
}

export default {
  title: 'Usuários',
  async render(root) {
    const draw = async () => {
      let users, log;
      try { [users, log] = await Promise.all([api('/users'), api('/audit')]); } catch (e) { toast(e.message, 'err'); return; }
      root.innerHTML = `<div class="top"><div><h1>Usuários e segurança</h1><div class="sub">Controle de acesso e trilha de auditoria</div></div><div class="sp"></div>
        <button class="btn primary" id="new">${icon('plus')} Novo usuário</button></div>
        <div class="panel scroll-x" style="padding:6px;margin-bottom:18px"><table class="table"><thead><tr><th>Nome</th><th>Perfil</th><th>2FA</th><th>Último acesso</th><th class="act">Ações</th></tr></thead><tbody>
        ${users.map((u) => `<tr><td><b>${esc(u.name)}</b><br><small class="muted">${esc(u.email)}</small></td><td>${ROLES[u.role]}${u.active ? '' : ' <span class="badge critical">inativo</span>'}</td>
          <td>${u.has_2fa ? '<span class="badge ok">Ativo</span>' : '<span class="badge">Não</span>'}</td><td>${dateTime(u.last_login)}</td>
          <td class="act"><button class="btn sm ghost" data-unlock="${u.id}">Desbloquear</button> <button class="btn sm ghost" data-edit="${u.id}">${icon('edit')} Editar</button></td></tr>`).join('')}
        </tbody></table></div>
        <div class="panel"><h2>Auditoria (últimos 200 eventos)</h2><div class="scroll-x" style="max-height:420px;overflow:auto"><table class="table"><thead><tr><th>Quando</th><th>Usuário</th><th>Ação</th><th>Detalhe</th><th>IP</th></tr></thead><tbody>
        ${log.map((l) => `<tr><td>${dateTime(l.ts)}</td><td>${esc(l.user_name ?? '—')}</td><td><span class="badge ${/fail|blocked/.test(l.action) ? 'critical' : ''}">${esc(l.action)}</span></td><td class="muted">${esc(l.detail)}</td><td class="mono muted">${esc(l.ip ?? '')}</td></tr>`).join('')}
        </tbody></table></div></div>`;
      root.querySelector('#new').onclick = () => openForm(null, draw);
      root.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => openForm(users.find((u) => u.id === +b.dataset.edit), draw); });
      root.querySelectorAll('[data-unlock]').forEach((b) => { b.onclick = async () => { await api(`/users/${b.dataset.unlock}/unlock`, { method: 'POST' }); toast('Conta desbloqueada.', 'ok'); }; });
    };
    draw();
  },
};
