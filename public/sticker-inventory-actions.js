"use strict";

(function exposeStickerInventoryActions(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.StickerInventoryActions = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createStickerInventoryActions() {
  const MAX_DUPLICATES = 99;

  function normalizeSnapshot(snapshot = {}) {
    const duplicateCount = Math.trunc(Number(snapshot.duplicates) || 0);
    return {
      owned: Boolean(snapshot.owned),
      duplicates: Math.min(MAX_DUPLICATES, Math.max(0, duplicateCount))
    };
  }

  function transition(snapshot, intent) {
    const current = normalizeSnapshot(snapshot);

    if (intent === "primary") {
      if (!current.owned) {
        return { owned: true, duplicates: current.duplicates, action: "add-goal", changed: true };
      }
      if (current.duplicates >= MAX_DUPLICATES) {
        return { ...current, action: "limit", changed: false };
      }
      return { owned: true, duplicates: current.duplicates + 1, action: "add-duplicate", changed: true };
    }

    if (intent === "subtract") {
      if (current.duplicates > 0) {
        return { owned: current.owned, duplicates: current.duplicates - 1, action: "remove-duplicate", changed: true };
      }
      if (current.owned) {
        return { owned: false, duplicates: 0, action: "remove-goal", changed: true };
      }
      return { ...current, action: "none", changed: false };
    }

    throw new TypeError(`Acción de inventario inválida: ${intent}`);
  }

  function totalCopies(snapshot = {}) {
    const duplicates = normalizeSnapshot({ duplicates: snapshot.duplicates }).duplicates;
    return Number(Boolean(snapshot.albumOwned)) + Number(Boolean(snapshot.collectionOwned)) + duplicates;
  }

  return { MAX_DUPLICATES, normalizeSnapshot, totalCopies, transition };
});
