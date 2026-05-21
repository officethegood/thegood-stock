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
  let _expanded     = new Set(); // set of expanded node ids (persisted in localStorage)
  let _itemsByLoc   = new Map(); // location_id → [{sku,name,qty,unit,reorder_threshold}]
  let _unsubscribe  = null;      // realtime teardown
  let _refreshTimer = null;      // debounce handle

  const _LS_OPEN_KEY = 'admin_loc_tree_open';

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
  // Stock items per location (for Rich Tree Cards item previews)
  // =========================================================================
  async function _fetchItemStock() {
    try {
      const sb = getSupabaseClient();
      const { data, error } = await sb
        .from('stock_item_locations')
        .select('location_id, qty, stock_items(id, sku, name, unit, reorder_threshold)')
        .gt('qty', 0);
      if (error) {
        console.warn('[locations] _fetchItemStock error', error);
        return;
      }
      _itemsByLoc = new Map();
      for (const row of (data || [])) {
        const locId = row.location_id;
        if (!_itemsByLoc.has(locId)) _itemsByLoc.set(locId, []);
        _itemsByLoc.get(locId).push({
          sku:               row.stock_items?.sku  || '',
          name:              row.stock_items?.name || '',
          qty:               row.qty               || 0,
          unit:              row.stock_items?.unit || '',
          reorder_threshold: row.stock_items?.reorder_threshold ?? 0,
        });
      }
    } catch (e) {
      console.warn('[locations] _fetchItemStock threw', e);
    }
  }

  // =========================================================================
  // Realtime
  // =========================================================================
  function _scheduleRealtimeReload() {
    if (_refreshTimer) clearTimeout(_refreshTimer);
    _refreshTimer = setTimeout(async () => {
      try { await load(); await _fetchItemStock(); renderTree(); }
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
  // Tree rendering — Rich Tree Cards (Concept A)
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

  function _fallbackFlatTree() {
    const byId = new Map(_all.map((r) => [r.id, { ...r, children: [] }]));
    const roots = [];
    for (const n of byId.values()) {
      if (n.parent_id && byId.has(n.parent_id)) byId.get(n.parent_id).children.push(n);
      else roots.push(n);
    }
    return roots;
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

  /** Compute item status: 'out' | 'low' | 'ok' */
  function _itemStatus(item) {
    if (item.qty <= 0) return 'out';
    if (item.reorder_threshold > 0 && item.qty <= item.reorder_threshold) return 'low';
    return 'ok';
  }

  /**
   * Roll up alert counts across a subtree (node + all descendants).
   * Returns { low: N, out: N }
   */
  function _rollupAlerts(nodeId, childrenMap) {
    let low = 0, out = 0;
    const items = _itemsByLoc.get(nodeId) || [];
    for (const it of items) {
      const s = _itemStatus(it);
      if (s === 'out') out++;
      else if (s === 'low') low++;
    }
    const kids = childrenMap.get(nodeId) || [];
    for (const kid of kids) {
      const r = _rollupAlerts(kid.id, childrenMap);
      low += r.low; out += r.out;
    }
    return { low, out };
  }

  /** Child-type label for meta line */
  function _childTypeLabel(type) {
    return type === 'room'      ? 'ห้อง'
         : type === 'storage'   ? 'ตู้'
         : type === 'cabinet'   ? 'ตู้'
         : type === 'shelf'     ? 'ชั้น'
         : type === 'bin'       ? 'ตะกร้า'
         : type === 'ambulance' ? 'รถ'
         : type === 'bag'       ? 'กระเป๋า'
         : type === 'zone'      ? 'โซน'
         : 'รายการ';
  }

  /**
   * Render the Rich Tree Card list (called recursively).
   * childrenMap: Map<parentId, [child, ...]>
   */
  function _buildRtcNodes(nodes, childrenMap) {
    const ul = document.createElement('ul');
    ul.className = 'rtc-children';

    for (const l of nodes) {
      const dispType = (l.type === 'cabinet') ? 'storage' : l.type;
      const kids     = childrenMap.get(l.id) || [];
      const hasKids  = kids.length > 0;
      const isOpen   = _expanded.has(l.id);

      // Direct stock items at this location
      const ownItems = _itemsByLoc.get(l.id) || [];
      const ownCount = ownItems.length;

      // Alert roll-up (self + descendants)
      const { low, out } = _rollupAlerts(l.id, childrenMap);

      // Laundry badge
      const laundryMeta  = _laundryRoleMeta(l.laundry_role);

      // Build <li>
      const li = document.createElement('li');
      li.className = 'rtc-node' + (isOpen ? ' is-open' : '') + (!l.active ? ' rtc-inactive' : '');
      if (!hasKids && !ownCount) li.classList.add('is-leaf');
      li.dataset.type = dispType;
      li.dataset.id   = l.id;

      // Meta content
      const metaParts = [];
      if (hasKids) {
        const firstKidType = kids[0] ? _childTypeLabel((kids[0].type === 'cabinet' ? 'storage' : kids[0].type)) : 'รายการ';
        metaParts.push(`<i class="bi bi-diagram-3"></i> ${kids.length} ${firstKidType}`);
      }
      if (ownCount) {
        metaParts.push(`<i class="bi bi-box-seam"></i> ${ownCount} รายการ`);
      }
      if (l.storage_style) {
        metaParts.push(`<span style="font-size:.68rem;color:var(--fc-ink-mute)">(${_storageStyleLabel(l.storage_style)})</span>`);
      }
      if (laundryMeta) {
        metaParts.push(`<i class="bi ${laundryMeta.icon}"></i> ${laundryMeta.label}`);
      }

      const alertsHtml = [
        out ? `<span class="rtc-alert rtc-alert-out"><i class="bi bi-x-octagon-fill"></i>${out} หมด</span>` : '',
        low ? `<span class="rtc-alert rtc-alert-low"><i class="bi bi-exclamation-triangle-fill"></i>${low} ใกล้หมด</span>` : '',
      ].filter(Boolean).join(' ');

      const metaHtml = metaParts.join('<span class="rtc-meta-sep mx-1">·</span>');

      // Action buttons
      const canAddChild = !['bin', 'zone'].includes(dispType);
      const actionsHtml = `
        <div class="rtc-actions">
          ${canAddChild ? `<button class="btn btn-sm" title="เพิ่ม location ภายใน" data-act="add-child" data-id="${l.id}"><i class="bi bi-plus-circle"></i></button>` : ''}
          <button class="btn btn-sm" title="พิมพ์ QR" data-act="print" data-id="${l.id}"><i class="bi bi-printer"></i></button>
          <button class="btn btn-sm" title="แก้ไข" data-act="edit" data-id="${l.id}"><i class="bi bi-pencil"></i></button>
          <button class="btn btn-sm text-danger" title="ลบ" data-act="del" data-id="${l.id}"><i class="bi bi-trash"></i></button>
        </div>`;

      li.innerHTML = `
        <div class="rtc-row">
          <button class="rtc-twisty" data-act="toggle" data-id="${l.id}" aria-label="ขยาย/ยุบ">
            <i class="bi bi-chevron-right"></i>
          </button>
          <span class="rtc-icon"><i class="${iconClassForType(dispType)}"></i></span>
          <div class="rtc-main">
            <div class="rtc-title">
              <span class="rtc-name">${escapeHtml(l.name)}</span>
              <code class="rtc-code">${escapeHtml(l.code)}</code>
              <span class="rtc-chip-type">${escapeHtml(labelForType(dispType))}</span>
            </div>
            <div class="rtc-meta">
              ${metaHtml}
              ${alertsHtml ? `<span class="rtc-meta-sep mx-1">·</span>${alertsHtml}` : ''}
            </div>
          </div>
          ${actionsHtml}
        </div>`;

      // Item preview panel (only rendered when there are own items)
      if (ownCount > 0) {
        const MAX_PREVIEW = 4;
        const preview  = ownItems.slice(0, MAX_PREVIEW);
        const moreCount = ownCount - preview.length;

        const itemsDiv = document.createElement('div');
        itemsDiv.className = 'rtc-items';

        for (const it of preview) {
          const s  = _itemStatus(it);
          const row = document.createElement('div');
          row.className = 'rtc-item';
          row.innerHTML = `
            <span class="rtc-item-sku">${escapeHtml(it.sku)}</span>
            <span class="rtc-item-name">${escapeHtml(it.name)}</span>
            <span class="rtc-item-qty">${it.qty} ${escapeHtml(it.unit)}</span>
            <span class="rtc-item-flag ${s}">${s}</span>`;
          itemsDiv.appendChild(row);
        }

        if (moreCount > 0) {
          const moreBtn = document.createElement('button');
          moreBtn.className = 'rtc-item-more';
          moreBtn.innerHTML = `<i class="bi bi-arrow-right-short"></i> + อีก ${moreCount} รายการ`;
          moreBtn.onclick = (ev) => {
            ev.stopPropagation();
            openModal(l.id); // open edit modal — user can navigate from there
          };
          itemsDiv.appendChild(moreBtn);
        }

        li.appendChild(itemsDiv);
      }

      // Children
      if (hasKids) {
        const kidsWrap = document.createElement('div');
        kidsWrap.className = 'rtc-kids';
        kidsWrap.appendChild(_buildRtcNodes(kids, childrenMap));
        li.appendChild(kidsWrap);
      }

      ul.appendChild(li);
    }

    return ul;
  }

  function renderTree() {
    const tree = window.AppLocations
      ? window.AppLocations.getLocationTree(_all)
      : _fallbackFlatTree();

    const root = document.getElementById('loc-tree');
    if (!root) return;

    if (!tree || tree.length === 0) {
      root.innerHTML = `
        <div class="rtc-empty">
          <i class="bi bi-geo-alt"></i>
          <div class="rtc-empty-label">ยังไม่มีสถานที่ — กดเพิ่มใหม่</div>
        </div>`;
      return;
    }

    // Build children map for O(1) lookup during roll-up
    const childrenMap = new Map();
    for (const loc of _all) {
      if (loc.parent_id) {
        if (!childrenMap.has(loc.parent_id)) childrenMap.set(loc.parent_id, []);
        childrenMap.get(loc.parent_id).push(loc);
      }
    }

    // Render
    const wrap = document.createElement('div');
    wrap.className = 'rtc-tree';
    wrap.appendChild(_buildRtcNodes(tree, childrenMap));
    root.innerHTML = '';
    root.appendChild(wrap);

    // Attach events via delegation on the wrapper
    wrap.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-act]');
      if (!btn) return;
      ev.stopPropagation();
      const id  = btn.dataset.id;
      const act = btn.dataset.act;
      if (act === 'toggle')    { _toggleExpand(id); return; }
      if (act === 'add-child') { openModal(null, id); return; }
      if (act === 'print')     { _printQR(id); return; }
      if (act === 'edit')      { openModal(id); return; }
      if (act === 'del')       { handleDelete(id); return; }
    });
  }

  function _toggleExpand(id) {
    if (_expanded.has(id)) _expanded.delete(id);
    else _expanded.add(id);
    // Persist open set
    try { localStorage.setItem(_LS_OPEN_KEY, JSON.stringify([..._expanded])); } catch {}
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
  // D14: populate a <select> from lookup_lists
  // Uses window.LookupLists.fetchByKind when available, falls back to direct query.
  // Graceful fallback: if table missing keeps existing placeholder option.
  // currentValue that is no longer active is appended with "(ปิดใช้งาน)" so edit is safe.
  // =========================================================================
  // Hardcoded defaults — used when lookup_lists is empty/missing so the
  // form NEVER ends up with an unusable empty dropdown.
  const _LOOKUP_FALLBACK = {
    storage_style: [
      { code: 'closed', name: 'ตู้ปิด / ลิ้นชัก' },
      { code: 'open',   name: 'ชั้นเปิด' },
      { code: 'mesh',   name: 'ตะแกรง' },
      { code: 'drawer', name: 'ลิ้นชักหลายชั้น' },
    ],
  };

  async function _fillLookupSelect(selectEl, kind, currentValue) {
    let rows = [];
    try {
      if (window.LookupLists?.fetchByKind) {
        const r = await window.LookupLists.fetchByKind(kind);
        rows = (r && r.data) || [];
      } else {
        const r = await getSupabaseClient()
          .from('lookup_lists')
          .select('code,name,sort_order,active')
          .eq('kind', kind)
          .eq('active', true)
          .order('sort_order');
        rows = r.data || [];
      }
    } catch (e) {
      console.warn('[D14] lookup_lists fetch failed for kind=' + kind + ' — using fallback', e);
      rows = [];
    }
    // Empty result OR fetch error → fall back to hardcoded defaults.
    if (!rows.length) rows = _LOOKUP_FALLBACK[kind] || [];
    if (!rows.length) return;

    const placeholder = selectEl.options[0];
    selectEl.innerHTML = '';
    if (placeholder) selectEl.appendChild(placeholder);

    const codes = new Set(rows.map((r) => r.code));
    rows.forEach((r) => {
      const opt = document.createElement('option');
      opt.value = r.code;
      opt.textContent = r.name;
      selectEl.appendChild(opt);
    });

    if (currentValue && !codes.has(currentValue)) {
      const opt = document.createElement('option');
      opt.value = currentValue;
      opt.textContent = currentValue + ' (ปิดใช้งาน)';
      selectEl.appendChild(opt);
    }

    if (currentValue) selectEl.value = currentValue;
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
                <!-- D14: options populated at runtime from lookup_lists (kind='storage_style') -->
                <div class="mb-3 d-none" id="storage-style-row">
                  <label class="form-label fw-medium">รูปแบบตู้ <span class="text-danger">*</span></label>
                  <select id="f-storage-style" class="form-select">
                    <option value="">-- เลือกรูปแบบ --</option>
                  </select>
                </div>

                <!-- ambulance picker — shown only when type=ambulance (BUG-T185-01 fix) -->
                <div class="mb-3 d-none" id="ambulance-row">
                  <label class="form-label fw-medium">รถพยาบาล <span class="text-danger">*</span></label>
                  <select id="f-ambulance" class="form-select" style="min-height:44px">
                    <option value="">-- เลือกรถพยาบาล --</option>
                  </select>
                  <div class="form-text small">เลือกจากรายการรถที่ตั้งไว้ในแท็บ "รถพยาบาล" — ถ้ายังไม่มี ให้ admin เพิ่มที่นั่นก่อน</div>
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
              <div class="modal-footer ${isEdit ? 'justify-content-between' : ''}">
                ${isEdit ? `
                  <button type="button" class="btn btn-outline-danger btn-sm" id="btn-loc-clear-stock">
                    <i class="bi bi-eraser"></i> ล้างของในตำแหน่งนี้
                  </button>` : ''}
                <div class="d-flex gap-2">
                  <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">ยกเลิก</button>
                  <button type="submit" class="btn btn-stock-primary">บันทึก</button>
                </div>
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

    // "ล้างของในตำแหน่งนี้" — empty all stock at this location (edit mode only)
    const clearBtn = document.getElementById('btn-loc-clear-stock');
    if (clearBtn && isEdit) {
      clearBtn.onclick = () => _clearLocationStock(id, modal);
    }

    const fType        = document.getElementById('f-type');
    const fParent      = document.getElementById('f-parent');
    const parentRow    = document.getElementById('parent-row');
    const parentStar   = document.getElementById('parent-required-star');
    const typeHint     = document.getElementById('type-rule-hint');
    const storageRow   = document.getElementById('storage-style-row');
    const fStorageStyle = document.getElementById('f-storage-style');
    const fLaundryRole  = document.getElementById('loc-laundry-role');
    const ambulanceRow  = document.getElementById('ambulance-row');
    const fAmbulance    = document.getElementById('f-ambulance');

    /** Fetch and populate the ambulances dropdown (cached on first call). */
    let _ambListPromise = null;
    async function _populateAmbulancesOnce() {
      if (_ambListPromise) return _ambListPromise;
      _ambListPromise = (async () => {
        try {
          const { data, error } = await getSupabaseClient()
            .from('ambulances').select('id,plate,callsign,active').order('plate');
          if (error) throw error;
          // Clear existing (keep first placeholder)
          fAmbulance.innerHTML = '<option value="">-- เลือกรถพยาบาล --</option>';
          (data || []).forEach((a) => {
            const opt = document.createElement('option');
            opt.value = a.id;
            const label = a.callsign ? `${a.plate} · ${a.callsign}` : a.plate;
            opt.textContent = a.active === false ? `${label} (ปิดใช้งาน)` : label;
            if (a.active === false) opt.disabled = true;
            fAmbulance.appendChild(opt);
          });
          if ((data || []).length === 0) {
            const opt = document.createElement('option');
            opt.value = ''; opt.disabled = true;
            opt.textContent = '— ยังไม่มีรถพยาบาลในระบบ — ';
            fAmbulance.appendChild(opt);
          }
        } catch (e) {
          console.warn('Failed to load ambulances', e);
        }
      })();
      return _ambListPromise;
    }

    /** Show/hide ambulance picker row. Lazily fetches on first display. */
    function refreshAmbulancePicker() {
      const show = fType.value === 'ambulance';
      ambulanceRow.classList.toggle('d-none', !show);
      if (show) {
        fAmbulance.required = true;
        _populateAmbulancesOnce();
      } else {
        fAmbulance.required = false;
        fAmbulance.value = '';
      }
    }

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
      refreshAmbulancePicker();
    });

    refreshParents();
    refreshStorageStyle();
    refreshAmbulancePicker();

    // D14: populate storage_style from lookup_lists (async; current value applied inside helper)
    const _existingStorageStyle = isEdit ? (row?.storage_style || null) : null;
    _fillLookupSelect(fStorageStyle, 'storage_style', _existingStorageStyle);

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
      refreshAmbulancePicker();
      if (row.parent_id) fParent.value = row.parent_id;
      document.getElementById('f-code').value  = row.code;
      document.getElementById('f-name').value  = row.name;
      document.getElementById('f-qr').value    = row.qr_payload || '';
      document.getElementById('f-note').value  = row.note || '';
      document.getElementById('f-active').checked = !!row.active;
      // storage_style value is applied by _fillLookupSelect; if that already ran synchronously
      // or the table is missing, fall back to direct assignment here.
      if (row.storage_style && !fStorageStyle.value) fStorageStyle.value = row.storage_style;
      if (row.laundry_role)  fLaundryRole.value  = row.laundry_role;
      // Pre-select the linked ambulance (wait for the async populate to finish first)
      if (row.type === 'ambulance' && row.ambulance_id) {
        _populateAmbulancesOnce().then(() => { fAmbulance.value = row.ambulance_id; });
      }
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

      // ambulance_id required when type=ambulance (chk_ambulance_link CHECK)
      if (chosenType === 'ambulance' && !fAmbulance.value) {
        showToast('error', 'กรุณาเลือกรถพยาบาลจากรายการ');
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
        // BUG-T185-01 fix: write ambulance_id when (and only when) type=ambulance.
        // chk_ambulance_link CHECK enforces NULL for non-ambulance rows.
        ambulance_id:  chosenType === 'ambulance' ? (fAmbulance.value || null) : null,
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
  // Empty all stock from a location — posts adjustment_loss per item so the
  // ledger keeps a record. Lets the admin reset a location before re-stocking
  // (and is the prerequisite for deleting a location that still has stock).
  async function _clearLocationStock(locId, modal) {
    const sb  = getSupabaseClient();
    const loc = _all.find((x) => x.id === locId);

    const { data, error } = await sb
      .from('stock_item_locations')
      .select('item_id, qty, stock_items(name, sku, tracks_lots)')
      .eq('location_id', locId)
      .gt('qty', 0);
    if (error) { showToast('error', 'โหลดข้อมูลของในตำแหน่งไม่สำเร็จ'); return; }
    if (!data || !data.length) { showToast('info', 'ตำแหน่งนี้ไม่มีของอยู่แล้ว'); return; }

    const totalItems = data.length;
    const totalQty   = data.reduce((s, r) => s + (r.qty || 0), 0);
    const locName    = loc ? `${loc.code} — ${loc.name}` : 'ตำแหน่งนี้';

    const ok = await showConfirm(
      `ล้างของทั้งหมดใน "${locName}"? ` +
      `จะตัด ${totalItems} รายการ (รวม ${totalQty} ชิ้น) ให้เป็น 0 — ` +
      `บันทึกลงประวัติเป็นการปรับยอด กู้คืนไม่ได้`
    );
    if (!ok) return;

    if (!window.AppInventory || !window.AppInventory.adjustmentLoss) {
      showToast('error', 'โมดูล inventory ยังไม่พร้อม — รีเฟรชหน้าใหม่');
      return;
    }

    let done = 0, failed = 0;
    const failNames = [];
    for (const r of data) {
      const ref = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));
      const res = await window.AppInventory.adjustmentLoss(
        r.item_id, locId, r.qty, `ล้างตำแหน่ง ${loc?.code || ''}`, ref
      );
      if (res && res.error) { failed++; failNames.push(r.stock_items?.name || r.item_id); }
      else done++;
    }

    if (failed) {
      showToast('warning',
        `ล้างสำเร็จ ${done} รายการ · ล้มเหลว ${failed} (${failNames.slice(0, 3).join(', ')}` +
        `${failNames.length > 3 ? '…' : ''}) — รายการที่ track ล็อตอาจต้องจัดการแยก`);
    } else {
      showToast('success', `ล้างของใน ${loc?.code || 'ตำแหน่ง'} สำเร็จ — ${done} รายการเป็น 0`);
    }
    if (modal) { try { modal.hide(); } catch {} }
    await load();
    renderTree();
  }

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
    // Two-button segmented control. Bigger + bordered so it's discoverable.
    return `
      <div role="tablist" aria-label="view mode" style="display:inline-flex;border:1.5px solid var(--fc-vital,#00B8A9);border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,184,169,0.15)">
        <button id="btn-loc-view-tree"  class="fc-btn fc-btn-${active==='tree'?'primary':'ghost'}"  style="border-radius:0;border:none;padding:8px 16px;min-height:40px;font-size:13px;font-weight:600;letter-spacing:0.02em"><i class="bi bi-diagram-3 me-1"></i>Tree</button>
        <button id="btn-loc-view-graph" class="fc-btn fc-btn-${active==='graph'?'primary':'ghost'}" style="border-radius:0;border:none;padding:8px 16px;min-height:40px;font-size:13px;font-weight:600;letter-spacing:0.02em"><i class="bi bi-diagram-2 me-1"></i>Graph</button>
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
        onNodeClick: (loc) => { try { openModal(loc.id, null); } catch (_) {} },
      });
    } else {
      host.innerHTML = `<div class="alert alert-warning small">Graph module ไม่ได้โหลด — ลอง switch ไป "Tree"</div>`;
    }
  }

  window.initLocationsTab = async function () {
    // Restore persisted open set from localStorage
    try {
      const saved = JSON.parse(localStorage.getItem(_LS_OPEN_KEY) || '[]');
      _expanded = new Set(saved);
    } catch { _expanded = new Set(); }

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
      <div id="loc-tree" style="min-height:80px;">
        <div class="d-flex align-items-center justify-content-center py-4 text-muted">
          <span class="spinner-border spinner-border-sm me-2"></span> กำลังโหลด…
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
      try { localStorage.setItem(_LS_OPEN_KEY, JSON.stringify([..._expanded])); } catch {}
      renderTree();
    };
    document.getElementById('btn-loc-collapse-all').onclick = () => {
      _expanded.clear();
      try { localStorage.setItem(_LS_OPEN_KEY, JSON.stringify([])); } catch {}
      renderTree();
    };

    try {
      await load();
      await _fetchItemStock();
      renderTree();
      _subscribeRealtime();
    } catch (e) {
      showToast('error', e.message || 'โหลดข้อมูลไม่สำเร็จ');
      const tree = document.getElementById('loc-tree');
      if (tree) tree.innerHTML = `<p class="text-danger small p-2">โหลดไม่สำเร็จ: ${escapeHtml(e.message)}</p>`;
    }
  };
})();
