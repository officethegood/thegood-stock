// shared/lookup-lists.js
// D14 — User-managed taxonomy via lookup_lists + stock_categories.
// Requires: shared/supabase-client.js loaded first.

(function () {
  // ── helpers ───────────────────────────────────────────────────────────────

  function sb() { return getSupabaseClient(); }

  function _wrap(promise) {
    return promise.then(({ data, error }) => ({ data, error }));
  }

  // ── lookup_lists ──────────────────────────────────────────────────────────

  /** Fetch all rows for a kind, ordered by sort_order */
  function fetchByKind(kind) {
    return _wrap(
      sb()
        .from('lookup_lists')
        .select('*')
        .eq('kind', kind)
        .order('sort_order', { ascending: true })
        .order('name', { ascending: true })
    );
  }

  /** Create a new lookup row */
  function create(kind, { code, name, sort_order }) {
    return _wrap(
      sb()
        .from('lookup_lists')
        .insert({ kind, code, name, sort_order: sort_order ?? 0, active: true })
        .select()
        .single()
    );
  }

  /** Update mutable fields: name, sort_order, active */
  function update(id, patch) {
    const allowed = {};
    if (patch.name       !== undefined) allowed.name       = patch.name;
    if (patch.sort_order !== undefined) allowed.sort_order = patch.sort_order;
    if (patch.active     !== undefined) allowed.active     = patch.active;
    allowed.updated_at = new Date().toISOString();
    return _wrap(
      sb()
        .from('lookup_lists')
        .update(allowed)
        .eq('id', id)
        .select()
        .single()
    );
  }

  /** Delete a lookup row (caller must check countUsage first) */
  function remove(id) {
    return _wrap(
      sb()
        .from('lookup_lists')
        .delete()
        .eq('id', id)
    );
  }

  // ── stock_categories ──────────────────────────────────────────────────────

  function fetchCategories() {
    return _wrap(
      sb()
        .from('stock_categories')
        .select('*')
        .order('sort_order', { ascending: true })
        .order('name', { ascending: true })
    );
  }

  function createCategory({ code, name, sort_order }) {
    return _wrap(
      sb()
        .from('stock_categories')
        .insert({ code, name, sort_order: sort_order ?? 0, active: true })
        .select()
        .single()
    );
  }

  function updateCategory(id, patch) {
    const allowed = {};
    if (patch.name       !== undefined) allowed.name       = patch.name;
    if (patch.sort_order !== undefined) allowed.sort_order = patch.sort_order;
    if (patch.active     !== undefined) allowed.active     = patch.active;
    return _wrap(
      sb()
        .from('stock_categories')
        .update(allowed)
        .eq('id', id)
        .select()
        .single()
    );
  }

  function removeCategory(id) {
    return _wrap(
      sb()
        .from('stock_categories')
        .delete()
        .eq('id', id)
    );
  }

  // ── countUsage ────────────────────────────────────────────────────────────

  /**
   * Count rows that reference a taxonomy value.
   * kind = 'linen_subcategory' | 'storage_style' | 'tank_size' | 'category'
   * code = the code string (or category uuid for kind='category')
   * Returns { count: number, error }
   */
  async function countUsage(kind, code) {
    let query;
    if (kind === 'linen_subcategory') {
      query = sb()
        .from('stock_items')
        .select('id', { count: 'exact', head: true })
        .eq('linen_subcategory', code);
    } else if (kind === 'storage_style') {
      query = sb()
        .from('locations')
        .select('id', { count: 'exact', head: true })
        .eq('storage_style', code);
    } else if (kind === 'tank_size') {
      query = sb()
        .from('oxygen_tanks')
        .select('id', { count: 'exact', head: true })
        .eq('tank_size', code);
    } else if (kind === 'category') {
      query = sb()
        .from('stock_items')
        .select('id', { count: 'exact', head: true })
        .eq('category_id', code);
    } else {
      return { count: 0, error: new Error('unknown kind: ' + kind) };
    }

    const { count, error } = await query;
    return { count: count ?? 0, error };
  }

  // ── export ────────────────────────────────────────────────────────────────

  window.LookupLists = {
    fetchByKind,
    fetchCategories,
    create,
    update,
    remove,
    createCategory,
    updateCategory,
    removeCategory,
    countUsage,
  };
})();
