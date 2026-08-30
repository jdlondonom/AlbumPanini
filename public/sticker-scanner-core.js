(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PaniniScannerCore = api;
})(typeof window !== "undefined" ? window : this, function () {
  "use strict";

  function normalizeCode(value) {
    const text = String(value ?? "").trim().toUpperCase().replace(/[\s._-]+/g, " ");
    if (text === "00") return "00";
    const match = text.match(/^([A-Z]{2,3})\s*(\d{1,2})$/);
    return match ? `${match[1]} ${Number(match[2])}` : "";
  }

  function createIndex(catalog) {
    const index = new Map();
    for (const item of catalog) {
      const code = normalizeCode(item.numero);
      if (!code || index.has(code)) throw new Error("El catálogo contiene códigos inválidos o duplicados");
      index.set(code, { ...item, code, key: `${item.seleccion}::${item.numero}` });
    }
    return index;
  }

  function candidatesFromText(value, index) {
    const text = String(value ?? "").normalize("NFKC").toUpperCase();
    const candidates = new Map();
    const add = (raw, corrected) => {
      const item = index.get(normalizeCode(raw));
      if (item && (!candidates.has(item.code) || !corrected)) candidates.set(item.code, { ...item, corrected });
    };
    if (text.trim() === "00") add("00", false);
    for (const match of text.matchAll(/(?:^|[^A-Z0-9])([A-Z]{2,3})[\s:._-]*([0-9OILS]{1,2})(?=$|[^A-Z0-9])/g)) {
      const number = match[2].replace(/O/g, "0").replace(/[IL]/g, "1").replace(/S/g, "5");
      add(`${match[1]} ${number}`, number !== match[2]);
    }
    return [...candidates.values()];
  }

  function previewUnit(progress, item) {
    const repeats = Number(progress.duplicates?.[item.key]) || 0;
    const exists = Boolean(progress.owned?.[item.key] || progress.collection?.[item.key] || repeats);
    return { action: exists ? "duplicate" : "album", duplicates: repeats, nextDuplicates: exists ? repeats + 1 : repeats, allowed: !exists || repeats < 99 };
  }

  // Convert a guide drawn over an object-fit:contain video into source pixels.
  function guideRectangle(frameWidth, frameHeight, boxWidth, boxHeight) {
    const scale = Math.min(boxWidth / frameWidth, boxHeight / frameHeight);
    const left = (boxWidth - frameWidth * scale) / 2;
    const top = (boxHeight - frameHeight * scale) / 2;
    const x = Math.max(0, (boxWidth * 0.10 - left) / scale);
    const y = Math.max(0, (boxHeight * 0.36 - top) / scale);
    return { x, y, width: Math.min(frameWidth - x, boxWidth * 0.80 / scale), height: Math.min(frameHeight - y, boxHeight * 0.28 / scale) };
  }

  return { normalizeCode, createIndex, candidatesFromText, previewUnit, guideRectangle };
});
