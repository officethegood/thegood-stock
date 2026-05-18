// shared/ui.js
// Toast + confirm modal helpers (Bootstrap 5).

(function () {
  function ensureToastContainer() {
    let c = document.getElementById('toast-container');
    if (!c) {
      c = document.createElement('div');
      c.id = 'toast-container';
      c.className = 'toast-container position-fixed top-0 end-0 p-3';
      c.style.zIndex = '11000';
      document.body.appendChild(c);
    }
    return c;
  }

  function showToast(type, message, opts) {
    const c = ensureToastContainer();
    const id = 'toast-' + Math.random().toString(36).slice(2, 9);
    const cls = type === 'success' ? 'text-bg-success'
              : type === 'error'   ? 'text-bg-danger'
              : type === 'warning' ? 'text-bg-warning'
              : 'text-bg-info';
    const html = `
      <div id="${id}" class="toast ${cls}" role="alert" aria-live="assertive">
        <div class="d-flex">
          <div class="toast-body">${escapeHtml(message)}</div>
          <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
        </div>
      </div>`;
    c.insertAdjacentHTML('beforeend', html);
    const el = document.getElementById(id);
    const t  = new bootstrap.Toast(el, { delay: opts?.delay ?? 4000 });
    t.show();
    el.addEventListener('hidden.bs.toast', () => el.remove());
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function showConfirm(message) {
    return new Promise((resolve) => {
      const id = 'confirm-' + Math.random().toString(36).slice(2, 9);
      const html = `
        <div class="modal fade" id="${id}" tabindex="-1">
          <div class="modal-dialog modal-dialog-centered">
            <div class="modal-content">
              <div class="modal-body py-4 text-center">
                <p class="mb-3">${escapeHtml(message)}</p>
                <button class="btn btn-secondary me-2" data-act="no">ยกเลิก</button>
                <button class="btn btn-danger" data-act="yes">ยืนยัน</button>
              </div>
            </div>
          </div>
        </div>`;
      document.body.insertAdjacentHTML('beforeend', html);
      const el = document.getElementById(id);
      const m  = new bootstrap.Modal(el);
      el.querySelector('[data-act="yes"]').onclick = () => { resolve(true);  m.hide(); };
      el.querySelector('[data-act="no"]').onclick  = () => { resolve(false); m.hide(); };
      el.addEventListener('hidden.bs.modal', () => el.remove());
      m.show();
    });
  }

  window.showToast    = showToast;
  window.showConfirm  = showConfirm;
  window.escapeHtml   = escapeHtml;
})();
