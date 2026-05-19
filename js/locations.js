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
      .select('id,code,name,type,parent_id,ambulance_id,qr_payload,active,note,storage_style,laundry_role')
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

      const laundryMeta = _laundryRoleMeta(l.laundry_role);
      const laundryBadge = laundryMeta
        ? `<span class="fc-badge fc-badge-neutral ms-1" style="font-size:10px;padding:2px 7px;background:var(--fc-paper-sub);">
            <i class="bi ${laundryMeta.icon}" style="font-size:10px;margin-right:2px;"></i>${laundryMeta.label}
           </span>`
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
          ${laundryBadge}
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

  /** Returns { icon, label } for a laundry_role value, or null if not set. */
  function _laundryRoleMeta(role) {
    if (!role) return null;
    return role === 'clean'    ? { icon: 'bi-basket',   label: 'พร้อมใช้'    }
         : role === 'vehicle'  ? { icon: 'bi-truck',    label: 'ในรถ'        }
         : role === 'dirty'    ? { icon: 'bi-bucket',   label: 'รอซัก'       }
         : role === 'external' ? { icon: 'bi-building', label: 'กำลังซัก'   }
         : null;
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
  // Error helper (shared by create + edit paths)
  // =========================================================================
  function _handleLocError(error) {
    if (error.code === '23505') {
      showToast('error', 'รหัส (Code) ซ้ำ — กรุณาเปลี่ยน');
    } else if (error.code === '23514') {
      showToast('error', 'ข้อมูลไม่ผ่านกฎ constraint (ตรวจสอบ parent และประเภท)');
    } else if (error.message && error.message.includes('ไม่สามารถอยู่ภายใต้')) {
      showToast('error', error.message);
    } else {
      showToast('error', error.message || 'บันทึกไม่สำเร็จ');
    }
  }

  // =========================================================================
  // D10 — auto-migrate stock when a sublocation is added to a parent that
  // has direct items (stock_item_locations.location_id = parent, qty > 0).
  // =========================================================================

  /**
   * Show the D10 warning modal listing direct-stock items.
   * Returns a Promise that resolves to true (confirm) or false (cancel).
   */
  function _showAutoMigrateConfirm(items, newSubName) {
    return new Promise((resolve) => {
      const listHtml = items.map((it) => {
        const name = it.stock_items ? escapeHtml(it.stock_items.name) : it.item_id;
        const sku  = it.stock_items ? ` <span class="text-muted">(${escapeHtml(it.stock_items.sku || '')})</span>` : '';
        return `<li class="mb-1"><i class="bi bi-box-seam me-1 text-muted"></i>${name}${sku} &times; <strong>${it.qty}</strong></li>`;
      }).join('');

      const modalHtml = `
        <div class="modal fade" id="auto-migrate-modal" tabindex="-1">
          <div class="modal-dialog modal-dialog-centered">
            <div class="modal-content">
              <div class="modal-header border-0 pb-0">
                <h5 class="modal-title fc-display">
                  <i class="bi bi-exclamation-triangle-fill text-warning me-2"></i>
                  ตำแหน่งนี้มีของอยู่ตรงๆ (${items.length} รายการ)
                </h5>
                <button type="button" class="btn-close" id="btn-amm-close"></button>
              </div>
              <div class="modal-body">
                <ul class="list-unstyled mb-3 ps-1" style="max-height:200px;overflow-y:auto;">
                  ${listHtml}
                </ul>
                <div class="alert alert-warning py-2 mb-0" style="font-size:13px;">
                  ของทั้งหมดจะถูกย้ายไปยัง <strong>"${escapeHtml(newSubName)}"</strong> โดยอัตโนมัติ<br>
                  ท่านสามารถจัดเรียงในระดับนี้เองทีหลังได้ (ใช้ปุ่ม "ย้าย" ในรายการของ)
                </div>
              </div>
              <div class="modal-footer border-0 pt-0">
                <button type="button" class="btn btn-secondary" id="btn-amm-cancel">ยกเลิก</button>
                <button type="button" class="btn btn-stock-primary" id="btn-amm-confirm">
                  <i class="bi bi-arrow-right-circle me-1"></i>สร้างและย้ายของ
                </button>
              </div>
            </div>
          </div>
        </div>`;

      document.body.insertAdjacentHTML('beforeend', modalHtml);
      const el = document.getElementById('auto-migrate-modal');
      const bsModal = new bootstrap.Modal(el, { backdrop: 'static', keyboard: false });
      el.addEventListener('hidden.bs.modal', () => el.remove());

      document.getElementById('btn-amm-cancel').onclick  = () => { bsModal.hide(); resolve(false); };
      document.getElementById('btn-amm-close').onclick   = () => { bsModal.hide(); resolve(false); };
      document.getElementById('btn-amm-confirm').onclick = () => { bsModal.hide(); resolve(true); };
      bsModal.show();
    });
  }

  /**
   * Core D10 flow: check parent direct stock, optionally show confirm modal,
   * INSERT the new sublocation, then transfer each item via RPC.
   *
   * @param {object} sb          Supabase client
   * @param {object} payload     Location INSERT payload
   * @param {string} parentId    Parent location id
   * @param {string} newSubName  Display name of the new sublocation (for modal + note)
   * @param {object} modal       Bootstrap modal instance (the create-location modal)
   */
  async function _createWithAutoMigrate(sb, payload, parentId, newSubName, modal) {
    // 1. Query direct stock at parent
    let { data: directStock, error: sErr } = await sb
      .from('stock_item_locations')
      .select('item_id, qty, stock_items(name, sku, tracks_lots)')
      .eq('location_id', parentId)
      .gt('qty', 0);

    if (sErr) {
      console.warn('[D10] Could not query direct stock:', sErr);
      directStock = [];  // treat as empty — proceed with plain create
    }

    if (!directStock || directStock.length === 0) {
      // No direct stock — plain INSERT, no migration needed
      const { error } = await sb.from('locations').insert(payload);
      if (error) { _handleLocError(error); return; }
      modal.hide();
      await load();
      _expanded.add(parentId);
      renderTree();
      showToast('success', 'เพิ่มสถานที่แล้ว');
      return;
    }

    // 2. Show confirmation modal
    const confirmed = await _showAutoMigrateConfirm(directStock, newSubName);
    if (!confirmed) return;  // user cancelled — no INSERT, no transfer

    // 3. INSERT the new sublocation
    const { data: newRows, error: insErr } = await sb
      .from('locations')
      .insert(payload)
      .select('id')
      .single();

    if (insErr) { _handleLocError(insErr); return; }
    const newId = newRows.id;

    // 4. Close the create-location modal early so user sees progress
    modal.hide();
    await load();
    _expanded.add(parentId);
    renderTree();

    // 5. Re-query direct stock (race-condition safety — another admin may have moved)
    const { data: freshStock } = await sb
      .from('stock_item_locations')
      .select('item_id, qty, stock_items(name, tracks_lots)')
      .eq('location_id', parentId)
      .gt('qty', 0);

    const toMove = freshStock || [];
    if (toMove.length === 0) {
      showToast('success', 'เพิ่มสถานที่แล้ว (ของถูกย้ายไปแล้วโดย session อื่น)');
      return;
    }

    // 6. Separate lot-tracked vs non-lot items
    const lotItems    = toMove.filter((it) => it.stock_items?.tracks_lots);
    const nonLotItems = toMove.filter((it) => !it.stock_items?.tracks_lots);

    if (lotItems.length > 0) {
      console.warn(
        `[D10] ${lotItems.length} lot-tracked item(s) skipped — please move manually:`,
        lotItems.map((it) => it.stock_items?.name || it.item_id)
      );
    }

    // 7. Show progress spinner if > 5 items
    let progressEl = null;
    if (nonLotItems.length > 5) {
      progressEl = document.createElement('div');
      progressEl.className = 'toast align-items-center text-bg-secondary border-0 position-fixed bottom-0 end-0 m-3 show';
      progressEl.style.zIndex = '9999';
      progressEl.innerHTML = `
        <div class="d-flex">
          <div class="toast-body">
            <span class="spinner-border spinner-border-sm me-2"></span>
            กำลังย้ายของ… (0/${nonLotItems.length})
          </div>
        </div>`;
      document.body.appendChild(progressEl);
    }

    // 8. Transfer each non-lot item via RPC
    let done = 0;
    let failed = 0;
    for (const item of nonLotItems) {
      const { error: rpcErr } = await sb.rpc('transfer_stock', {
        p_item_id:        item.item_id,
        p_lot_id:         null,
        p_source_loc_id:  parentId,
        p_dest_loc_id:    newId,
        p_qty:            item.qty,
        p_source_scanned: false,
        p_dest_scanned:   false,
        p_note:           `auto-migrate when sublocation "${newSubName}" added`,
        p_client_ref_id:  crypto.randomUUID(),
      });
      if (rpcErr) {
        console.error('[D10] transfer_stock failed for item', item.item_id, rpcErr);
        failed++;
      } else {
        done++;
      }
      if (progressEl) {
        progressEl.querySelector('.toast-body').innerHTML = `
          <span class="spinner-border spinner-border-sm me-2"></span>
          กำลังย้ายของ… (${done}/${nonLotItems.length})`;
      }
    }

    if (progressEl) progressEl.remove();

    // 9. Summary toast
    let msg = `สร้างและย้ายของ ${done} รายการสำเร็จ`;
    if (failed > 0)      msg += ` (${failed} รายการล้มเหลว — ตรวจสอบ console)`;
    if (lotItems.length) msg += ` · ${lotItems.length} รายการ lot-tracked ข้ามไว้ — โปรดย้ายด้วยตนเอง`;
    showToast(failed > 0 ? 'warn' : 'success', msg);

    // Reload tree to reflect final qty changes
    await load();
    renderTree();
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

                <!-- Laundry role (Phase 0.7+) -->
                <div class="mb-3">
                  <label class="form-label small fw-medium">บทบาทใน laundry flow (ถ้ามี)</label>
                  <select id="loc-laundry-role" class="form-select" style="min-height:44px;">
                    <option value="">— ไม่เกี่ยวข้องกับ laundry —</option>
                    <option value="clean">คลังผ้าสะอาด (พร้อมใช้)</option>
                    <option value="vehicle">ตู้ผ้าในรถ (ในรถ)</option>
                    <option value="dirty">ถังผ้าเปื้อน (รอซัก)</option>
                    <option value="external">ส่งซักภายนอก (กำลังซัก)</option>
                  </select>
                  <div class="form-text small">เลือกเพื่อให้ระบบรวมเข้า dashboard ผ้า + quick actions</div>
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
    const fLaundryRole  = document.getElementById('loc-laundry-role');

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
      if (row.laundry_role)  fLaundryRole.value  = row.laundry_role;
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
        laundry_role:  fLaundryRole.value || null,
      };

      const sb = getSupabaseClient();

      if (isEdit) {
        // ── EDIT path ─────────────────────────────────────────────
        const { error } = await sb.from('locations').update(payload).eq('id', id);
        if (error) { _handleLocError(error); return; }
        modal.hide();
        await load();
        renderTree();
        showToast('success', 'อัปเดตสถานที่แล้ว');
      } else {
        // ── CREATE path ───────────────────────────────────────────
        // D10: for sublocation types (shelf/bin/zone) check if parent
        // has direct stock before committing the INSERT.
        const subTypes = ['shelf', 'bin', 'zone'];
        if (subTypes.includes(chosenType) && chosenParent) {
          await _createWithAutoMigrate(sb, payload, chosenParent, chosenName, modal);
        } else {
          const { error } = await sb.from('locations').insert(payload);
          if (error) { _handleLocError(error); return; }
          modal.hide();
          await load();
          if (chosenParent) _expanded.add(chosenParent);
          renderTree();
          showToast('success', 'เพิ่มสถานที่แล้ว');
        }
      }
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
  // View mode persistence: 'tree' (CRUD, default) | 'graph' (read-only Mermaid)
  let _adminView = (typeof localStorage !== 'undefined' && localStorage.getItem('admin_loc_view')) || 'tree';

  function _adminViewToggleHtml(active) {
    return `
      <div role="tablist" aria-label="view mode" style="display:inline-flex;border:1px solid rgba(12,25,41,0.15);border-radius:6px;overflow:hidden;margin-right:var(--fc-s2,8px)">
        <button id="btn-loc-view-tree"  class="fc-btn fc-btn-${active==='tree'?'primary':'ghost'}"  style="border-radius:0;border:none;padding:6px 12px;min-height:36px;font-size:13px"><i class="bi bi-diagram-3 me-1"></i>Tree</button>
        <button id="btn-loc-view-graph" class="fc-btn fc-btn-${active==='graph'?'primary':'ghost'}" style="border-radius:0;border:none;padding:6px 12px;min-height:36px;font-size:13px"><i class="bi bi-diagram-2 me-1"></i>Graph</button>
      </div>`;
  }

  async function _renderAdminGraph() {
    const root = document.getElementById('tab-locations');
    root.innerHTML = `
      <div class="d-flex align-items-center mb-3 flex-wrap gap-2">
        <h5 class="mb-0 me-auto fc-display"><i class="bi bi-geo-alt me-2"></i>สถานที่จัดเก็บ
          <span class="fc-mono" style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:var(--fc-ink-mute);margin-left:var(--fc-s2,8px)">${(_all||[]).length} nodes</span>
        </h5>
        ${_adminViewToggleHtml('graph')}
        <button class="btn btn-stock-primary" id="btn-loc-new"><i class="bi bi-plus"></i> เพิ่มใหม่</button>
      </div>
      <div class="fc-card" id="loc-graph-host" style="min-height:200px"></div>`;

    document.getElementById('btn-loc-new').onclick = () => openModal(null, null);
    document.getElementById('btn-loc-view-tree').onclick = () => {
      _adminView = 'tree'; try{localStorage.setItem('admin_loc_view','tree')}catch{};
      window.initLocationsTab();
    };
    document.getElementById('btn-loc-view-graph').onclick = () => {};

    const host = document.getElementById('loc-graph-host');
    if (window.LocationsGraph) {
      // onNodeClick → jump to edit modal for that location (admin-only behavior)
      await window.LocationsGraph.render(host, _all || [], {
        showLegend: true,
        maxHeight: 'calc(100vh - 280px)',
        onNodeClick: (loc) => { try { openModal(loc, null); } catch (_) {} },
      });
    } else {
      host.innerHTML = `<div class="alert alert-warning small">Graph module ไม่ได้โหลด — ลอง switch ไป "Tree"</div>`;
    }
  }

  window.initLocationsTab = async function () {
    if (_adminView === 'graph') {
      // For graph view, ensure data is loaded first
      try {
        if (!_all || !_all.length) await load();
      } catch (e) {
        showToast('error', e.message || 'โหลดข้อมูลไม่สำเร็จ');
      }
      await _renderAdminGraph();
      _subscribeRealtime();
      return;
    }

    const root = document.getElementById('tab-locations');
    root.innerHTML = `
      <div class="d-flex align-items-center mb-3 flex-wrap gap-2">
        <h5 class="mb-0 me-auto fc-display"><i class="bi bi-geo-alt me-2"></i>สถานที่จัดเก็บ</h5>
        ${_adminViewToggleHtml('tree')}
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
    document.getElementById('btn-loc-view-tree').onclick = () => {};
    document.getElementById('btn-loc-view-graph').onclick = () => {
      _adminView = 'graph'; try{localStorage.setItem('admin_loc_view','graph')}catch{};
      window.initLocationsTab();
    };

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
