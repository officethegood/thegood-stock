// shared/icons.js — FC Icon system
// window.Icons.<name>(cls) -> inline SVG string
// All icons: 24x24, stroke-based, currentColor, strokeWidth=1.8

(function () {
  const SVG_OPEN = (cls) =>
    `<svg class="fc-icon${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="24" height="24">`;
  const SVG_CLOSE = '</svg>';

  window.Icons = {

    // Medical cross — brand mark + "OK" state (chunky plus in square)
    cross: (cls = '') => SVG_OPEN(cls) +
      '<rect x="3" y="3" width="18" height="18" rx="3"/>' +
      '<path d="M12 7v10M7 12h10"/>' +
      SVG_CLOSE,

    // Printer
    printer: (cls = '') => SVG_OPEN(cls) +
      '<polyline points="6 9 6 2 18 2 18 9"/>' +
      '<path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>' +
      '<rect x="6" y="14" width="12" height="8"/>' +
      SVG_CLOSE,

    // Alert / warning triangle
    alert: (cls = '') => SVG_OPEN(cls) +
      '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>' +
      '<line x1="12" y1="9" x2="12" y2="13"/>' +
      '<line x1="12" y1="17" x2="12.01" y2="17"/>' +
      SVG_CLOSE,

    // Pulse / heartbeat
    pulse: (cls = '') => SVG_OPEN(cls) +
      '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>' +
      SVG_CLOSE,

    // Box / inventory
    box: (cls = '') => SVG_OPEN(cls) +
      '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>' +
      '<polyline points="3.27 6.96 12 12.01 20.73 6.96"/>' +
      '<line x1="12" y1="22.08" x2="12" y2="12"/>' +
      SVG_CLOSE,

    // Pill bottle / medication
    'pill-bottle': (cls = '') => SVG_OPEN(cls) +
      '<rect x="8" y="2" width="8" height="3" rx="1"/>' +
      '<rect x="6" y="5" width="12" height="16" rx="2"/>' +
      '<line x1="12" y1="10" x2="12" y2="16"/>' +
      '<line x1="9" y1="13" x2="15" y2="13"/>' +
      SVG_CLOSE,

    // Vial / lab
    vial: (cls = '') => SVG_OPEN(cls) +
      '<path d="M9 3h6M8 3v10l-2 5a1 1 0 0 0 .93 1.36h10.14A1 1 0 0 0 18 18l-2-5V3"/>' +
      '<line x1="8" y1="10" x2="16" y2="10"/>' +
      SVG_CLOSE,

    // Bag / ALS bag / medical bag
    bag: (cls = '') => SVG_OPEN(cls) +
      '<path d="M6 2 L3 6 L3 20 a2 2 0 0 0 2 2 L19 22 a2 2 0 0 0 2-2 L21 6 L18 2 Z"/>' +
      '<path d="M3 6h18"/>' +
      '<path d="M12 10v6M9 13h6"/>' +
      SVG_CLOSE,

    // Cylinder / oxygen tank
    cylinder: (cls = '') => SVG_OPEN(cls) +
      '<ellipse cx="12" cy="5" rx="5" ry="2"/>' +
      '<path d="M7 5v14a5 2 0 0 0 10 0V5"/>' +
      '<line x1="10" y1="2" x2="14" y2="2"/>' +
      '<line x1="12" y1="2" x2="12" y2="5"/>' +
      SVG_CLOSE,

    // Linen / folded fabric
    linen: (cls = '') => SVG_OPEN(cls) +
      '<rect x="2" y="6" width="20" height="14" rx="2"/>' +
      '<path d="M2 10h20M2 14h20"/>' +
      '<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' +
      SVG_CLOSE,

    // Ambulance
    ambulance: (cls = '') => SVG_OPEN(cls) +
      '<rect x="1" y="8" width="15" height="13" rx="1"/>' +
      '<path d="M16 8l4 4v9H16"/>' +
      '<path d="M1 21h20"/>' +
      '<circle cx="6.5" cy="19" r="2"/>' +
      '<circle cx="18.5" cy="19" r="2"/>' +
      '<path d="M7 4h4M9 2v4"/>' +
      SVG_CLOSE,

    // Scan / camera + QR frame
    scan: (cls = '') => SVG_OPEN(cls) +
      '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/>' +
      '<rect x="7" y="7" width="10" height="10" rx="1"/>' +
      SVG_CLOSE,

    // Chevron right
    'chevron-right': (cls = '') => SVG_OPEN(cls) +
      '<polyline points="9 18 15 12 9 6"/>' +
      SVG_CLOSE,

    // Chevron down
    'chevron-down': (cls = '') => SVG_OPEN(cls) +
      '<polyline points="6 9 12 15 18 9"/>' +
      SVG_CLOSE,

    // Close / X
    close: (cls = '') => SVG_OPEN(cls) +
      '<line x1="18" y1="6" x2="6" y2="18"/>' +
      '<line x1="6" y1="6" x2="18" y2="18"/>' +
      SVG_CLOSE,

    // Check / checkmark
    check: (cls = '') => SVG_OPEN(cls) +
      '<polyline points="20 6 9 17 4 12"/>' +
      SVG_CLOSE,

    // Search / magnifier
    search: (cls = '') => SVG_OPEN(cls) +
      '<circle cx="11" cy="11" r="8"/>' +
      '<line x1="21" y1="21" x2="16.65" y2="16.65"/>' +
      SVG_CLOSE,

    // Filter / 3-line funnel
    filter: (cls = '') => SVG_OPEN(cls) +
      '<line x1="4" y1="6" x2="20" y2="6"/>' +
      '<line x1="7" y1="12" x2="17" y2="12"/>' +
      '<line x1="10" y1="18" x2="14" y2="18"/>' +
      SVG_CLOSE,

    // Settings / gear
    settings: (cls = '') => SVG_OPEN(cls) +
      '<circle cx="12" cy="12" r="3"/>' +
      '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>' +
      SVG_CLOSE,

    // Logout / door + arrow
    logout: (cls = '') => SVG_OPEN(cls) +
      '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>' +
      '<polyline points="16 17 21 12 16 7"/>' +
      '<line x1="21" y1="12" x2="9" y2="12"/>' +
      SVG_CLOSE,

    // Arrow left / back
    'arrow-left': (cls = '') => SVG_OPEN(cls) +
      '<line x1="19" y1="12" x2="5" y2="12"/>' +
      '<polyline points="12 19 5 12 12 5"/>' +
      SVG_CLOSE,

    // Plus / add
    plus: (cls = '') => SVG_OPEN(cls) +
      '<line x1="12" y1="5" x2="12" y2="19"/>' +
      '<line x1="5" y1="12" x2="19" y2="12"/>' +
      SVG_CLOSE,

    // Trash / delete
    trash: (cls = '') => SVG_OPEN(cls) +
      '<polyline points="3 6 5 6 21 6"/>' +
      '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>' +
      '<path d="M10 11v6M14 11v6"/>' +
      '<path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>' +
      SVG_CLOSE,

    // Edit / pencil
    edit: (cls = '') => SVG_OPEN(cls) +
      '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>' +
      '<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>' +
      SVG_CLOSE,
  };
})();
