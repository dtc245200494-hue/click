document.getElementById('login-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = document.getElementById('login-error');
  error.textContent = '';
  const res = await fetch('/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: document.getElementById('username').value, password: document.getElementById('password').value })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { error.textContent = data.error || 'Đăng nhập thất bại.'; return; }
  location.href = '/';
});
