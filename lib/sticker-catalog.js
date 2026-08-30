"use strict";

function normalizeStickerCode(value) {
  if (typeof value !== "string" || value.length > 32) return null;
  const text = value.trim().toUpperCase();
  if (text === "00") return text;
  const match = text.match(/^([A-Z]{2,3})\s*([0-9]{1,3})$/);
  if (!match || Number(match[2]) < 1) return null;
  return `${match[1]} ${Number(match[2])}`;
}

function readCatalogLiteral(html, name) {
  const matches = [...html.matchAll(new RegExp(`\\bconst\\s+${name}\\s*=\\s*(\\[[\\s\\S]*?\\])\\s*;`, "g"))];
  if (matches.length !== 1) throw new Error(`No se pudo leer el catálogo ${name}`);
  // The browser and server use the same data. Never execute JavaScript from HTML.
  const entries = JSON.parse(matches[0][1]);
  if (!Array.isArray(entries)) throw new Error(`Catálogo inválido: ${name}`);
  return entries;
}

function loadStickerCatalog(html) {
  const entries = [
    ...readCatalogLiteral(html, "CATALOGO_LAMINAS"),
    ...readCatalogLiteral(html, "COCA_COLA_LAMINAS")
  ];
  const catalog = new Map();
  for (const entry of entries) {
    const code = normalizeStickerCode(entry.numero);
    if (!code || code !== entry.numero || typeof entry.seleccion !== "string" || !entry.seleccion.trim()) {
      throw new Error("El catálogo contiene una referencia de lámina inválida");
    }
    if (catalog.has(code)) throw new Error(`Código de lámina duplicado en el catálogo: ${code}`);
    catalog.set(code, Object.freeze({
      code,
      key: `${entry.seleccion}::${entry.numero}`,
      team: entry.seleccion,
      player: entry.jugador
    }));
  }
  return catalog;
}

module.exports = { loadStickerCatalog, normalizeStickerCode };
