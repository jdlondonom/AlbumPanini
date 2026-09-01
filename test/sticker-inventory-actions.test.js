"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const actions = require("../public/sticker-inventory-actions");

test("el botón principal agrega primero la lámina y después suma repetidas", () => {
  const firstCopy = actions.transition({ owned: false, duplicates: 0 }, "primary");
  assert.deepEqual(firstCopy, { owned: true, duplicates: 0, action: "add-goal", changed: true });

  const firstDuplicate = actions.transition(firstCopy, "primary");
  assert.deepEqual(firstDuplicate, { owned: true, duplicates: 1, action: "add-duplicate", changed: true });
  assert.equal(actions.transition(firstDuplicate, "primary").duplicates, 2);
});

test("restar consume las repetidas antes de retirar la lámina del objetivo activo", () => {
  const oneLess = actions.transition({ owned: true, duplicates: 2 }, "subtract");
  assert.deepEqual(oneLess, { owned: true, duplicates: 1, action: "remove-duplicate", changed: true });
  const zeroDuplicates = actions.transition(oneLess, "subtract");
  assert.deepEqual(zeroDuplicates, { owned: true, duplicates: 0, action: "remove-duplicate", changed: true });
  assert.deepEqual(actions.transition(zeroDuplicates, "subtract"), {
    owned: false, duplicates: 0, action: "remove-goal", changed: true
  });
});

test("los límites normalizan el contador y bloquean la repetida número 100", () => {
  assert.deepEqual(actions.normalizeSnapshot({ owned: 1, duplicates: -4 }), { owned: true, duplicates: 0 });
  assert.deepEqual(actions.normalizeSnapshot({ owned: false, duplicates: 104 }), { owned: false, duplicates: 99 });
  assert.deepEqual(actions.transition({ owned: true, duplicates: 99 }, "primary"), {
    owned: true, duplicates: 99, action: "limit", changed: false
  });
  assert.deepEqual(actions.transition({ owned: false, duplicates: 0 }, "subtract"), {
    owned: false, duplicates: 0, action: "none", changed: false
  });
  assert.throws(() => actions.transition({}, "otro"), /inválida/);
});

test("reservar una repetida cambia su ubicación pero conserva el total de copias", () => {
  const before = { albumOwned: true, collectionOwned: false, duplicates: 3 };
  const afterReservation = { albumOwned: true, collectionOwned: true, duplicates: 2 };
  assert.equal(actions.totalCopies(before), 4);
  assert.equal(actions.totalCopies(afterReservation), 4);
  assert.equal(actions.totalCopies({ albumOwned: true, collectionOwned: true, duplicates: 3 }), 5);
  assert.equal(actions.totalCopies({}), 0);
});

test("la interfaz usa el control fijo y carga su lógica antes de crear las láminas", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "panini-mundial-2026.html"), "utf8");
  assert.ok(html.indexOf("/assets/sticker-inventory-actions.js") < html.indexOf("function createSticker"));
  assert.match(html, /className = "sticker__actions"/);
  assert.match(html, /performStickerInventoryAction\(item, "primary"\)/);
  assert.match(html, /performStickerInventoryAction\(item, "subtract"\)/);
  assert.match(html, /className = "sticker__inventory-label sticker__available-label"/);
  assert.match(html, /`Disponibles: \$\{duplicateCount\}`/);
  assert.match(html, /className = "sticker__inventory-label sticker__total-label"/);
  assert.match(html, /`Total: \$\{totalCopies\}`/);
  assert.doesNotMatch(html, /toggle__count/);
  assert.doesNotMatch(html, /className = "duplicate-control"/);
});
