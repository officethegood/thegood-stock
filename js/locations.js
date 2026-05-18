// js/locations.js

(function () {
  let _all = [];

  async function load() {
    const sb = getSupabaseClient();
    const { data, error } = await sb.from('locations')
      .select('id,code,name,type,parent_id,ambulance_id,qr_payload,active,note')
      .order('type').order('code');
    if (error) throw error;
    _all = data;
  }

  function byParent() {
    const map = new Map();
    for (const l of _all) {
      const k = l.parent_id || '__root__';
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(l);
    }
    return map;
  }

  function iconForType(t) {
    return t === 'room'      ? '🏠'
         : t === 'cabinet'   ? '📦'
         : t === 'shelf'     ? '🪜'
         : t === 'ambulance' ? '🚑'
         : t === 'bag'       ? '🎒' : '•';
  }

  function renderTree() {
    const map = byParent();
    const root = document.getElementById('loc-tree');
    function renderList(parentKey, depth) {
      const items = map.get(parentKey) || [];
      return items.map((l) => {
        const children = renderList(l.id, depth + 1);
        const isInactive = !l.active;
        return `
          <div class="d-flex align-items-center py-1" style="padding-left:${depth * 24}px;">
            <span class="me-2">${iconForType(l.type)}</span>
            <code class="me-2 small">${escapeHtml(l.code)}</code>
            <span class="${isInactive ? 'text-muted text-decoration-line-through' : ''}">${escapeHtml(l.name)}</span>
            <span class="ms-auto">
              <button class="btn btn-sm btn-link" data-act="edit" data-id="${l.id}"><i class="bi bi-pencil"></i></button>
              <button class="btn btn-sm btn-link text-danger" data-act="del" data-id="${l.id}"><i class="bi bi-trash"></i></button>
            </span>
          </div>
          ${children}
        `;
      }).join('');
    }
    root.innerHTML = renderList('__root__', 0) || '<p class="text-muted">ยังไม่มี Location — กด "เพิ่มใหม่"</p>';

    root.querySelectorAll('[data-act]').forEach((btn) => {
      const id = btn.dataset.id;
      if (btn.dataset.act === 'edit') btn.onclick = () => openModal(id);
      if (btn.dataset.act === 'del')  btn.onclick = () => handleDelete(id);
    });
  }

  function sanitizePlate(p) { return String(p || '').replace(/[^\w-ก-๙]/g, '').toUpperCase(); }

  async function generateCode(type, parentId, ambulanceId) {
    const sb = getSupabaseClient();

    if (type === 'room') {
      const { data } = await sb.from('locations').select('code').eq('type', 'room');
      const taken = new Set((data || []).map((r) => r.code));
      for (let i = 0; i < 26; i++) {
        const letter = String.fromCharCode(65 + i);
        if (!taken.has(`ROOM-${letter}`)) return `ROOM-${letter}`;
      }
      return `ROOM-${Date.now()}`;
    }

    if (type === 'cabinet' || type === 'shelf') {
      const parent = _all.find((x) => x.id === parentId);
      if (!parent) return '';
      const parentSuffix = parent.code.replace(/^(ROOM|CAB)-/, '');
      const prefix = type === 'cabinet' ? `CAB-${parentSuffix}-` : `SHELF-${parentSuffix}-T`;
      const { data } = await sb.from('locations').select('code').like('code', prefix + '%');
      const nums = (data || [])
        .map((r) => Number(r.code.slice(prefix.length)))
        .filter((n) => !isNaN(n));
      const next = (nums.length ? Math.max(...nums) : 0) + 1;
      return prefix + next;
    }

    if (type === 'ambulance') {
      const amb = ambulanceId ? await sb.from('ambulances').select('plate').eq('id', ambulanceId).maybeSingle() : null;
      if (amb?.data?.plate) return 'AMB-' + sanitizePlate(amb.data.plate);
      return 'AMB-' + Date.now();
    }

    if (type === 'bag') {
      const { data } = await sb.from('locations').select('code').like('code', 'BAG-ALS-%');
      const nums = (data || [])
        .map((r) => Number(r.code.slice('BAG-ALS-'.length)))
        .filter((n) => !isNaN(n));
      const next = (nums.length ? Math.max(...nums) : 0) + 1;
      return 'BAG-ALS-' + String(next).padStart(3, '0');
    }

    return '';
  }

  function openModal(id) {
    const isEdit = !!id;
    const row    = isEdit ? _all.find((x) => x.id === id) : null;

    const modalHtml = `
      <div class="modal fade" id="loc-modal" tabindex="-1">
        <div class="modal-dialog">
          <div class="modal-content">
            <form id="loc-form">
              <div class="modal-header">
                <h5 class="modal-title">${isEdit ? 'แก้ไข Location' : 'เพิ่ม Location'}</h5>
                <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
              </div>
              <div class="modal-body">
                <div class="mb-2"><label class="form-label">Type</label>
                  <select id="f-type" class="form-select" ${isEdit ? 'disabled' : ''} required>
                    <option value="room">🏠 Room</option>
                    <option value="cabinet">📦 Cabinet</option>
                    <option value="shelf">🪜 Shelf</option>
                    <option value="ambulance">🚑 Ambulance</option>
                    <option value="bag">🎒 Bag (ALS)</option>
                  </select>
                </div>
                <div class="mb-2" id="parent-row"><label class="form-label">Parent</label>
                  <select id="f-parent" class="form-select"><option value="">(ไม่มี)</option></select>
                </div>
                <div class="mb-2 d-none" id="ambulance-row"><label class="form-label">Ambulance</label>
                  <select id="f-ambulance" class="form-select"><option value="">(เลือก)</option></select>
                </div>
                <div class="mb-2"><label class="form-label">Code</label>
                  <div class="input-group">
                    <input id="f-code" class="form-control" required>
                    <button type="button" class="btn btn-outline-secondary" id="btn-gen-code"><i class="bi bi-shuffle"></i> Generate</button>
                  </div>
                </div>
                <div class="mb-2"><label class="form-label">ชื่อ</label>
                  <input id="f-name" class="form-control" required>
                </div>
                <div class="mb-2"><label class="form-label">QR payload</label>
                  <input id="f-qr" class="form-control" placeholder="(default = Code)">
                </div>
                <div class="mb-2"><label class="form-label">Note</label>
                  <textarea id="f-note" class="form-control" rows="2"></textarea>
                </div>
                <div class="form-check">
                  <input type="checkbox" class="form-check-input" id="f-active" checked>
                  <label class="form-check-label" for="f-active">Active</label>
                </div>
              </div>
              <div class="modal-footer">
                <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">ยกเลิก</button>
                <button type="submit" class="btn btn-stock-primary">บันทึก</button>
              </div>
            </form>
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    const modalEl = document.getElementById('loc-modal');
    const modal   = new bootstrap.Modal(modalEl);
    modalEl.addEventListener('hidden.bs.modal', () => modalEl.remove());

    const fType   = document.getElementById('f-type');
    const fParent = document.getElementById('f-parent');
    const fAmbu   = document.getElementById('f-ambulance');

    function refreshParents() {
      const t = fType.value;
      const allowedParentTypes = t === 'cabinet' ? ['room']
                                : t === 'shelf'  ? ['cabinet']
                                : [];
      fParent.innerHTML = '<option value="">(ไม่มี)</option>' + _all
        .filter((l) => allowedParentTypes.includes(l.type))
        .map((l) => `<option value="${l.id}">${escapeHtml(l.code)} — ${escapeHtml(l.name)}</option>`)
        .join('');
      document.getElementById('parent-row').classList.toggle('d-none', allowedParentTypes.length === 0);
      document.getElementById('ambulance-row').classList.toggle('d-none', t !== 'ambulance');
    }

    async function refreshAmbulances() {
      const sb = getSupabaseClient();
      const { data } = await sb.from('ambulances').select('id,plate,callsign').eq('active', true).order('plate');
      fAmbu.innerHTML = '<option value="">(เลือก)</option>' +
        (data || []).map((a) => `<option value="${a.id}">${escapeHtml(a.plate)} ${a.callsign ? '— ' + escapeHtml(a.callsign) : ''}</option>`).join('');
    }

    fType.onchange = refreshParents;
    refreshParents();
    refreshAmbulances();

    document.getElementById('btn-gen-code').onclick = async () => {
      const code = await generateCode(fType.value, fParent.value || null, fAmbu.value || null);
      document.getElementById('f-code').value = code;
    };

    if (isEdit && row) {
      fType.value = row.type;
      refreshParents();
      if (row.parent_id) fParent.value = row.parent_id;
      if (row.ambulance_id) {
        setTimeout(() => { fAmbu.value = row.ambulance_id; }, 200);
      }
      document.getElementById('f-code').value = row.code;
      document.getElementById('f-name').value = row.name;
      document.getElementById('f-qr').value   = row.qr_payload || '';
      document.getElementById('f-note').value = row.note || '';
      document.getElementById('f-active').checked = !!row.active;
    }

    document.getElementById('loc-form').onsubmit = async (ev) => {
      ev.preventDefault();
      const payload = {
        type:        fType.value,
        parent_id:   fParent.value || null,
        ambulance_id:fType.value === 'ambulance' ? (fAmbu.value || null) : null,
        code:        document.getElementById('f-code').value.trim(),
        name:        document.getElementById('f-name').value.trim(),
        qr_payload:  document.getElementById('f-qr').value.trim() || document.getElementById('f-code').value.trim(),
        note:        document.getElementById('f-note').value.trim() || null,
        active:      document.getElementById('f-active').checked,
      };
      const sb = getSupabaseClient();
      const q = isEdit
        ? sb.from('locations').update(payload).eq('id', id)
        : sb.from('locations').insert(payload);
      const { error } = await q;
      if (error) {
        if (error.code === '23505') showToast('error', 'รหัสซ้ำ');
        else if (error.code === '23514') showToast('error', 'Ambulance type ต้องเลือก Ambulance');
        else showToast('error', error.message);
        return;
      }
      modal.hide();
      await load(); renderTree();
      showToast('success', isEdit ? 'อัปเดตแล้ว' : 'เพิ่มแล้ว');
    };

    modal.show();
  }

  async function handleDelete(id) {
    const ok = await showConfirm('ลบ Location นี้?');
    if (!ok) return;
    const sb = getSupabaseClient();
    const { error } = await sb.from('locations').delete().eq('id', id);
    if (error) {
      if (error.code === '23503') showToast('error', 'ไม่สามารถลบได้ เพราะมีรายการลูกอยู่');
      else showToast('error', error.message);
      return;
    }
    await load(); renderTree();
    showToast('success', 'ลบแล้ว');
  }

  window.initLocationsTab = async function () {
    const root = document.getElementById('tab-locations');
    root.innerHTML = `
      <div class="d-flex align-items-center mb-2">
        <h5 class="mb-0 me-auto"><i class="bi bi-geo-alt"></i> สถานที่จัดเก็บ</h5>
        <button class="btn btn-stock-primary" id="btn-loc-new"><i class="bi bi-plus"></i> เพิ่มใหม่</button>
      </div>
      <div class="card"><div class="card-body" id="loc-tree">กำลังโหลด…</div></div>
    `;
    document.getElementById('btn-loc-new').onclick = () => openModal(null);
    try { await load(); renderTree(); }
    catch (e) { showToast('error', e.message); }
  };
})();
