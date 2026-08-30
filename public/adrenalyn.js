(() => {
  "use strict";

  const { state, saveProgress, showToast, refreshDashboard } = window.adrenalynInventory;

  const sections = {
    golden: "Golden Ballers", team: "Selecciones", contenders: "Contenders", topKeepers: "Top Keepers",
    defensiveRocks: "Defensive Rocks", midfieldMaestros: "Midfield Maestros", goalMachines: "Goal Machines",
    masterRookies: "Master Rookies", extras: "Especiales"
  };
  const tab = document.querySelector("#adrenalynTab");
  const view = document.querySelector("#adrenalynView");
  const list = document.querySelector("#adrenalynList");
  const search = document.querySelector("#adrenalynSearch");
  const summary = document.querySelector("#adrenalynSummary");
  const markVisible = document.querySelector("#adrenalynMarkVisible");
  const clearVisible = document.querySelector("#adrenalynClearVisible");
  const exportMissing = document.querySelector("#adrenalynExportMissing");
  const filterControls = {
    country: {
      picker: document.querySelector("#adrenalynCountryPicker"), button: document.querySelector("#adrenalynCountryButton"),
      selection: document.querySelector("#adrenalynCountrySelection"), menu: document.querySelector("#adrenalynCountryMenu"),
      allLabel: "Todos los países", value: card => card.teamName || "Sin país"
    },
    team: {
      picker: document.querySelector("#adrenalynTeamPicker"), button: document.querySelector("#adrenalynTeamButton"),
      selection: document.querySelector("#adrenalynTeamSelection"), menu: document.querySelector("#adrenalynTeamMenu"),
      allLabel: "Todos los equipos", value: card => card.team || "Sin código"
    },
    type: {
      picker: document.querySelector("#adrenalynTypePicker"), button: document.querySelector("#adrenalynTypeButton"),
      selection: document.querySelector("#adrenalynTypeSelection"), menu: document.querySelector("#adrenalynTypeMenu"),
      allLabel: "Todos los tipos", value: card => sections[card.section] || "Especiales"
    }
  };
  let cards = [];
  let status = "all";
  const filters = { country: "", team: "", type: "" };

  const clean = value => String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const isOwned = card => Boolean(state.adrenalyn[String(card.number)]);
  const duplicateCount = card => Math.max(0, Number(state.adrenalynDuplicates[String(card.number)]) || 0);
  const visibleCards = () => {
    const needle = clean(search.value).trim();
    return cards.filter(card => {
      const matchesStatus = status === "all" || (status === "owned" ? isOwned(card) : !isOwned(card));
      const matchesFilters = Object.entries(filters).every(([name, value]) => !value || filterControls[name].value(card) === value);
      const haystack = clean([card.number, card.player, card.team, card.teamName, card.position, card.badge, sections[card.section]].join(" "));
      return matchesStatus && matchesFilters && (!needle || haystack.includes(needle));
    });
  };

  function openAdrenalyn() {
    document.querySelector("#catalogView").hidden = true;
    document.querySelector("#overviewView").hidden = true;
    view.hidden = false;
    document.querySelector("#catalogTab").setAttribute("aria-selected", "false");
    document.querySelector("#overviewTab").setAttribute("aria-selected", "false");
    tab.setAttribute("aria-selected", "true");
  }

  function render() {
    const visible = visibleCards();
    const owned = cards.filter(isOwned).length;
    const duplicates = cards.reduce((total, card) => total + duplicateCount(card), 0);
    summary.textContent = `${owned} de ${cards.length} obtenidas · ${cards.length - owned} faltantes · ${duplicates} repetida${duplicates === 1 ? "" : "s"} disponible${duplicates === 1 ? "" : "s"} · mostrando ${visible.length}`;
    updateFilterPickers();
    markVisible.disabled = state.locked || !visible.length;
    clearVisible.disabled = state.locked || !visible.length;
    list.replaceChildren();
    if (!cards.length) {
      list.innerHTML = '<div class="empty adrenalyn-empty"><strong>No se pudo cargar el catálogo</strong>Recarga la página e inténtalo nuevamente.</div>';
      return;
    }
    if (!visible.length) {
      list.innerHTML = '<div class="empty adrenalyn-empty"><strong>No encontramos tarjetas</strong>Prueba cambiando la búsqueda o el filtro.</div>';
      return;
    }
    const fragment = document.createDocumentFragment();
    visible.forEach(card => {
      const owned = isOwned(card);
      const repeats = duplicateCount(card);
      const article = document.createElement("article");
      article.className = `sticker adrenalyn-card${owned ? " sticker--owned" : ""}${repeats ? " sticker--duplicate" : ""}`;
      article.innerHTML = `<div class="sticker__number">${card.number}</div><div class="sticker__info"><p class="sticker__team">${card.teamName || "Edición especial"}${card.team ? ` · ${card.team}` : ""}</p><p class="sticker__player"></p><div class="sticker__meta"><span class="sticker__position">${card.position || "Especial"}</span></div><p class="adrenalyn-card__section">${sections[card.section] || "Especiales"}${card.badge ? `<span class="adrenalyn-card__badge">${card.badge}</span>` : ""}</p></div>`;
      article.querySelector(".sticker__player").textContent = card.player;
      const meta = article.querySelector(".sticker__meta");
      {
        const repeatControl = document.createElement("div");
        repeatControl.className = "duplicate-control";
        repeatControl.setAttribute("role", "group");
        repeatControl.setAttribute("aria-label", `Repetidas disponibles de la tarjeta ${card.number}, ${card.player}. Marca la tarjeta como obtenida antes de agregar repetidas.`);
        const minus = document.createElement("button");
        minus.type = "button";
        minus.className = "duplicate-control__button";
        minus.textContent = "−";
        minus.title = "Quitar una tarjeta repetida";
        minus.setAttribute("aria-label", "Quitar una tarjeta repetida");
        minus.disabled = state.locked || repeats === 0;
        minus.addEventListener("click", () => changeDuplicateCount(card, -1));
        const value = document.createElement("output");
        value.className = "duplicate-control__value";
        value.textContent = `${repeats} repetida${repeats === 1 ? " disponible" : "s disponibles"}`;
        const plus = document.createElement("button");
        plus.type = "button";
        plus.className = "duplicate-control__button";
        plus.textContent = "+";
        plus.title = "Agregar una tarjeta repetida";
        plus.setAttribute("aria-label", "Agregar una tarjeta repetida");
        plus.disabled = state.locked || repeats >= 99;
        plus.addEventListener("click", () => changeDuplicateCount(card, 1));
        repeatControl.append(minus, value, plus);
        meta.append(repeatControl);
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "toggle";
      button.disabled = state.locked;
      button.setAttribute("aria-pressed", String(owned));
      button.setAttribute("aria-label", `${owned ? "Quitar" : "Marcar"} tarjeta ${card.number}: ${card.player}`);
      button.textContent = owned ? "✓" : "+";
      button.addEventListener("click", () => {
        const key = String(card.number);
        if (state.adrenalyn[key] && repeats > 0) {
          showToast("Primero deja el contador de repetidas en cero");
          return;
        }
        if (state.adrenalyn[key]) delete state.adrenalyn[key];
        else state.adrenalyn[key] = true;
        saveProgress();
        refreshDashboard();
        render();
      });
      article.append(button);
      fragment.append(article);
    });
    list.append(fragment);
  }

  function changeDuplicateCount(card, delta) {
    if (state.locked) {
      showToast("Desbloquea la edición para cambiar repetidas");
      return;
    }
    const key = String(card.number);
    const current = duplicateCount(card);
    if (!state.adrenalyn[key] && current === 0) {
      showToast("Registra primero la tarjeta como obtenida");
      return;
    }
    const next = Math.min(99, Math.max(0, current + delta));
    if (next) state.adrenalynDuplicates[key] = next;
    else delete state.adrenalynDuplicates[key];
    saveProgress();
    refreshDashboard();
    render();
  }

  function cardsForPicker(filterName) {
    return cards.filter(card => Object.entries(filters).every(([name, value]) => name === filterName || !value || filterControls[name].value(card) === value));
  }

  function pickerStats(cardsToCount) {
    const owned = cardsToCount.filter(isOwned).length;
    return { owned, missing: cardsToCount.length - owned };
  }

  function appendPickerSelection(container, label, stats) {
    container.replaceChildren();
    const name = document.createElement("span");
    name.className = "team-picker__name";
    name.textContent = label;
    const owned = document.createElement("span");
    owned.className = "team-count team-count--owned";
    owned.textContent = `${stats.owned} obtenidas`;
    const missing = document.createElement("span");
    missing.className = "team-count team-count--missing";
    missing.textContent = `${stats.missing} faltan`;
    container.append(name, owned, missing);
  }

  function updateFilterPickers() {
    Object.entries(filterControls).forEach(([filterName, control]) => {
      const availableCards = cardsForPicker(filterName);
      const values = [...new Set(availableCards.map(control.value))].sort((a, b) => a.localeCompare(b, "es"));
      const choices = ["", ...values];
      control.menu.replaceChildren();
      choices.forEach(value => {
        const cardsForOption = value ? availableCards.filter(card => control.value(card) === value) : availableCards;
        const stats = pickerStats(cardsForOption);
        const option = document.createElement("button");
        option.type = "button";
        option.className = "team-picker__option";
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", String(filters[filterName] === value));
        option.dataset.value = value;
        const name = document.createElement("span");
        name.className = "team-picker__option-name";
        name.textContent = value || control.allLabel;
        const owned = document.createElement("span");
        owned.className = "team-count team-count--owned";
        owned.textContent = `${stats.owned} obtenidas`;
        const missing = document.createElement("span");
        missing.className = "team-count team-count--missing";
        missing.textContent = `${stats.missing} faltan`;
        option.append(name, owned, missing);
        option.addEventListener("click", () => {
          filters[filterName] = value;
          setPickerOpen(filterName, false);
          render();
        });
        control.menu.append(option);
      });
      appendPickerSelection(control.selection, filters[filterName] || control.allLabel, pickerStats(filters[filterName] ? availableCards.filter(card => control.value(card) === filters[filterName]) : availableCards));
    });
  }

  function setPickerOpen(filterName, open) {
    Object.entries(filterControls).forEach(([name, control]) => {
      const expanded = name === filterName && open;
      control.picker.classList.toggle("team-picker--open", expanded);
      control.button.setAttribute("aria-expanded", String(expanded));
      control.menu.hidden = !expanded;
    });
  }

  function updateStatus(next) {
    status = next;
    document.querySelectorAll("[data-adrenalyn-status]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.adrenalynStatus === next)));
    render();
  }

  function updateVisible(value) {
    if (state.locked) return showToast("Desbloquea la edición para cambiar tarjetas");
    const visible = visibleCards();
    let protectedCount = 0;
    visible.forEach(card => {
      const key = String(card.number);
      if (!value && duplicateCount(card) > 0) {
        protectedCount += 1;
        return;
      }
      if (value) state.adrenalyn[key] = true;
      else delete state.adrenalyn[key];
    });
    saveProgress();
    refreshDashboard();
    render();
    showToast(protectedCount ? `${protectedCount} tarjeta${protectedCount === 1 ? "" : "s"} con repetidas quedó protegida` : `${visible.length} tarjeta${visible.length === 1 ? "" : "s"} actualizada${visible.length === 1 ? "" : "s"}`);
  }

  function exportCsv() {
    const missing = cards.filter(card => !isOwned(card));
    const quote = value => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const rows = [["Número", "Serie", "Selección", "Código", "Tarjeta", "Posición", "Distintivo"], ...missing.map(card => [card.number, sections[card.section] || "Especiales", card.teamName || "", card.team || "", card.player, card.position || "", card.badge || ""])]
      .map(row => row.map(quote).join(","));
    const blob = new Blob([`\uFEFF${rows.join("\r\n")}\r\n`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `adrenalyn-xl-faltantes-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`${missing.length} faltantes exportadas a CSV`);
  }

  tab.addEventListener("click", openAdrenalyn);
  ["#catalogTab", "#overviewTab"].forEach(selector => document.querySelector(selector).addEventListener("click", () => { view.hidden = true; tab.setAttribute("aria-selected", "false"); }));
  search.addEventListener("input", render);
  document.querySelectorAll("[data-adrenalyn-status]").forEach(button => button.addEventListener("click", () => updateStatus(button.dataset.adrenalynStatus)));
  markVisible.addEventListener("click", () => updateVisible(true));
  clearVisible.addEventListener("click", () => updateVisible(false));
  exportMissing.addEventListener("click", exportCsv);
  Object.entries(filterControls).forEach(([filterName, control]) => {
    control.button.addEventListener("click", event => {
      event.stopPropagation();
      setPickerOpen(filterName, control.menu.hidden);
    });
  });
  document.addEventListener("click", event => {
    if (!Object.values(filterControls).some(control => control.picker.contains(event.target))) setPickerOpen("", false);
  });

  fetch("/assets/adrenalyn-checklist.json?v=2", {
    credentials: "same-origin",
    cache: "no-store",
  })
    .then(response => response.ok ? response.json() : Promise.reject(new Error("No se pudo cargar el catálogo")))
    .then(result => {
      if (!Array.isArray(result) || result.length !== 630 || result.some((card, index) => card.number !== index + 1)) throw new Error("Catálogo Adrenalyn XL inválido");
      cards = result;
      render();
    })
    .catch(() => {
      summary.textContent = "No se pudo cargar el catálogo Adrenalyn XL.";
      render();
    });
})();
