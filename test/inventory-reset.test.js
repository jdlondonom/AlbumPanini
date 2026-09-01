"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const resetCore = require("../public/inventory-reset-core");

function populatedProgress() {
  return {
    version: 5,
    owned: { "Catar::QAT 5": true },
    collection: { "Colombia::COL 1": true },
    duplicates: { "Argentina::ARG 2": 3 },
    adrenalyn: { "24": true, "577": true },
    adrenalynDuplicates: { "577": 2 }
  };
}

test("limpiar álbum y colección conserva íntegro el inventario Adrenalyn", () => {
  const original = populatedProgress();
  const result = resetCore.reset(original, "album");

  assert.deepEqual(result, {
    version: 5,
    owned: {}, collection: {}, duplicates: {},
    adrenalyn: original.adrenalyn,
    adrenalynDuplicates: original.adrenalynDuplicates
  });
  assert.notEqual(result.adrenalyn, original.adrenalyn);
  assert.notEqual(result.adrenalynDuplicates, original.adrenalynDuplicates);
  assert.deepEqual(original, populatedProgress());
});

test("limpiar Adrenalyn conserva íntegros álbum, colección y repetidas", () => {
  const original = populatedProgress();
  const result = resetCore.reset(original, "adrenalyn");

  assert.deepEqual(result, {
    version: 5,
    owned: original.owned,
    collection: original.collection,
    duplicates: original.duplicates,
    adrenalyn: {}, adrenalynDuplicates: {}
  });
  for (const field of ["owned", "collection", "duplicates"]) assert.notEqual(result[field], original[field]);
  assert.deepEqual(original, populatedProgress());
});

test("el resumen cuenta unidades de ambos módulos y rechaza tipos desconocidos", () => {
  const progress = populatedProgress();
  assert.equal(resetCore.count(progress, "album"), 5);
  assert.equal(resetCore.count(progress, "adrenalyn"), 4);
  assert.throws(() => resetCore.reset(progress, "otro"), /Tipo de inventario inválido/);
  assert.throws(() => resetCore.count({}, "album"), /Inventario owned inválido/);
});

test("la interfaz exige confirmación, ofrece respaldo y respeta bloqueo y sincronización", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "panini-mundial-2026.html"), "utf8");
  for (const id of ["dataResetButton", "dataResetDialog", "dataResetCancel", "dataResetExport", "dataResetConfirm"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.ok(html.indexOf("/assets/inventory-reset-core.js") < html.indexOf("function performDataReset"));
  assert.match(html, /state\.locked \|\| dataResetBusy \|\| !progressSync\?\.ready \|\| progressSync\.pending \|\| progressSync\.conflicted/);
  assert.match(html, /if \(dataResetBusy\) event\.preventDefault\(\)/);
});
