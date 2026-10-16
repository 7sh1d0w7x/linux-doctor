// SPDX-License-Identifier: GPL-3.0-or-later
/* === Shared modal shell === */
let modalOpener = null;

function focusableInModal(modal) {
  return [...modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.disabled && el.getClientRects().length > 0);
}

function openModal(html, label) {
  const modal = $("#modal");
  const body = $("#modal-body");
  if (!modal || !body) return;
  modalOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (label) modal.setAttribute("aria-label", label);
  body.innerHTML = html;
  modal.hidden = false;
  $("#modal-x")?.focus();
}

function closeModal() {
  const modal = $("#modal");
  if (modal && !modal.hidden) modal.hidden = true;
  if (modalOpener && document.contains(modalOpener)) modalOpener.focus();
  modalOpener = null;
}

function isModalOpen() {
  const modal = $("#modal");
  return !!modal && !modal.hidden;
}

function setupModal() {
  const modal = $("#modal");
  if (!modal) return;
  // Backdrop click closes; clicks inside the card do not.
  modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
  $("#modal-x")?.addEventListener("click", closeModal);
  // Keep Tab inside the dialog while it is open.
  modal.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const items = focusableInModal(modal);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
}

/* Keyboard shortcuts help (?). */
function openHelp() {
  openModal(
    '<div class="mx-head">Keyboard shortcuts</div>' +
    '<div class="mx-sub">Everything works with the mouse too.</div>' +
    '<div class="help-grid">' +
    "<div><kbd>\u2191</kbd> <kbd>\u2193</kbd></div><div>Navigate findings</div>" +
    "<div><kbd>Enter</kbd> / <kbd>Space</kbd></div><div>Open or close a finding</div>" +
    "<div><kbd>Ctrl</kbd> <kbd>K</kbd></div><div>Open the command palette</div>" +
    "<div><kbd>/</kbd></div><div>Focus the search box</div>" +
    "<div><kbd>1</kbd>–<kbd>5</kbd></div><div>Overview · History · Checks · System · Schedule views</div>" +
    "<div><kbd>Esc</kbd></div><div>Close this dialog \u00b7 clear search &amp; filters \u00b7 close thresholds</div>" +
    '<div><kbd>F11</kbd></div><div>Fullscreen (desktop app; the browser has its own)</div>' +
    '<div><kbd>?</kbd></div><div>Show this help</div>' +
    "</div>", "Keyboard shortcuts");
}
