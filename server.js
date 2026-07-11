    async function register() {
      const email = document.getElementById('regEmail').value;
      const password = document.getElementById('regPass').value;
      const referralCode = document.getElementById('regCode').value || undefined;
      
      const res = await fetch(`${API}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, referralCode })
      });
      const data = await res.json();
      if (data.token) {
        token = data.token;
        localStorage.setItem('token', token);
        showAlert('Account created!', 'success');
        loadUser();
      } else {
        showAlert(data.error, 'error');
      }
    }
    
    async function login() {
      const email = document.getElementById('logEmail').value;
      const password = document.getElementById('logPass').value;
      
      const res = await fetch(`${API}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (data.token) {
        token = data.token;
        localStorage.setItem('token', token);
        showAlert('Signed in!', 'success');
        loadUser();
      } else {
        showAlert(data.error, 'error');
      }
    }
