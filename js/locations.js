// js/locations.js — Phase 0.7
// Admin Locations tab: tree CRUD with expand/collapse, type-color badges,
// parent-rule validation (client-side + surface DB trigger errors),
// storage_style field, bin/zone code auto-suggest, breadcrumb column.
//
// Depends on: shared/locations.js (AppLocations helpers), shared/ui.js,
//             shared/supabase-client.js, shared/icons.js

(function () {
  // =========================================================================
  // State
  // =========================================================================
  let _all          = [];        // flat array from Supabase
  let _expanded     = new Set(); // set of expanded node ids
  let _unsubscribe  = null;      // realtime teardown
  let _refreshTimer = null;      // debounce handle

  // =========================================================================
  // Type metadata
  // =========================================================================

  /** Canonical display label for each type (cabinet rendered as storage). */
  function labelForType(t) {
    return t === 'room'      ? 'ห้อง'
         : t === 'storage'   ? 'ตู้/ชั้น'
         : t === 'cabinet'   ? 'ตู้/ชั้น'   // legacy alias
         : t === 'shelf'     ? 'ชั้นวาง'
         : t === 'bin'       ? 'ตะกร้า'
         : t === 'ambulance' ? 'รถพยาบาล'
         : t === 'bag'       ? 'กระเป๋า ALS'
         : t === 'zone'      ? 'โซน'
         : t;
  }

  /** Bootstrap-Icons class name for each type. */
  function iconClassForType(t) {
    return t === 'room'      ? 'bi bi-house'
         : t === 'storage'   ? 'bi bi-box'
         : t === 'cabinet'   ? 'bi bi-box'
         : t === 'shelf'     ? 'bi bi-list-columns-reverse'
         : t === 'bin'       ? 'bi bi-basket'
         : t === 'ambulance' ? 'bi bi-truck'
         : t === 'bag'       ? 'bi bi-bag-heart'
         : t === 'zone'      ? 'bi bi-grid-1x2'
         : 'bi bi-geo-alt';
  }

  /** FC badge modifier class for each type. */
  function badgeClassForType(t) {
    return t === 'room'      ? 'fc-badge-vital'
         : t === 'storage'   ? 'fc-badge-ok'
         : t === 'cabinet'   ? 'fc-badge-ok'
         : t === 'shelf'     ? 'fc-badge-caution'
         : t === 'bin'       ? 'fc-badge-warn'
         : t === 'ambulance' ? 'fc-badge-critical'
         : t === 'bag'       ? 'fc-badge-neutral'
         : t === 'zone'      ? 'fc-badge-neutral'
         : 'fc-badge-neutral';
  }

  // =========================================================================
  // Data load
  // =========================================================================
  async function load() {
    const sb = getSupabaseClient();
    const { data, error } = await sb
      .from('locations')
      .select('id,code,name,type,parent_id,ambulance_id,qr_payload,active,note,storage_style')
      .order('type')
      .order('code');
    if (error) throw error;
    _all = data;
  }

  // =========================================================================
  // Realtime
  // =========================================================================
  function _scheduleRealtimeReload() {
    if (_refreshTimer) clearTimeout(_refreshTimer);
    _refreshTimer = setTimeout(async () => {
      try { await load(); renderTree(); }
      catch (e) { console.warn('[locations] realtime reload failed', e); }
    }, 300);
  }

  function _subscribeRealtime() {
    if (_unsubscribe) return;
    try {
      const sb = getSupabaseClient();
      const channel = sb
        .channel('realtime:locations:phase07')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'locations' },
            () => _scheduleRealtimeReload())
        .subscribe();
      _unsubscribe = () => { try { sb.removeChannel(channel); } catch {} };
    } catch (e) {
      console.warn('[locations] realtime subscribe failed', e);
    }
  }

  // =========================================================================
  // Tree rendering
  // =========================================================================

  /** Return breadcrumb path string for a location (fast, from _all). */
  function pathFor(id) {
    return window.AppLocations
      ? window.AppLocations.getLocationPath(id, _all)
      : '';
  }

  /** Count direct children of a node. */
  function childCount(id) {
    return _all.filter((l) => l.parent_id === id).length;
  }

  function renderTree() {
    const tree = window.AppLocations
      ? window.AppLocations.getLocationTree(_all)
      : _fallbackFlatTree();

    const root = document.getElementById('loc-tree');
    if (!root) return;

    const html = _renderNodes(tree, 0);
    root.innerHTML = html || `<p class="text-muted small px-2 py-3">ยังไม่มีสถานที่ — กด "เพิ่มใหม่"</p>`;

    // Attach events
    root.querySelectorAll('[data-act]').forEach((btn) => {
      const id  = btn.dataset.id;
      const act = btn.dataset.act;
      if (act === 'toggle')  btn.onclick = () => _toggleExpand(id);
      if (act === 'add-child') btn.onclick = () => openModal(null, id);
      if (act === 'print')   btn.onclick = () => _printQR(id);
      if (act === 'edit')    btn.onclick = () => openModal(id);
      if (act === 'del')     btn.onclick = () => handleDelete(id);
    });
  }

  function _fallbackFlatTree() {
    // Fallback if shared/locations.js not loaded — build shallow tree inline
    const byId = new Map(_all.map((r) => [r.id, { ...r, children: [] }]));
    const roots = [];
    for (const n of byId.values()) {
      if (n.parent_id && byId.has(n.parent_id)) byId.get(n.parent_id).children.push(n);
      else roots.push(n);
    }
    return roots;
  }

  function _renderNodes(nodes, depth) {
    return nodes.map((l) => {
      const hasChildren = l.children && l.children.length > 0;
      const isExpanded  = _expanded.has(l.id);
      const isInactive  = !l.active;
      const indent      = depth * 20;

      // Display type: cabinet → storage for legacy rows
      const dispType = (l.type === 'cabinet') ? 'storage' : l.type;
      const badge = `<span class="fc-badge ${badgeClassForType(dispType)} ms-1" style="font-size:10px;padding:2px 7px;">
        <i class="${iconClassForType(dispType)}" style="font-size:10px;margin-right:2px;"></i>${labelForType(dispType)}
      </span>`;

      const storageHint = (dispType === 'storage' && l.storage_style)
        ? `<span class="text-muted small ms-2" style="font-size:10px;">(${_storageStyleLabel(l.storage_style)})</span>`
        : '';

      const breadcrumb = depth > 0
        ? `<span class="text-muted ms-2" style="font-size:10px;font-family:var(--fc-font-mono);">${escapeHtml(pathFor(l.id))}</span>`
        : '';

      const toggleBtn = hasChildren
        ? `<button class="btn btn-link p-0 me-1" data-act="toggle" data-id="${l.id}" aria-label="${isExpanded ? 'ซ่อนลูก' : 'แสดงลูก'}" style="min-width:24px;color:var(--fc-ink-soft);">
            <i class="bi ${isExpanded ? 'bi-chevron-down' : 'bi-chevron-right'}" style="font-size:12px;"></i>
          </button>`
        : `<span style="display:inline-block;width:24px;"></span>`;

      const codeHtml = `<code class="fc-mono me-2" style="font-size:11px;background:var(--fc-paper-sub);padding:1px 5px;border-radius:3px;">${escapeHtml(l.code)}</code>`;

      const nameHtml = `<span class="${isInactive ? 'text-muted text-decoration-line-through' : ''}" style="font-size:14px;">${escapeHtml(l.name)}</span>`;

      // Action buttons — "add child" only if type can have children
      const canHaveChildren = !['bin', 'zone'].includes(dispType);
      const addChildBtn = canHaveChildren
        ? `<button class="btn btn-link p-0 ms-1 text-muted" data-act="add-child" data-id="${l.id}" aria-label="เพิ่ม location ลูก" title="เพิ่ม location ภายใน" style="min-width:32px;min-height:32px;">
            <i class="bi bi-plus-circle" style="font-size:12px;"></i>
          </button>`
        : '';

      const row = `
        <div class="d-flex align-items-center py-1 loc-row" style="padding-left:${indent + 4}px;min-height:38px;" data-id="${l.id}">
          ${toggleBtn}
          ${codeHtml}
          ${nameHtml}
          ${badge}
          ${storageHint}
          ${breadcrumb}
          <span class="ms-auto d-flex align-items-center gap-1">
            ${addChildBtn}
            <button class="btn btn-link p-0 text-stock-accent" data-act="print" data-id="${l.id}" aria-label="พิมพ์ QR ${escapeHtml(l.code)}" title="พิมพ์ QR" style="min-width:32px;min-height:32px;"><i class="bi bi-printer" style="font-size:13px;"></i></button>
            <button class="btn btn-link p-0" data-act="edit" data-id="${l.id}" aria-label="แก้ไข" style="min-width:32px;min-height:32px;"><i class="bi bi-pencil" style="font-size:13px;"></i></button>
            <button class="btn btn-link p-0 text-danger" data-act="del" data-id="${l.id}" aria-label="ลบ" style="min-width:32px;min-height:32px;"><i class="bi bi-trash" style="font-size:13px;"></i></button>
          </span>
        </div>`;

      const childrenHtml = (hasChildren && isExpanded)
        ? `<div class="loc-children">${_renderNodes(l.children, depth + 1)}</div>`
        : (hasChildren && !isExpanded ? '' : '');

      return row + childrenHtml;
    }).join('');
  }

  function _storageStyleLabel(s) {
    return s === 'closed'  ? 'ตู้ปิด'
         : s === 'open'    ? 'ชั้นเปิด'
         : s === 'mesh'    ? 'ตะแกรง'
         : s === 'drawer'  ? 'ลิ้นชัก'
         : s;
  }

  function _toggleExpand(id) {
    if (_expanded.has(id)) _expanded.delete(id);
    else _expanded.add(id);
    renderTree();
  }

  // =========================================================================
  // QR Print helper
  // =========================================================================
  function _printQR(id) {
    const loc = _all.find((x) => x.id === id);
    if (!loc) return;
    const subtitle = pathFor(id);
    if (window.QRPrint) {
      window.QRPrint.single(loc.qr_payload || loc.code, {
        size:       '50x50',
        label:      loc.code,
        subtitle:   subtitle || loc.name,
        entityType: 'location',
      });
    } else {
      alert('โมดูล QR ยังไม่โหลด — รีเฟรชหน้าใหม่');
    }
  }

  // =========================================================================
  // Code generation
  // =========================================================================
  async function generateCode(type, parentId) {
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

    if (type === 'storage') {
      const parent = _all.find((x) => x.id === parentId);
      const parentSuffix = parent ? parent.code.replace(/^(ROOM|AMB|CAB)-/, '') : 'X';
      const prefix = `STG-${parentSuffix}-`;
      const { data } = await sb.from('locations').select('code').like('code', prefix + '%');
      const nums = (data || [])
        .map((r) => Number(r.code.slice(prefix.length)))
        .filter((n) => !isNaN(n));
      const next = (nums.length ? Math.max(...nums) : 0) + 1;
      return prefix + next;
    }

    if (type === 'shelf') {
      const parent = _all.find((x) => x.id === parentId);
      const parentSuffix = parent ? parent.code.replace(/^(STG|CAB)-/, '') : 'X';
      const prefix = `SHELF-${parentSuffix}-T`;
      const { data } = await sb.from('locations').select('code').like('code', prefix + '%');
      const nums = (data || [])
        .map((r) => Number(r.code.slice(prefix.length)))
        .filter((n) => !isNaN(n));
      const next = (nums.length ? Math.max(...nums) : 0) + 1;
      return prefix + next;
    }

    if (type === 'bin' || type === 'zone') {
      return window.AppLocations
        ? await window.AppLocations.nextCodeSuggestion(type, getSupabaseClient)
        : '';
    }

    if (type === 'ambulance') {
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

  // =========================================================================
  // Modal — create / edit
  // =========================================================================

  /**
   * @param {string|null} id     — null = create
   * @param {string|null} presetParentId — preset parent when clicking "+" on a row
   */
  function openModal(id, presetParentId) {
    const isEdit = !!id;
    const row    = isEdit ? _all.find((x) => x.id === id) : null;

    // Type options — cabinet excluded from UI (legacy only)
    const TYPE_OPTIONS = [
      { value: 'room',      label: 'ห้อง' },
      { value: 'storage',   label: 'ตู้/ชั้น (storage)' },
      { value: 'shelf',     label: 'ชั้นวาง (shelf)' },
      { value: 'bin',       label: 'ตะกร้า (bin)' },
      { value: 'ambulance', label: 'รถพยาบาล' },
      { value: 'bag',       label: 'กระเป๋า ALS (bag)' },
      { value: 'zone',      label: 'โซน (zone)' },
    ];

    const typeSelectOptions = TYPE_OPTIONS.map((o) => {
      // When editing, keep original type value (including cabinet for legacy rows)
      const val = (isEdit && row?.type === 'cabinet' && o.value === 'storage') ? 'cabinet' : o.value;
      return `<option value="${o.value}">${escapeHtml(o.label)}</option>`;
    }).join('');

    const modalHtml = `
      <div class="modal fade" id="loc-modal" tabindex="-1">
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content">
            <form id="loc-form" novalidate>
              <div class="modal-header">
                <h5 class="modal-title fc-display">${isEdit ? 'แก้ไขสถานที่' : 'เพิ่มสถานที่'}</h5>
                <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
              </div>
              <div class="modal-body">

                <!-- Type -->
                <div class="mb-3">
                  <label class="form-label fw-medium">ประเภท <span class="text-danger">*</span></label>
                  <select id="f-type" class="form-select" ${isEdit ? 'disabled' : ''} required>
                    ${typeSelectOptions}
                  </select>
                  <div id="type-rule-hint" class="form-text text-muted" style="font-size:11px;"></div>
                </div>

                <!-- Parent (cascade-filtered) -->
                <div class="mb-3" id="parent-row">
                  <label class="form-label fw-medium">Parent <span id="parent-required-star" class="text-danger d-none">*</span></label>
                  <select id="f-parent" class="form-select">
                    <option value="">(ไม่มี parent)</option>
                  </select>
                  <div id="parent-err" class="invalid-feedback">กรุณาเลือก parent ที่ถูกต้อง</div>
                </div>

                <!-- Code -->
                <div class="mb-3">
                  <label class="form-label fw-medium">รหัส (Code) <span class="text-danger">*</span></label>
                  <div class="input-group">
                    <input id="f-code" class="form-control fc-mono" required autocomplete="off" spellcheck="false">
                    <button type="button" class="btn btn-outline-secondary" id="btn-gen-code" title="สร้างรหัสอัตโนมัติ">
                      <i class="bi bi-shuffle"></i>
                    </button>
                  </div>
                  <div class="form-text text-muted" style="font-size:11px;">รหัสต้องไม่ซ้ำกัน</div>
                </div>

                <!-- Name -->
                <div class="mb-3">
                  <label class="form-label fw-medium">ชื่อ <span class="text-danger">*</span></label>
                  <input id="f-name" class="form-control" required>
                </div>

                <!-- storage_style — shown only when type=storage -->
                <div class="mb-3 d-none" id="storage-style-row">
                  <label class="form-label fw-medium">รูปแบบตู้ <span class="text-danger">*</span></label>
                  <select id="f-storage-style" class="form-select">
                    <option value="">-- เลือกรูปแบบ --</option>
                    <option value="closed">ตู้ปิด / ลิ้นชัก</option>
                    <option value="open">ชั้นเปิด</option>
                    <option value="mesh">ตะแกรง</option>
                    <option value="drawer">ลิ้นชักหลายชั้น</option>
                  </select>
                </div>

                <!-- QR payload -->
                <div class="mb-3">
                  <label class="form-label fw-medium">QR Payload</label>
                  <input id="f-qr" class="form-control fc-mono" placeholder="(ค่าเริ่มต้น = รหัส)" autocomplete="off">
                  <div class="form-text text-muted" style="font-size:11px;">ปล่อยว่างเพื่อใช้รหัสเป็น QR payload</div>
                </div>

                <!-- Note -->
                <div class="mb-3">
                  <label class="form-label fw-medium">หมายเหตุ</label>
                  <textarea id="f-note" class="form-control" rows="2"></textarea>
                </div>

                <!-- Active -->
                <div class="form-check">
                  <input type="checkbox" class="form-check-input" id="f-active" checked>
                  <label class="form-check-label" for="f-active">ใช้งาน (Active)</label>
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

    const fType        = document.getElementById('f-type');
    const fParent      = document.getElementById('f-parent');
    const parentRow    = document.getElementById('parent-row');
    const parentStar   = document.getElementById('parent-required-star');
    const typeHint     = document.getElementById('type-rule-hint');
    const storageRow   = document.getElementById('storage-style-row');
    const fStorageStyle = document.getElementById('f-storage-style');

    /** Populate parent dropdown based on current type selection. */
    function refreshParents() {
      const t = fType.value;
      const allowed = window.AppLocations
        ? window.AppLocations.allowedParentTypes(t)
        : null;

      // Hide parent row if type is root-only (room, ambulance)
      if (allowed === null) {
        parentRow.classList.add('d-none');
        fParent.value = '';
        typeHint.textContent = `ประเภทนี้เป็น root — ไม่มี parent`;
        return;
      }

      parentRow.classList.remove('d-none');

      // Filter alias: cabinet treated same as storage for filtering
      const normalised = allowed.map((a) => a === 'storage' ? ['storage', 'cabinet'] : [a]).flat();
      const validParents = _all.filter((l) => normalised.includes(l.type));

      const reqd = t !== 'bag'; // bag parent is optional
      parentStar.classList.toggle('d-none', !reqd);

      const hint = allowed.filter((a) => a !== 'cabinet').join(', ');
      typeHint.textContent = `Parent ต้องเป็น: ${hint}`;

      fParent.innerHTML = `<option value="">(ไม่มี parent)</option>` +
        validParents.map((l) => {
          const dispT = l.type === 'cabinet' ? 'storage' : l.type;
          return `<option value="${l.id}">${escapeHtml(l.code)} — ${escapeHtml(l.name)} (${labelForType(dispT)})</option>`;
        }).join('');

      // Re-apply preset parent if set
      if (presetParentId && !isEdit) {
        fParent.value = presetParentId;
      }
    }

    /** Show/hide storage_style row */
    function refreshStorageStyle() {
      const t = fType.value;
      const show = (t === 'storage' || t === 'cabinet');
      storageRow.classList.toggle('d-none', !show);
      fStorageStyle.required = show;
    }

    fType.addEventListener('change', () => {
      refreshParents();
      refreshStorageStyle();
    });

    refreshParents();
    refreshStorageStyle();

    // Populate generate-code button
    document.getElementById('btn-gen-code').onclick = async () => {
      const code = await generateCode(fType.value, fParent.value || null);
      document.getElementById('f-code').value = code;
    };

    // Fill form for edit
    if (isEdit && row) {
      // Normalize cabinet → storage in the dropdown
      const displayType = (row.type === 'cabinet') ? 'storage' : row.type;
      fType.value = displayType;
      refreshParents();
      refreshStorageStyle();
      if (row.parent_id) fParent.value = row.parent_id;
      document.getElementById('f-code').value  = row.code;
      document.getElementById('f-name').value  = row.name;
      document.getElementById('f-qr').value    = row.qr_payload || '';
      document.getElementById('f-note').value  = row.note || '';
      document.getElementById('f-active').checked = !!row.active;
      if (row.storage_style) fStorageStyle.value = row.storage_style;
    }

    // Submit
    document.getElementById('loc-form').onsubmit = async (ev) => {
      ev.preventDefault();
      const chosenType   = fType.value;   // always the UI type (storage not cabinet)
      const chosenParent = fParent.value || null;
      const chosenCode   = document.getElementById('f-code').value.trim();
      const chosenName   = document.getElementById('f-name').value.trim();

      // Client-side parent-rule validation
      if (window.AppLocations) {
        const parentRow2 = chosenParent ? _all.find((l) => l.id === chosenParent) : null;
        const parentType = parentRow2 ? (parentRow2.type === 'cabinet' ? 'storage' : parentRow2.type) : null;
        const vr = window.AppLocations.validateParentRule(chosenType, parentType);
        if (!vr.ok) {
          showToast('error', vr.message);
          return;
        }
      }

      // Required parent for non-optional types
      const needsParent = ['storage', 'shelf', 'bin', 'zone'].includes(chosenType);
      if (needsParent && !chosenParent) {
        showToast('error', `ประเภท "${labelForType(chosenType)}" ต้องมี parent`);
        return;
      }

      // storage_style required when type=storage
      if ((chosenType === 'storage' || chosenType === 'cabinet') && !fStorageStyle.value) {
        showToast('error', 'กรุณาเลือกรูปแบบตู้ (storage style)');
        return;
      }

      // When editing a legacy cabinet row, preserve 'cabinet' type in DB to avoid
      // enum issues until migration has run — but this is purely cosmetic on the FE
      // (cabinet is displayed as storage). We send whatever type is in the DB for edits.
      const dbType = (isEdit && row?.type === 'cabinet') ? 'cabinet' : chosenType;

      const payload = {
        type:          dbType,
        parent_id:     chosenParent,
        code:          chosenCode,
        name:          chosenName,
        qr_payload:    document.getElementById('f-qr').value.trim() || chosenCode,
        note:          document.getElementById('f-note').value.trim() || null,
        active:        document.getElementById('f-active').checked,
        storage_style: (chosenType === 'storage' || chosenType === 'cabinet')
                         ? (fStorageStyle.value || null)
                         : null,
      };

      const sb = getSupabaseClient();
      const q  = isEdit
        ? sb.from('locations').update(payload).eq('id', id)
        : sb.from('locations').insert(payload);
      const { error } = await q;

      if (error) {
        if (error.code === '23505') {
          showToast('error', 'รหัส (Code) ซ้ำ — กรุณาเปลี่ยน');
        } else if (error.code === '23514') {
          showToast('error', 'ข้อมูลไม่ผ่านกฎ constraint (ตรวจสอบ parent และประเภท)');
        } else if (error.message && error.message.includes('ไม่สามารถอยู่ภายใต้')) {
          // DB trigger message (Thai)
          showToast('error', error.message);
        } else {
          showToast('error', error.message || 'บันทึกไม่สำเร็จ');
        }
        return;
      }

      modal.hide();
      await load();
      // Auto-expand new node's parent so user sees it
      if (!isEdit && chosenParent) _expanded.add(chosenParent);
      renderTree();
      showToast('success', isEdit ? 'อัปเดตสถานที่แล้ว' : 'เพิ่มสถานที่แล้ว');
    };

    modal.show();
  }

  // =========================================================================
  // Delete
  // =========================================================================
  async function handleDelete(id) {
    const loc    = _all.find((x) => x.id === id);
    const count  = childCount(id);

    if (count > 0) {
      showToast('error', `ลบไม่ได้ — มี location ลูกอยู่ ${count} รายการ (ลบลูกก่อน)`);
      return;
    }

    const name = loc ? `"${loc.code} — ${loc.name}"` : 'รายการนี้';
    const ok = await showConfirm(`ลบ ${name}?`);
    if (!ok) return;

    const sb = getSupabaseClient();
    const { error } = await sb.from('locations').delete().eq('id', id);
    if (error) {
      if (error.code === '23503') showToast('error', 'ลบไม่ได้ เนื่องจากมีข้อมูลอ้างอิง');
      else showToast('error', error.message || 'ลบไม่สำเร็จ');
      return;
    }
    _expanded.delete(id);
    await load();
    renderTree();
    showToast('success', 'ลบแล้ว');
  }

  // =========================================================================
  // Tab initialisation (called by admin-shell.js once)
  // =========================================================================
  window.initLocationsTab = async function () {
    const root = document.getElementById('tab-locations');
    root.innerHTML = `
      <div class="d-flex align-items-center mb-3 flex-wrap gap-2">
        <h5 class="mb-0 me-auto fc-display"><i class="bi bi-geo-alt me-2"></i>สถานที่จัดเก็บ</h5>
        <button class="btn btn-sm btn-outline-secondary" id="btn-loc-expand-all" title="ขยายทั้งหมด">
          <i class="bi bi-arrows-expand"></i> ขยายทั้งหมด
        </button>
        <button class="btn btn-sm btn-outline-secondary" id="btn-loc-collapse-all" title="ย่อทั้งหมด">
          <i class="bi bi-arrows-collapse"></i> ย่อทั้งหมด
        </button>
        <button class="btn btn-stock-primary" id="btn-loc-new">
          <i class="bi bi-plus"></i> เพิ่มใหม่
        </button>
      </div>
      <div class="card shadow-sm">
        <div class="card-body p-2" id="loc-tree" style="min-height:80px;">
          <div class="d-flex align-items-center justify-content-center py-4 text-muted">
            <span class="spinner-border spinner-border-sm me-2"></span> กำลังโหลด…
          </div>
        </div>
      </div>
    `;

    document.getElementById('btn-loc-new').onclick = () => openModal(null, null);

    document.getElementById('btn-loc-expand-all').onclick = () => {
      _all.forEach((l) => _expanded.add(l.id));
      renderTree();
    };
    document.getElementById('btn-loc-collapse-all').onclick = () => {
      _expanded.clear();
      renderTree();
    };

    try {
      await load();
      renderTree();
      _subscribeRealtime();
    } catch (e) {
      showToast('error', e.message || 'โหลดข้อมูลไม่สำเร็จ');
      const tree = document.getElementById('loc-tree');
      if (tree) tree.innerHTML = `<p class="text-danger small p-2">โหลดไม่สำเร็จ: ${escapeHtml(e.message)}</p>`;
    }
  };
})();
