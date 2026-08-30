"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../public/sticker-scanner-core");
const { loadStickerCatalog } = require("../lib/sticker-catalog");
const { emptyProgress } = require("../lib/database");

const html = fs.readFileSync(path.join(__dirname, "..", "panini-mundial-2026.html"), "utf8");
const serverCatalog = loadStickerCatalog(html);
const index = core.createIndex([...serverCatalog.values()].map(item => ({
  seleccion: item.team, numero: item.code, jugador: item.player
})));

test("el índice del lector conserva las 994 referencias y las claves usadas por el servidor", () => {
  assert.equal(index.size, 994);
  for (const [code, item] of serverCatalog) assert.equal(index.get(code).key, item.key);
  assert.equal(index.get("QAT 5").jugador, "Homam Ahmed");
  assert.equal(index.get("CC 14").seleccion, "Coca-Cola");
  assert.equal(index.get("00").seleccion, "Panini");
  assert.throws(() => core.createIndex([
    { seleccion: "Catar", numero: "QAT 5" },
    { seleccion: "Otro nombre", numero: "QAT 05" }
  ]), /duplicados/);
});

test("normalización permite confirmar QAT 5, QAT 05, CC, FWC y 00 sin crear referencias", () => {
  for (const [input, expected] of [
    ["QAT 5", "QAT 5"], [" qat05 ", "QAT 5"], ["QAT\n05", "QAT 5"],
    ["cc14", "CC 14"], ["FWC 09", "FWC 9"], ["00", "00"]
  ]) {
    assert.equal(core.normalizeCode(input), expected);
    assert.ok(index.has(core.normalizeCode(input)));
  }
  for (const input of ["QAT 5 y COL 1", "2026", "", null]) assert.equal(core.normalizeCode(input), "");
});

test("lectura exacta y caracteres O/S/I/L dudosos identifican la corrección para confirmarla", () => {
  for (const [text, code, corrected] of [
    ["QAT 5", "QAT 5", false],
    ["QAT 05", "QAT 5", false],
    ["QAT O5", "QAT 5", true],
    ["QAT S", "QAT 5", true],
    ["QAT IS", "QAT 15", true],
    ["CC IL", "CC 11", true],
    ["FWC I", "FWC 1", true],
    [" 00\n", "00", false]
  ]) {
    const found = core.candidatesFromText(text, index);
    assert.equal(found.length, 1, text);
    assert.equal(found[0].code, code, text);
    assert.equal(found[0].corrected, corrected, text);
  }
});

test("texto desconocido o sin límites claros no se convierte en una lámina válida", () => {
  for (const text of [
    "OAT 5", "ZZZ 5", "QAT 21", "QAT 0", "QAT OO", "QAT 999",
    "CC 15", "FWC 20", "COL 1X", "XCOL 1", "FIFA WORLD CUP 2026", "577"
  ]) assert.deepEqual(core.candidatesFromText(text, index), [], text);
});

test("varios códigos permanecen separados y lecturas repetidas del mismo código no crean candidatos extra", () => {
  assert.deepEqual(core.candidatesFromText("QAT 5\nCC 3\nFWC 1", index).map(item => item.code), ["QAT 5", "CC 3", "FWC 1"]);
  for (const text of ["QAT S\nQAT 5\nQAT 05", "QAT 5\nQAT S"]) {
    const found = core.candidatesFromText(text, index);
    assert.equal(found.length, 1);
    assert.equal(found[0].code, "QAT 5");
    assert.equal(found[0].corrected, false);
  }
});

test("la vista previa aplica primera copia al álbum y cualquier inventario existente a repetidas sin modificar nada", () => {
  const item = index.get("QAT 5");
  const empty = emptyProgress();
  assert.deepEqual(core.previewUnit(empty, item), { action: "album", duplicates: 0, nextDuplicates: 0, allowed: true });
  assert.deepEqual(empty, emptyProgress());
  for (const field of ["owned", "collection", "duplicates"]) {
    const progress = emptyProgress();
    progress[field][item.key] = field === "duplicates" ? 2 : true;
    progress.adrenalyn["577"] = true;
    progress.adrenalynDuplicates["577"] = 3;
    const before = structuredClone(progress);
    const outcome = core.previewUnit(progress, item);
    assert.equal(outcome.action, "duplicate", field);
    assert.equal(outcome.nextDuplicates, field === "duplicates" ? 3 : 1, field);
    assert.equal(outcome.allowed, true);
    assert.deepEqual(progress, before);
  }
});

test("la vista previa permite la repetida 99 y bloquea la unidad que excedería ese límite", () => {
  const item = index.get("QAT 5");
  const progress = emptyProgress();
  progress.duplicates[item.key] = 98;
  assert.equal(core.previewUnit(progress, item).allowed, true);
  assert.equal(core.previewUnit(progress, item).nextDuplicates, 99);
  progress.duplicates[item.key] = 99;
  assert.equal(core.previewUnit(progress, item).allowed, false);
  assert.equal(progress.duplicates[item.key], 99);
});

test("el recorte de la guía respeta el encuadre y las bandas de video en horizontal y vertical", () => {
  const cases = [
    { frame: [1920, 1080], box: [480, 270], expected: { x: 192, y: 388.8, width: 1536, height: 302.4 } },
    { frame: [1080, 1920], box: [480, 270], expected: { x: 0, y: 691.2, width: 1080, height: 537.6 } },
    { frame: [4000, 500], box: [400, 300], expected: { x: 400, y: 0, width: 3200, height: 500 } }
  ];
  for (const { frame, box, expected } of cases) {
    const actual = core.guideRectangle(...frame, ...box);
    for (const key of ["x", "y", "width", "height"]) {
      assert.ok(Number.isFinite(actual[key]));
      assert.ok(Math.abs(actual[key] - expected[key]) < 1e-8, `${frame}, ${key}: ${actual[key]}`);
    }
    assert.ok(actual.x >= 0 && actual.y >= 0);
    assert.ok(actual.x + actual.width <= frame[0] + 1e-8);
    assert.ok(actual.y + actual.height <= frame[1] + 1e-8);
  }
});
