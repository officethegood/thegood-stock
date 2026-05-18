// shared/realtime.js
// Phase 1+: live subscriptions for stock_items, borrows, oxygen_tanks.

(function () {
  // Returns an unsubscribe fn.
  function subscribeTable(table, onChange) {
    const sb = getSupabaseClient();
    const ch = sb.channel(`tbl:${table}`)
      .on('postgres_changes', { event: '*', schema: 'public', table }, onChange)
      .subscribe();
    return () => sb.removeChannel(ch);
  }
  window.subscribeTable = subscribeTable;
})();
