// shared/locations.js — Phase 0.7
// Helper functions for location hierarchy: tree building, path resolution,
// parent-rule validation, and code-sequence suggestions.
// Consumed by js/locations.js (admin CRUD) and any future transfer UI.

(function () {

  // =========================================================================
  // Parent-rule matrix (mirrors DB trigger validate_location_parent_type)
  // key = child type, value = array of allowed parent types (empty = root only)
  // =========================================================================
  const PARENT_RULES = {
    room:      null,                            // NULL parent only
    ambulance: null,                            // NULL parent only
    storage:   ['room', 'ambulance'],
    cabinet:   ['room', 'ambulance'],           // legacy alias — same rule
    shelf:     ['storage', 'cabinet'],
    bin:       ['shelf'],
    bag:       ['room', 'storage', 'cabinet'],  // parent optional (bag can be NULL)
    zone:      ['bag'],
  };

  // Types that require a non-null parent
  const REQUIRES_PARENT = new Set(['storage', 'cabinet', 'shelf', 'bin', 'zone']);

  /**
   * Validate whether a child type can legally live under a parent type.
   * @param {string} childType
   * @param {string|null} parentType — null means "no parent"
   * @returns {{ ok: boolean, message: string }}
   */
  function validateParentRule(childType, parentType) {
    const allowed = PARENT_RULES[childType];

    // Types with null rule (room, ambulance) must have no parent
    if (allowed === null) {
      if (parentType !== null && parentType !== undefined) {
        return { ok: false, message: `ประเภท "${childType}" ต้องเป็น root (ไม่มี parent)` };
      }
      return { ok: true, message: '' };
    }

    // Types that require parent
    if (REQUIRES_PARENT.has(childType) && (parentType === null || parentType === undefined)) {
      return { ok: false, message: `ประเภท "${childType}" ต้องมี parent` };
    }

    // bag is optional parent — if no parent that's fine
    if (childType === 'bag' && (parentType === null || parentType === undefined)) {
      return { ok: true, message: '' };
    }

    // Check parent type is in allowed list
    if (parentType && !allowed.includes(parentType)) {
      const allowedThai = allowed
        .filter((t) => t !== 'cabinet')   // hide legacy alias in messages
        .join(', ');
      return {
        ok: false,
        message: `ประเภท "${childType}" ต้องอยู่ภายใต้ ${allowedThai} (ไม่ใช่ "${parentType}")`,
      };
    }

    return { ok: true, message: '' };
  }

  /**
   * Return the allowed parent types for a given child type.
   * Returns null if child may be root (room, ambulance).
   * Returns empty array [] if type unknown.
   */
  function allowedParentTypes(childType) {
    if (!(childType in PARENT_RULES)) return [];
    return PARENT_RULES[childType];    // null | string[]
  }

  // =========================================================================
  // Tree builder
  // =========================================================================

  /**
   * Build a nested tree from a flat array of location rows.
   * Each node gains a `children` array.
   * @param {Array} rows — flat array from Supabase
   * @returns {Array} root nodes (nodes with no parent_id)
   */
  function getLocationTree(rows) {
    const byId = new Map(rows.map((r) => [r.id, { ...r, children: [] }]));
    const roots = [];
    for (const node of byId.values()) {
      if (node.parent_id && byId.has(node.parent_id)) {
        byId.get(node.parent_id).children.push(node);
      } else {
        roots.push(node);
      }
    }
    // Sort children by code for stable ordering
    function sortChildren(nodes) {
      nodes.sort((a, b) => (a.code || '').localeCompare(b.code || '', 'th'));
      nodes.forEach((n) => sortChildren(n.children));
    }
    sortChildren(roots);
    return roots;
  }

  /**
   * Resolve a location id to its path display string using the flat rows array.
   * Walks parent_id chain. Returns e.g. "ห้องยา › ตู้ A › ชั้น 3"
   * @param {string} id
   * @param {Array} rows — flat array
   * @returns {string}
   */
  function getLocationPath(id, rows) {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const parts = [];
    let current = byId.get(id);
    let safety = 0;
    while (current && safety++ < 8) {
      parts.unshift(current.name);
      current = current.parent_id ? byId.get(current.parent_id) : null;
    }
    return parts.join(' › ');
  }

  /**
   * Suggest the next code for bin or zone types.
   * Queries Supabase for the max existing sequence number and returns prefix + (n+1).
   * @param {'bin'|'zone'} type
   * @param {Function} supabaseFactory — window.getSupabaseClient
   * @returns {Promise<string>}
   */
  async function nextCodeSuggestion(type, supabaseFactory) {
    const prefix = type === 'bin' ? 'BIN-' : type === 'zone' ? 'ZN-' : '';
    if (!prefix) return '';
    const sb = supabaseFactory();
    const { data } = await sb
      .from('locations')
      .select('code')
      .like('code', prefix + '%');
    const nums = (data || [])
      .map((r) => {
        const n = Number(r.code.slice(prefix.length).replace(/^0+/, '') || '0');
        return isNaN(n) ? 0 : n;
      });
    const next = (nums.length ? Math.max(...nums) : 0) + 1;
    return prefix + String(next).padStart(3, '0');
  }

  // Expose on window
  window.AppLocations = {
    validateParentRule,
    allowedParentTypes,
    getLocationTree,
    getLocationPath,
    nextCodeSuggestion,
    PARENT_RULES,
  };
})();
