import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const publicDir = path.resolve(__dirname, '../../services/web/public')

export interface MockServerOptions {
  port?: number
  userEmail?: string
}

export function createMockServer(options: MockServerOptions = {}) {
  const port = options.port || 3099
  const primaryEmail = options.userEmail || 'dangdoan2206@gmail.com'

  const emails: Array<{ email: string; default: boolean; confirmedAt: string | null }> = [
    { email: primaryEmail, default: true, confirmedAt: new Date().toISOString() },
  ]

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`)

    // Serve static assets from services/web/public
    if (url.pathname.startsWith('/stylesheets/') || url.pathname.startsWith('/fonts/') || url.pathname.startsWith('/img/')) {
      const filePath = path.join(publicDir, url.pathname)
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath)
        const mimeTypes: Record<string, string> = {
          '.css': 'text/css',
          '.js': 'application/javascript',
          '.png': 'image/png',
          '.svg': 'image/svg+xml',
          '.woff': 'font/woff',
          '.woff2': 'font/woff2',
        }
        res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' })
        fs.createReadStream(filePath).pipe(res)
        return
      }
    }

    // Handle JSON POST requests
    if (req.method === 'POST') {
      let body = ''
      req.on('data', chunk => {
        body += chunk
      })
      req.on('end', () => {
        let parsed: any = {}
        try {
          parsed = body ? JSON.parse(body) : {}
        } catch {
          const params = new URLSearchParams(body)
          parsed = Object.fromEntries(params.entries())
        }

        if (url.pathname === '/login') {
          res.writeHead(302, { Location: '/project' })
          res.end()
          return
        }

        if (url.pathname === '/user/emails/secondary') {
          const email = parsed.email
          if (!email) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'invalid_email' }))
            return
          }
          emails.push({ email, default: false, confirmedAt: new Date().toISOString() })
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, email }))
          return
        }

        if (url.pathname === '/user/emails/default') {
          const email = parsed.email
          for (const item of emails) {
            item.default = item.email === email
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true }))
          return
        }

        if (url.pathname === '/user/emails/delete') {
          const email = parsed.email
          const idx = emails.findIndex(item => item.email === email)
          if (idx !== -1) {
            emails.splice(idx, 1)
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true }))
          return
        }

        res.writeHead(404)
        res.end('Not Found')
      })
      return
    }

    if (req.method === 'GET') {
      if (url.pathname === '/login') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Log in - Overleaf</title>
  <link rel="stylesheet" href="/stylesheets/main-style-da02f072dbbe42c68c1e.css" />
  <style>
    body { background-color: #f7f9fa; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
    .login-box { max-width: 420px; margin: 4rem auto; background: #fff; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.06); padding: 2.5rem; }
  </style>
</head>
<body>
  <div class="login-box">
    <div class="text-center mb-4">
      <svg width="140" height="36" viewBox="0 0 140 36" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 24C8 19 8 11 14 5C20 11 20 19 16 24C14 26.5 13 26.5 12 24Z" fill="#138a07"/>
        <text x="28" y="24" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="20" font-weight="700" fill="#1e293b">Overleaf</text>
      </svg>
    </div>
    <h1 class="h4 mb-4 text-center fw-bold">Log in to Overleaf</h1>
    <form method="POST" action="/login">
      <div class="mb-3">
        <label class="form-label small fw-bold">Email</label>
        <input type="email" name="email" class="form-control" value="dangdoan2206@gmail.com" required />
      </div>
      <div class="mb-4">
        <label class="form-label small fw-bold">Password</label>
        <input type="password" name="password" class="form-control" value="password" required />
      </div>
      <button type="submit" class="btn btn-primary w-100 py-2 fw-semibold">Log in</button>
    </form>
  </div>
</body>
</html>`)
        return
      }

      if (url.pathname === '/project') {
        res.writeHead(302, { Location: '/user/settings' })
        res.end()
        return
      }

      if (url.pathname === '/user/settings') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Account Settings - Overleaf, Online LaTeX Editor</title>
  <link rel="stylesheet" href="/stylesheets/main-style-da02f072dbbe42c68c1e.css" />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Source+Sans+Pro:wght@400;600;700&display=swap" />
  <style>
    body {
      background-color: #f7f9fa;
      font-family: "Source Sans Pro", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      color: #1e293b;
      margin: 0;
      padding: 0;
    }
    .navbar-main {
      background: #ffffff;
      border-bottom: 1px solid #e2e8f0;
      height: 60px;
      padding: 0 1.5rem;
    }
    .page-content-card {
      background: #ffffff;
      border-radius: 8px;
      border: 1px solid #e2e8f0;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
      padding: 2.5rem;
      margin-top: 2rem;
      margin-bottom: 4rem;
    }
    .page-header h1 {
      font-size: 1.75rem;
      font-weight: 700;
      color: #0f172a;
      margin-bottom: 1.5rem;
      border-bottom: 1px solid #e2e8f0;
      padding-bottom: 1rem;
    }
    .email-table-header {
      padding: 0.6rem 0;
      border-bottom: 2px solid #e2e8f0;
      font-weight: 700;
      color: #475569;
      font-size: 0.875rem;
    }
    .email-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.85rem 0;
      border-bottom: 1px solid #f1f5f9;
    }
    .affiliations-table-row-highlighted {
      background-color: #f0f7ff;
      border-left: 4px solid #0d6efd;
      border-radius: 4px;
      padding: 1rem;
      margin: 0.75rem 0;
    }
    .badge-primary-custom {
      background-color: #0284c7;
      color: #ffffff;
      font-weight: 600;
      font-size: 0.75rem;
      padding: 0.25rem 0.6rem;
      border-radius: 4px;
    }
    .btn-action {
      font-size: 0.8125rem;
      font-weight: 600;
      padding: 0.35rem 0.75rem;
      border-radius: 4px;
    }
    .btn-trash {
      color: #dc2626;
      background: transparent;
      border: 1px solid transparent;
      padding: 0.35rem 0.5rem;
      border-radius: 4px;
      cursor: pointer;
    }
    .btn-trash:hover {
      background-color: #fee2e2;
    }
    .modal-backdrop-custom {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(15, 23, 42, 0.45);
      backdrop-filter: blur(2px);
      z-index: 1040;
    }
    .modal-dialog-custom {
      position: fixed;
      top: 25%;
      left: 50%;
      transform: translateX(-50%);
      background: #ffffff;
      border-radius: 8px;
      padding: 1.75rem;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.15), 0 8px 10px -6px rgba(0, 0, 0, 0.1);
      z-index: 1050;
      width: 100%;
      max-width: 480px;
    }
    .hidden { display: none !important; }
  </style>
