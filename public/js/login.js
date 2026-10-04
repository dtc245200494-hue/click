document.addEventListener('DOMContentLoaded', () => {
    const loginForm = document.getElementById('login-form');
    const usernameInput = document.getElementById('username');
    const passwordInput = document.getElementById('password');
    const rememberMeCheck = document.getElementById('remember-me');
    const errorBox = document.getElementById('error-box') || document.getElementById('error-msg');
    const errorText = document.getElementById('error-text');
    const loginBtn = document.getElementById('login-btn');
    const loginIcon = document.getElementById('login-icon');
    const loginText = document.getElementById('login-text');

    if (!loginForm) return;

    // Remember only the username. Never persist plaintext passwords in browser storage.
    try {
        const savedUser = localStorage.getItem('tcs_remember_user');
        localStorage.removeItem('tcs_remember_pass');
        if (savedUser) {
            if (usernameInput) usernameInput.value = savedUser;
            if (rememberMeCheck) rememberMeCheck.checked = true;
        }
    } catch (e) {}

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        if (errorBox) errorBox.style.display = 'none';

        const username = usernameInput ? usernameInput.value.trim() : '';
        const password = passwordInput ? passwordInput.value : '';
        const rememberMe = rememberMeCheck ? rememberMeCheck.checked : false;

        if (!username || !password) {
            showError('Vui lòng nhập đầy đủ tài khoản và mật khẩu.');
            return;
        }

        // Set loading UI
        if (loginBtn) loginBtn.disabled = true;
        if (loginIcon) loginIcon.className = 'fa-solid fa-spinner fa-spin';
        if (loginText) loginText.textContent = 'Đang xác thực...';

        try {
            const response = await fetch('/api/login', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ username, password, rememberMe })
            });

            const data = await response.json();

            if (response.ok && data.success) {
                // Remember only the username; the session cookie handles authentication.
                try {
                    localStorage.removeItem('tcs_remember_pass');
                    if (rememberMe) localStorage.setItem('tcs_remember_user', username);
                    else localStorage.removeItem('tcs_remember_user');
                } catch (e) {}

                window.location.href = '/';
            } else {
                showError(data.message || 'Tài khoản hoặc mật khẩu không chính xác.');
            }
        } catch (error) {
            console.error('Error logging in:', error);
            showError('Không thể kết nối đến máy chủ. Vui lòng thử lại sau.');
        }
    });

    function showError(message) {
        if (errorText) errorText.textContent = message;
        if (errorBox) {
            errorBox.style.display = 'flex';
            errorBox.classList.remove('shake');
            void errorBox.offsetWidth;
            errorBox.classList.add('shake');
        }
        if (loginBtn) loginBtn.disabled = false;
        if (loginIcon) loginIcon.className = 'fa-solid fa-right-to-bracket';
        if (loginText) loginText.textContent = 'Đăng nhập hệ thống';
    }
});

