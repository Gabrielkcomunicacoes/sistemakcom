const $ = (id) => document.getElementById(id);
const form = $('form'), err = $('err'), go = $('go');

$('toggle').addEventListener('click', () => {
  $('password').type = $('password').type === 'password' ? 'text' : 'password';
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.classList.add('hidden');
  go.disabled = true; go.textContent = 'Entrando…';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ email: $('email').value, password: $('password').value, code: $('code').value || undefined }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) { location.replace('/'); return; }
    if (data.code === '2fa_required') {
      $('codeField').classList.remove('hidden'); $('code').focus();
    }
    err.textContent = data.error || 'Não foi possível entrar.';
    err.classList.remove('hidden');
  } catch {
    err.textContent = 'Sem conexão com o servidor.';
    err.classList.remove('hidden');
  } finally {
    go.disabled = false; go.textContent = 'Entrar';
  }
});
