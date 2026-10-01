try {
  const t = localStorage.getItem('kcom-theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch { /* armazenamento indisponível */ }
