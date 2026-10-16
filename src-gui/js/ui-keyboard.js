// SPDX-License-Identifier: GPL-3.0-or-later
/* === Keyboard navigation === */
function setupKeyboard() {
  document.addEventListener("keydown", (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "");

    // F11: fullscreen, desktop app only. In a browser the key never reaches the
    // page (the browser keeps it), so `--web` users use the browser's own
    // fullscreen and this branch is simply absent for them.
    if (e.key === "F11") {
      const win = window.__TAURI__?.window?.getCurrentWindow?.();
      if (win) {
        e.preventDefault();
        win.isFullscreen().then((fs) => win.setFullscreen(!fs)).catch(() => {});
      }
      return;
    }

    // Ctrl/Cmd+K: the command palette (Linear's signature keystroke).
    if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      if (isPaletteOpen()) closePalette(); else openPalette();
      return;
    }

    // "/" focuses search (unless the user is already typing somewhere).
    if (e.key === "/" && !typing) {
      e.preventDefault();
      $("#search")?.focus();
      return;
    }

    // "?" opens the shortcuts help (Shift+/ — same key without typing context).
    if (e.key === "?" && !typing) {
      e.preventDefault();
      openHelp();
      return;
    }

    // Escape: close the palette, then the modal, then the thresholds panel,
    // else clear search+filter.
    if (e.key === "Escape") {
      if (isPaletteOpen()) { closePalette(); return; }
      if (isModalOpen()) { closeModal(); return; }
      const panel = $("#threshpanel");
      if (panel && !panel.hidden) { panel.hidden = true; return; }
      if (!typing && (activeFilter !== "all" || $("#search").value)) {
        activeFilter = "all";
        $("#search").value = "";
        document.querySelectorAll(".fpill").forEach((b) => b.classList.toggle("active", b.dataset.sev === "all"));
        syncGroupsOpen();
        applyFilters();
      }
      return;
    }

    // "1..5" jump between app views (not while typing).
    if ((e.key >= "1" && e.key <= "5") && !typing) {
      e.preventDefault();
      switchView(["overview", "history", "checks", "system", "schedule"][Number(e.key) - 1]);
      return;
    }

    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      // Card navigation belongs to Overview — never steal focus from a
      // hidden report while the user reads History or Checks.
      if (document.getElementById("view-overview")?.hidden) return;
      const cards = [...document.querySelectorAll("#report .card, #report .crow")];
      if (!cards.length) return;
      let idx = cards.indexOf(document.activeElement);
      if (e.key === "ArrowDown") idx = idx < 0 ? 0 : Math.min(cards.length - 1, idx + 1);
      else idx = idx < 0 ? 0 : Math.max(0, idx - 1);
      e.preventDefault();
      cards[idx].focus({ preventScroll: true });
      cards[idx].scrollIntoView({ block: "nearest" });
    } else if ((e.key === "Enter" || e.key === " ") && document.activeElement && (document.activeElement.classList.contains("card") || document.activeElement.classList.contains("crow"))) {
      const el = document.activeElement;
      // Wide desktop: Enter selects into the detail pane instead of
      // expanding inline — same key, the pane is the expansion.
      if (wideModeOn() && el.classList.contains("card") && el.closest("#report")) {
        e.preventDefault();
        selectFinding(el);
        return;
      }
      if (el.open) el.removeAttribute("open");
      else el.setAttribute("open", "");
      e.preventDefault();
    }
  });
}

function setAllOpen(open) {
  document.querySelectorAll("#report .group, #report .card, #report .crow").forEach((el) => {
    if (open) el.setAttribute("open", "");
    else el.removeAttribute("open");
  });
  const btn = $("#expandall");
  if (btn) btn.textContent = open ? "\u229f Collapse all" : "\u229e Expand all";
}
