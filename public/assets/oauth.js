const $ = (id) => document.getElementById(id);
const p = new URLSearchParams(location.search).get('p') || '';
const form = $('form'), err = $('err'), go = $('go'), sub = $('sub');

function show(msg) { err.textContent = msg; err.classList.remove('hidden'); }

(async () => {
  try {
    const res = await fetch(`/oauth/pending?p=${encodeURIComponent(p)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { sub.textContent = data.error || 'Solicitação inválida.'; return; }
    sub.textContent = `“${data.client_name}” quer ler os dados de campanhas (somente leitura). Entre com seu usuário do painel para autorizar.`;
    form.classList.remove('hidden');
  } catch { sub.textContent = 'Sem conexão com o servidor.'; }
})();

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.classList.add('hidden');
  go.disabled = true; go.textContent = 'Autorizando…';
  try {
    const res = await fetch('/oauth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ p, email: $('email').value, password: $('password').value, code: $('code').value || undefined }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.redirect) { location.replace(data.redirect); return; }
    if (data.code === '2fa_required') { $('codeField').classList.remove('hidden'); $('code').focus(); }
    show(data.error || 'Não foi possível autorizar.');
  } catch { show('Sem conexão com o servidor.'); }
  finally { go.disabled = false; go.textContent = 'Entrar e autorizar'; }
});