</head>
<body>
  <!-- Official Overleaf Top Navbar -->
  <header class="navbar navbar-main d-flex align-items-center justify-content-between">
    <div class="d-flex align-items-center gap-4">
      <a href="/project" class="d-flex align-items-center text-decoration-none">
        <svg width="125" height="30" viewBox="0 0 125 30" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 21C8 16 8 9 14 4C20 9 20 16 16 21C14 23.5 13 23.5 12 21Z" fill="#138a07"/>
          <text x="26" y="21" font-family="'Source Sans Pro', sans-serif" font-size="20" font-weight="700" fill="#0f172a">Overleaf</text>
        </svg>
      </a>
      <nav class="d-none d-md-flex gap-3 ms-2">
        <a href="/project" class="nav-link text-secondary fw-semibold">Projects</a>
        <a href="/templates" class="nav-link text-secondary fw-semibold">Templates</a>
      </nav>
    </div>
    <div class="d-flex align-items-center gap-3">
      <a href="/learn" class="nav-link text-secondary fw-semibold d-none d-sm-block">Help</a>
      <div class="d-flex align-items-center gap-2">
        <div style="width: 28px; height: 28px; background-color: #138a07; color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: bold;">
          D
        </div>
        <span class="small fw-semibold text-dark">dangdoan2206@gmail.com</span>
      </div>
    </div>
  </header>

  <!-- Page Content Container -->
  <main class="container">
    <div class="row justify-content-center">
      <div class="col-xl-10">
        <div class="page-content-card">
          <div class="page-header">
            <h1>Account Settings</h1>
          </div>

          <!-- Section: Emails -->
          <section class="mb-5">
            <h2 class="h4 fw-bold mb-1" style="color: #0f172a;">Emails</h2>
            <p class="small text-muted mb-3">
              Add additional email addresses to your account to make sure you can recover your account and collaborators can find you.
            </p>

            <!-- Table Header -->
            <div class="row email-table-header d-none d-sm-flex">
              <div class="col-8"><strong>Email</strong></div>
              <div class="col-4 text-end"><strong>Actions</strong></div>
            </div>

            <!-- Email Rows -->
            <div id="emails-list"></div>

            <!-- Add Email Form & Action Button -->
            <div id="add-email-container" class="mt-3">
              <button id="add-another-btn" class="btn btn-link text-decoration-none p-0 fw-semibold" style="color: #0284c7;" onclick="showAddForm()">
                + Add another email
              </button>

              <div id="add-form" class="hidden affiliations-table-row-highlighted">
                <div class="row align-items-center g-2">
                  <div class="col-lg-8 col-sm-12">
                    <label for="simple-secondary-email-input" class="form-label small fw-bold text-muted mb-1">Email Address</label>
                    <input
                      type="email"
                      id="simple-secondary-email-input"
                      class="form-control form-control-sm"
                      placeholder="name@example.com"
                      style="border-color: #cbd5e1;"
                    />
                  </div>
                  <div class="col-lg-4 col-sm-12 text-lg-end d-flex gap-2 justify-content-lg-end pt-sm-2 pt-lg-4">
                    <button class="btn btn-primary btn-action" onclick="submitAddEmail()">Add email</button>
                    <button class="btn btn-outline-secondary btn-action" onclick="hideAddForm()">Cancel</button>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <!-- Section: Account Information & Password (side-by-side like official Overleaf) -->
          <section class="border-top pt-4 mb-5">
            <div class="row">
              <div class="col-lg-5 mb-4 mb-lg-0">
                <h3 class="h5 fw-bold mb-3">Account Information</h3>
                <div class="mb-3">
                  <label class="form-label small text-muted">First Name</label>
                  <input type="text" class="form-control" value="Dang" readonly style="background-color: #f8fafc;" />
                </div>
                <div class="mb-3">
                  <label class="form-label small text-muted">Last Name</label>
                  <input type="text" class="form-control" value="Doan" readonly style="background-color: #f8fafc;" />
                </div>
              </div>

              <div class="col-lg-5 offset-lg-1">
                <h3 class="h5 fw-bold mb-3">Password</h3>
                <div class="mb-3">
                  <label class="form-label small text-muted">Current Password</label>
                  <input type="password" class="form-control" placeholder="••••••••••••" readonly style="background-color: #f8fafc;" />
                </div>
                <div class="mb-3">
                  <label class="form-label small text-muted">New Password</label>
                  <input type="password" class="form-control" placeholder="Enter new password" readonly style="background-color: #f8fafc;" />
                </div>
                <button class="btn btn-outline-primary btn-sm" disabled>Change password</button>
              </div>
            </div>
          </section>

          <!-- Section: Two-Factor Authentication -->
          <section class="border-top pt-4">
            <h3 class="h5 fw-bold mb-2">Two-Factor Authentication</h3>
            <p class="small text-muted mb-3">
              Add an additional layer of security to your account by requiring more than just your password to log in.
            </p>
            <button class="btn btn-outline-secondary btn-sm fw-semibold">Enable two-factor authentication</button>
          </section>
        </div>
      </div>
    </div>
  </main>

  <!-- Modal Dialog for Primary Confirmation -->
  <div id="confirm-modal-backdrop" class="modal-backdrop-custom hidden"></div>
  <div id="confirm-modal" class="modal-dialog-custom hidden" role="dialog" aria-modal="true">
    <div class="modal-dialog">
      <div class="modal-content border-0">
        <h3 class="h5 fw-bold mb-3">Confirm Primary Email Change</h3>
        <p class="small text-muted mb-4">
          Are you sure you want to change your primary email address to <strong id="modal-target-email" class="text-dark"></strong>?
          Your current primary email address will remain as a secondary email.
        </p>
        <div class="d-flex gap-2 justify-content-end">
          <button class="btn btn-outline-secondary btn-sm" onclick="hideModal()">Cancel</button>
          <button class="btn btn-primary btn-sm" onclick="confirmMakePrimary()">Change primary email</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    let emails = ${JSON.stringify(emails)};
    let emailToPromote = '';

    function renderEmails() {
      const list = document.getElementById('emails-list');
      list.innerHTML = '';
      emails.forEach(item => {
        const row = document.createElement('div');
        row.className = 'row align-items-center py-3 border-bottom';
        row.setAttribute('data-testid', 'simple-email-row');

        let emailCol = '<div class="col-8 d-flex align-items-center gap-2">';
        emailCol += '<span class="fw-semibold text-dark">' + item.email + '</span>';
        if (item.default) {
          emailCol += '<span class="badge bg-info text-white" style="font-size: 0.75rem; padding: 0.35em 0.65em;">Primary</span>';
        }
        if (!item.confirmedAt) {
          emailCol += '<span class="text-muted small ms-1">(Unconfirmed)</span>';
        }
        emailCol += '</div>';

        let actionsCol = '<div class="col-4 text-end d-flex align-items-center justify-content-end gap-2">';
        if (!item.default) {
          actionsCol += '<button class="btn btn-secondary btn-sm" onclick="promptMakePrimary(\\'' + item.email + '\\')">Make primary</button>';
          actionsCol += '<button class="btn btn-outline-danger btn-sm d-inline-flex align-items-center p-1" aria-label="Remove" title="Remove email" onclick="deleteEmail(\\'' + item.email + '\\')">' +
            '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<polyline points="3 6 5 6 21 6"></polyline>' +
            '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>' +
            '</svg></button>';
        } else {
          actionsCol += '<button class="btn btn-link text-muted btn-sm p-1" disabled aria-label="Remove" title="Please change primary to remove">' +
            '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<polyline points="3 6 5 6 21 6"></polyline>' +
            '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>' +
            '</svg></button>';
        }
        actionsCol += '</div>';

        row.innerHTML = emailCol + actionsCol;
        list.appendChild(row);
      });
    }

    function showAddForm() {
      document.getElementById('add-form').classList.remove('hidden');
      document.getElementById('add-another-btn').classList.add('hidden');
      document.getElementById('simple-secondary-email-input').focus();
    }

    function hideAddForm() {
      document.getElementById('add-form').classList.add('hidden');
      document.getElementById('add-another-btn').classList.remove('hidden');
      document.getElementById('simple-secondary-email-input').value = '';
    }

    async function submitAddEmail() {
      const email = document.getElementById('simple-secondary-email-input').value.trim();
      if (!email) return;
      const res = await fetch('/user/emails/secondary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      if (res.ok) {
        emails.push({ email, default: false, confirmedAt: new Date().toISOString() });
        hideAddForm();
        renderEmails();
      }
    }

    function promptMakePrimary(email) {
      emailToPromote = email;
      document.getElementById('modal-target-email').textContent = email;
      document.getElementById('confirm-modal').classList.remove('hidden');
      document.getElementById('confirm-modal-backdrop').classList.remove('hidden');
    }

    function hideModal() {
      document.getElementById('confirm-modal').classList.add('hidden');
      document.getElementById('confirm-modal-backdrop').classList.add('hidden');
      emailToPromote = '';
    }

    async function confirmMakePrimary() {
      if (!emailToPromote) return;
      const res = await fetch('/user/emails/default?delete-unconfirmed-primary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailToPromote })
      });
      if (res.ok) {
        for (const item of emails) {
          item.default = item.email === emailToPromote;
        }
        hideModal();
        renderEmails();
      }
    }

    async function deleteEmail(email) {
      const res = await fetch('/user/emails/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      if (res.ok) {
        const idx = emails.findIndex(item => item.email === email);
        if (idx !== -1) {
          emails.splice(idx, 1);
        }
        renderEmails();
      }
    }

    renderEmails();
  </script>
</body>
</html>`)
        return
      }

      res.writeHead(404)
      res.end('Not Found')
    }
  })

  return {
    server,
    start: () =>
      new Promise<void>(resolve => {
        server.listen(port, () => {
          resolve()
        })
      }),
    stop: () =>
      new Promise<void>(resolve => {
        server.close(() => {
          resolve()
        })
      }),
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = parseInt(process.env.PORT || '3099', 10)
  const server = createMockServer({ port })
  server.start().then(() => {
    console.log(`Mock server listening on http://localhost:${port}`)
  })
}
