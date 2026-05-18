// shared/settings.js
// Read settings table once, cache to a local map, expose getters.

(function () {
  let _cache = null;

  async function loadSettings() {
    const sb = getSupabaseClient();
    const { data, error } = await sb.from('settings').select('key,value');
    if (error) throw error;
    _cache = {};
    for (const row of data) _cache[row.key] = row.value;
    return _cache;
  }

  function settingsGet(key) {
    return _cache ? _cache[key] : null;
  }
  function settingsBool(key) {
    const v = settingsGet(key);
    return v === 'true' || v === '1';
  }

  async function settingsSet(updates) {
    const sb = getSupabaseClient();
    const rows = Object.entries(updates).map(([key, value]) => ({
      key, value: String(value ?? ''),
      updated_at: new Date().toISOString(),
      updated_by: getUserUsername(),
    }));
    const { error } = await sb.from('settings').upsert(rows);
    if (error) throw error;
    if (!_cache) _cache = {};
    Object.assign(_cache, updates);
  }

  window.loadSettings = loadSettings;
  window.settingsGet  = settingsGet;
  window.settingsBool = settingsBool;
  window.settingsSet  = settingsSet;
})();
