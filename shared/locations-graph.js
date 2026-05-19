// shared/locations-graph.js
// FC-themed Mermaid graph renderer for the locations hierarchy.
// Shared between staff-home (read-only) and admin Locations tab (Graph view tab).
//
// Public API: window.LocationsGraph.render(containerEl, locations, opts?)
//   containerEl — DOM element that will receive the graph + legend
//   locations   — array of rows: { id, code, name, type, parent_id, active,
//                                  storage_style?, laundry_role?, ambulances?{plate,callsign} }
//   opts        — { showLegend?: true, maxHeight?: '70vh', onNodeClick?: fn(loc) }
//
// Requires: window.mermaid (loaded from CDN), window.escapeHtml.

(function () {
  'use strict';

  function _esc(s) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(s);
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Mermaid label text inside ["..."] uses HTML, but quotes must be escaped.
  function _escMer(s) {
    return String(s ?? '').replace(/"/g, '#quot;');
  }

  function _nodeLabel(l) {
    const lines = [_escMer(l.code), _escMer(l.name)];
    if (l.type === 'storage' && l.storage_style) {
      const styleLabel = ({closed:'ตู้ปิด', open:'ชั้นเปิด', mesh:'ตะแกรง', drawer:'ลิ้นชัก'})[l.storage_style] || l.storage_style;
      lines.push(`(${styleLabel})`);
    }
    if (l.laundry_role) {
      const roleLabel = ({clean:'พร้อมใช้', vehicle:'ในรถ', dirty:'รอซัก', external:'กำลังซัก'})[l.laundry_role] || l.laundry_role;
      lines.push(`🧺 ${roleLabel}`);
    }
    if (l.type === 'ambulance' && l.ambulances) {
      const plate = l.ambulances.plate || '';
      const cs = l.ambulances.callsign ? ` · ${l.ambulances.callsign}` : '';
      lines.push(`${plate}${cs}`);
    }
    return lines.join('<br/>');
  }

  function _buildMermaidSource(locations) {
    const lines = ['graph TD'];

    locations.forEach((l) => {
      const safeId = `n_${l.id.replace(/-/g, '_')}`;
      lines.push(`  ${safeId}["${_nodeLabel(l)}"]:::${l.type}`);
    });

    locations.forEach((l) => {
      if (l.parent_id) {
        const parent = locations.find((p) => p.id === l.parent_id);
        if (parent) {
          const pId = `n_${parent.id.replace(/-/g, '_')}`;
          const cId = `n_${l.id.replace(/-/g, '_')}`;
          lines.push(`  ${pId} --> ${cId}`);
        }
      }
    });

    // FC palette per type
    lines.push('  classDef room      fill:#0c1929,stroke:#00B8A9,color:#f8f5ef,stroke-width:2px');
    lines.push('  classDef ambulance fill:#1d4d8c,stroke:#00B8A9,color:#f8f5ef,stroke-width:2px');
    lines.push('  classDef storage   fill:#f8f5ef,stroke:#00B8A9,color:#0c1929,stroke-width:1.5px');
    lines.push('  classDef cabinet   fill:#f8f5ef,stroke:#00B8A9,color:#0c1929,stroke-width:1.5px');
    lines.push('  classDef shelf     fill:#ffffff,stroke:#7a8a9a,color:#0c1929,stroke-width:1px');
    lines.push('  classDef bin       fill:#ffffff,stroke:#a8b4c0,color:#0c1929,stroke-width:1px');
    lines.push('  classDef bag       fill:#f59e0b,stroke:#7a4f00,color:#ffffff,stroke-width:2px');
    lines.push('  classDef zone      fill:#fff7e6,stroke:#f59e0b,color:#7a4f00,stroke-width:1px');

    // Hover cursor for clickable nodes (if onNodeClick is provided, JS wires it)
    return lines.join('\n');
  }

  function _legendHtml() {
    return `
      <div class="locgraph-legend" style="display:flex;flex-wrap:wrap;gap:var(--fc-s3);margin-bottom:var(--fc-s3);font-size:11px;font-family:var(--fc-font-mono);letter-spacing:0.05em;text-transform:uppercase;color:var(--fc-ink-mute)">
        <span><span style="display:inline-block;width:10px;height:10px;background:#0c1929;border:2px solid #00B8A9;vertical-align:middle;margin-right:4px"></span>room/ambulance</span>
        <span><span style="display:inline-block;width:10px;height:10px;background:#f8f5ef;border:1.5px solid #00B8A9;vertical-align:middle;margin-right:4px"></span>storage</span>
        <span><span style="display:inline-block;width:10px;height:10px;background:#fff;border:1px solid #7a8a9a;vertical-align:middle;margin-right:4px"></span>shelf/bin</span>
        <span><span style="display:inline-block;width:10px;height:10px;background:#f59e0b;border:2px solid #7a4f00;vertical-align:middle;margin-right:4px"></span>bag/zone</span>
      </div>`;
  }

  async function render(containerEl, locations, opts) {
    if (!containerEl) return;
    opts = opts || {};
    const showLegend = opts.showLegend !== false;
    const maxHeight = opts.maxHeight || '70vh';

    if (!locations || !locations.length) {
      containerEl.innerHTML = `
        <div class="fc-empty">
          <svg class="fc-empty-icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="9" x2="15" y2="9"/></svg>
          <span class="fc-empty-label">// no locations defined</span>
        </div>`;
      return;
    }

    containerEl.innerHTML = `
      ${showLegend ? _legendHtml() : ''}
      <div class="locgraph-canvas" style="overflow:auto;max-height:${maxHeight};border:1px solid var(--fc-hairline-strong, rgba(12,25,41,0.08));border-radius:8px;padding:var(--fc-s4);background:repeating-linear-gradient(0deg,transparent,transparent 19px,rgba(12,25,41,0.04) 19px,rgba(12,25,41,0.04) 20px),repeating-linear-gradient(90deg,transparent,transparent 19px,rgba(12,25,41,0.04) 19px,rgba(12,25,41,0.04) 20px),#fafbfc">
        <pre class="mermaid" style="background:transparent;margin:0">${_buildMermaidSource(locations)}</pre>
      </div>`;

    if (!window.mermaid) {
      const canvas = containerEl.querySelector('.locgraph-canvas');
      if (canvas) {
        canvas.innerHTML = `<div class="alert alert-warning small">Mermaid library ไม่ได้โหลด — ตรวจสอบ network</div>`;
      }
      return;
    }

    try {
      mermaid.initialize({
        startOnLoad: false,
        theme: 'base',
        themeVariables: {
          fontFamily: 'Sarabun, "IBM Plex Sans Thai", sans-serif',
          fontSize: '13px',
          lineColor: '#7a8a9a',
          primaryColor: '#f8f5ef',
          primaryTextColor: '#0c1929',
        },
      });
      await mermaid.run({ nodes: containerEl.querySelectorAll('pre.mermaid') });

      // Wire node clicks if handler provided
      if (typeof opts.onNodeClick === 'function') {
        containerEl.querySelectorAll('g.node').forEach((g) => {
          g.style.cursor = 'pointer';
          g.addEventListener('click', () => {
            // mermaid node id format: flowchart-n_<uuid>-0 (or similar) — extract uuid
            const m = (g.id || '').match(/n_([0-9a-f_]{32,})/i);
            if (!m) return;
            const uuid = m[1].replace(/_/g, '-');
            const loc = locations.find((x) => x.id === uuid);
            if (loc) opts.onNodeClick(loc);
          });
        });
      }
    } catch (e) {
      console.warn('LocationsGraph.render failed', e);
      const canvas = containerEl.querySelector('.locgraph-canvas');
      if (canvas) {
        canvas.innerHTML = `<div class="alert alert-warning small">วาด graph ไม่สำเร็จ: ${_esc(e.message || e)}</div>`;
      }
    }
  }

  window.LocationsGraph = { render };
})();
