const API = '/api';
let token = localStorage.getItem('token');
let currentWorkspace = null;
let currentPage = null;
let pages = [];

// Auth
function switchTab(tab) {
  document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
  event.target.classList.add('active');

  document.getElementById('login-form').classList.toggle('hidden', tab !== 'login');
  document.getElementById('register-form').classList.toggle('hidden', tab !== 'register');
  document.getElementById('auth-error').textContent = '';
}

async function register() {
  const email = document.getElementById('reg-email').value;
  const password = document.getElementById('reg-password').value;
  const referralCode = document.getElementById('reg-code').value || undefined;

  const res = await fetch(`${API}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, referralCode })
  });
  const data = await res.json();

  if (data.token) {
    token = data.token;
    localStorage.setItem('token', token);
    initApp();
  } else {
    document.getElementById('auth-error').textContent = data.error || 'Registration failed';
  }
}

async function login() {
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;

  const res = await fetch(`${API}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const data = await res.json();

  if (data.token) {
    token = data.token;
    localStorage.setItem('token', token);
    initApp();
  } else {
    document.getElementById('auth-error').textContent = data.error || 'Login failed';
  }
}

function logout() {
  token = null;
  localStorage.removeItem('token');
  location.reload();
}

// App
async function initApp() {
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('main-screen').classList.remove('hidden');

  const user = await fetch(`${API}/me`, {
    headers: { 'Authorization': `Bearer ${token}` }
  }).then(r => r.json());

  document.getElementById('user-email').textContent = user.email;
  const badge = document.getElementById('plan-badge');
  if (user.isPremium) {
    badge.textContent = 'Premium';
    badge.classList.add('premium');
  }

  const workspaces = await fetch(`${API}/workspaces`, {
    headers: { 'Authorization': `Bearer ${token}` }
  }).then(r => r.json());

  if (workspaces.length > 0) {
    currentWorkspace = workspaces[0];
    document.getElementById('workspace-name').textContent = currentWorkspace.name;
    await loadPages();
  }
}

async function loadPages() {
  pages = await fetch(`${API}/pages?workspace_id=${currentWorkspace.id}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  }).then(r => r.json());

  renderPageTree();

  if (pages.length > 0 && !currentPage) {
    openPage(pages[0].id);
  }
}

function renderPageTree() {
  const tree = document.getElementById('page-tree');
  tree.innerHTML = '';

  const rootPages = pages.filter(p => !p.parent_id);

  function renderPage(page, depth = 0) {
    const div = document.createElement('div');
    div.className = `page-item ${currentPage?.id === page.id ? 'active' : ''}`;
    div.style.paddingLeft = `${10 + depth * 16}px`;
    div.onclick = () => openPage(page.id);

    div.innerHTML = `
      <span class="icon">${page.icon || '📄'}</span>
      <span class="title">${page.title || 'Untitled'}</span>
    `;

    tree.appendChild(div);

    const children = pages.filter(p => p.parent_id === page.id);
    children.forEach(child => renderPage(child, depth + 1));
  }

  rootPages.forEach(page => renderPage(page));
}

async function openPage(pageId) {
  currentPage = pages.find(p => p.id === pageId);
  if (!currentPage) return;

  document.getElementById('page-icon').textContent = currentPage.icon || '📄';
  document.getElementById('page-title').textContent = currentPage.title || 'Untitled';

  renderPageTree();

  const blocks = await fetch(`${API}/blocks/${pageId}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  }).then(r => r.json());

  renderBlocks(blocks);
}

function renderBlocks(blocks) {
  const container = document.getElementById('blocks-container');
  container.innerHTML = '';

  blocks.forEach(block => {
    const div = document.createElement('div');
    div.className = 'block';
    div.dataset.id = block.id;
    div.innerHTML = `
      <div class="block-handle">⋮⋮</div>
      <div class="block-content" contenteditable="true" data-type="${block.type}">${block.content || ''}</div>
    `;

    const content = div.querySelector('.block-content');
    content.addEventListener('blur', () => saveBlock(block.id, content.innerHTML, block.type));
    content.addEventListener('keydown', (e) => handleBlockKeydown(e, block.id));

    container.appendChild(div);
  });
}

async function saveBlock(id, content, type) {
  await fetch(`${API}/blocks/${id}`, {
    method: 'PATCH',
    headers: { 
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ content, type })
  });
}

function handleBlockKeydown(e, blockId) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    addBlock();
  }
}

async function addBlock() {
  if (!currentPage) return;

  const res = await fetch(`${API}/blocks`, {
    method: 'POST',
    headers: { 
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ 
      page_id: currentPage.id, 
      type: 'text', 
      content: '',
      sort_order: document.querySelectorAll('.block').length
    })
  });

  const block = await res.json();

  const container = document.getElementById('blocks-container');
  const div = document.createElement('div');
  div.className = 'block';
  div.dataset.id = block.id;
  div.innerHTML = `
    <div class="block-handle">⋮⋮</div>
    <div class="block-content" contenteditable="true" data-type="text"></div>
  `;

  const content = div.querySelector('.block-content');
  content.addEventListener('blur', () => saveBlock(block.id, content.innerHTML, 'text'));
  content.addEventListener('keydown', (e) => handleBlockKeydown(e, block.id));

  container.appendChild(div);
  content.focus();
}

async function createPage() {
  if (!currentWorkspace) return;

  const res = await fetch(`${API}/pages`, {
    method: 'POST',
    headers: { 
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ 
      workspace_id: currentWorkspace.id,
      title: 'New Page',
      icon: '📄'
    })
  });

  const page = await res.json();
  pages.push(page);
  renderPageTree();
  openPage(page.id);
}

// Title editing
document.getElementById('page-title').addEventListener('blur', async () => {
  if (!currentPage) return;
  const title = document.getElementById('page-title').textContent;
  await fetch(`${API}/pages/${currentPage.id}`, {
    method: 'PATCH',
    headers: { 
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ title })
  });
  currentPage.title = title;
  renderPageTree();
});

document.getElementById('page-icon').addEventListener('blur', async () => {
  if (!currentPage) return;
  const icon = document.getElementById('page-icon').textContent;
  await fetch(`${API}/pages/${currentPage.id}`, {
    method: 'PATCH',
    headers: { 
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ icon })
  });
  currentPage.icon = icon;
  renderPageTree();
});

// Init
if (token) {
  initApp();
} else {
  const urlParams = new URLSearchParams(window.location.search);
  const ref = urlParams.get('ref');
  if (ref) document.getElementById('reg-code').value = ref;
}
