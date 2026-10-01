import { api, esc, icon, toast, state, ROLES } from '../core.js';

function strength(pw) {
  let s = 0;
  if (pw.length >= 12) s++; if (pw.length >= 16) s++;
  s += [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length >= 3 ? 1 : 0;
  if (/[^A-Za-z0-9]/.test(pw) && pw.length >= 12) s++;
  return s;
}

export default {
  title: 'Meu perfil',
  async render(root) {
    const u = state.user;
    root.innerHTML = `<div class="top"><div><h1>Meu perfil</h1><div class="sub">${esc(u.name)} · ${esc(u.email)} · ${ROLES[u.role]}</div></div></div>
      ${u.must_change ? '<div class="panel" style="border-color:var(--warn);margin-bottom:16px">⚠ Defina uma nova senha para continuar usando o painel.</div>' : ''}
      <div class="grid cols-2" style="align-items:start">
        <form class="panel grid" id="pw" autocomplete="off"><h2>Trocar senha</h2>
          <div class="field"><label>Senha atual</label><input id="cur" type="password" autocomplete="current-password" required></div>
          <div class="field"><label>Nova senha</label><input id="new" type="password" autocomplete="new-password" required maxlength="128"><div class="strength"><i id="bar"></i></div>
            <span class="hint">Mínimo 12 caracteres com 3 tipos (minúscula, maiúscula, número, símbolo).</span></div>
          <button class="btn primary" type="submit">Atualizar senha</button></form>
        <div class="panel grid" id="tfa"><h2>Autenticação em 2 fatores</h2><div id="tfa-body"></div></div>
      </div>
      <div class="panel" style="margin-top:16px"><h2>Aparência</h2><button class="btn" id="theme">${icon('sun')} Alternar tema claro/escuro</button></div>`;

    root.querySelector('#new').oninput = (e) => {
      const s = strength(e.target.value), bar = root.querySelector('#bar');
      bar.style.width = `${s * 25}%`; bar.style.background = ['var(--crit)', 'var(--crit)', 'var(--warn)', 'var(--ok)', 'var(--ok)'][s];
    };
    root.querySelector('#pw').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/auth/password', { method: 'POST', body: { current: root.querySelector('#cur').value, next: root.querySelector('#new').value } });
        toast('Senha atualizada.', 'ok'); state.user.must_change = false; setTimeout(() => { location.hash = '#/monitor'; location.reload(); }, 600);
      } catch (err) { toast(err.message, 'err'); }
    };
    root.querySelector('#theme').onclick = () => {
      const n = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      document.documentElement.dataset.theme = n;
      try { localStorage.setItem('kcom-theme', n); } catch { /* ignora */ }
    };

    const body = root.querySelector('#tfa-body');
    const showOff = () => {
      body.innerHTML = `<p class="muted">Adicione uma camada extra: além da senha, é pedido um código do Google Authenticator / Authy.</p>
        <button class="btn primary" id="on">${icon('shield')} Ativar 2FA</button>`;
      body.querySelector('#on').onclick = async () => {
        try {
          const { qr, secret } = await api('/auth/2fa/setup', { method: 'POST' });
          body.innerHTML = `<p class="muted">1. Escaneie o QR no aplicativo autenticador.</p><div class="qr"><img src="${qr}" width="200" height="200" alt="QR code 2FA"></div>
            <p class="muted">Ou digite a chave: <span class="mono">${esc(secret)}</span></p>
            <div class="field"><label>2. Código de 6 dígitos</label><input id="code" inputmode="numeric" maxlength="6" placeholder="000000"></div>
            <button class="btn primary" id="ok">Confirmar e ativar</button>`;
          body.querySelector('#ok').onclick = async () => {
            try { await api('/auth/2fa/enable', { method: 'POST', body: { code: body.querySelector('#code').value } }); toast('2FA ativado.', 'ok'); state.user.has_2fa = true; showOn(); }
            catch (e) { toast(e.message, 'err'); }
          };
        } catch (e) { toast(e.message, 'err'); }
      };
    };
    const showOn = () => {
      body.innerHTML = `<p><span class="badge ok">Ativo</span> Sua conta exige código do autenticador no login.</p>
        <div class="field"><label>Senha</label><input id="p" type="password" autocomplete="current-password"></div>
        <div class="field"><label>Código atual</label><input id="c" inputmode="numeric" maxlength="6"></div>
        <button class="btn danger" id="off">Desativar 2FA</button>`;
      body.querySelector('#off').onclick = async () => {
        try { await api('/auth/2fa/disable', { method: 'POST', body: { password: body.querySelector('#p').value, code: body.querySelector('#c').value } }); toast('2FA desativado.'); state.user.has_2fa = false; showOff(); }
        catch (e) { toast(e.message, 'err'); }
      };
    };
    (u.has_2fa ? showOn : showOff)();
  },
};
