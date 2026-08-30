"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { randomUUID } = require("node:crypto");
const core = require("../public/sticker-scanner-core");
const { loadStickerCatalog } = require("../lib/sticker-catalog");

const html = fs.readFileSync(path.join(__dirname, "..", "panini-mundial-2026.html"), "utf8");
const script = fs.readFileSync(path.join(__dirname, "..", "public", "sticker-scanner.js"), "utf8");
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
const catalog = [...loadStickerCatalog(html).values()].map(item => ({ seleccion: item.team, numero: item.code, jugador: item.player }));
const pendingBase = "mi-album-mundial-2026:scan-pending:user:scanner-ui-fixture";
const tick = () => new Promise(resolve => setImmediate(resolve));
const pendingKey = record => `${pendingBase}:${record.scanId}`;

class MemoryStorage {
  constructor() { this.values = new Map(); }
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) {
    if (this.writeError) throw new Error("Storage unavailable");
    this.values.set(String(key), String(value));
  }
  removeItem(key) { this.values.delete(key); }
}

class Element {
  constructor(id) {
    this.id = id;
    this.listeners = new Map();
    this.value = "";
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.dataset = {};
    this.classList = { add() {}, remove() {} };
  }
  addEventListener(name, callback) {
    const callbacks = this.listeners.get(name) || [];
    callbacks.push(callback);
    this.listeners.set(name, callbacks);
  }
  emit(name, properties = {}) {
    const event = { type: name, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...properties };
    for (const callback of this.listeners.get(name) || []) callback(event);
    return event;
  }
  click() { if (!this.disabled) return this.emit("click"); }
  showModal() { this.open = true; }
  close() { this.open = false; this.emit("close"); }
  removeAttribute(name) { delete this[name]; }
  focus() { this.focused = true; }
  play() { return Promise.resolve(); }
  getBoundingClientRect() { return { width: 480, height: 270 }; }
}

function confirmation(code = "QAT 5") { return { scanId: randomUUID(), code, expectedRevision: 0 }; }
function success(record, replayed = false) {
  return { scan: { id: record.scanId, code: record.code, action: "album", duplicates: 0 }, revision: 1, replayed };
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function error(properties) { return Object.assign(new Error("Simulated failure"), properties); }

function fixture(options = {}) {
  const storage = options.storage || new MemoryStorage();
  const nodes = new Map();
  const element = id => {
    assert.ok(ids.has(id), `El elemento ${id} debe existir en el HTML real`);
    if (!nodes.has(id)) nodes.set(id, new Element(id));
    return nodes.get(id);
  };
  const requests = [];
  const timers = new Map();
  let nextTimer = 0;
  const inventory = {
    catalog, userId: "scanner-ui-fixture",
    state: { owned: {}, collection: {}, duplicates: {}, locked: false },
    showToast() {},
    sync: {
      revision: 0, conflicted: false,
      refresh: async () => options.refresh?.(inventory),
      scan: async record => {
        requests.push(structuredClone(record));
        return options.scan ? options.scan(record, inventory) : success(record);
      }
    }
  };
  const window = new Element("window");
  Object.assign(window, { stickerInventory: inventory, PaniniScannerCore: core, isSecureContext: true, Tesseract: options.tesseract });
  const document = new Element("document");
  Object.assign(document, {
    getElementById: element,
    createElement: name => {
      assert.equal(name, "canvas", "Estas pruebas no cargan librerías ni hacen peticiones externas");
      return {
        width: 1, height: 1,
        getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(4) }), putImageData() {} }),
        toDataURL: () => "data:image/jpeg;base64,c3ludGhldGlj"
      };
    }
  });
  Object.assign(element("scannerVideo"), { videoWidth: 1920, videoHeight: 1080 });
  vm.runInNewContext(script, {
    window, document,
    navigator: { mediaDevices: { getUserMedia: options.camera || (() => Promise.reject(error({ name: "NotAllowedError" }))) } },
    localStorage: storage,
    crypto: { randomUUID },
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
    console
  }, { filename: "sticker-scanner.js" });
  return {
    element, storage, requests, inventory, timers, document, window,
    open: () => element("openStickerScanner").click(),
    async manual(code = "QAT 5") {
      if (!element("stickerScanner").open) element("openStickerScanner").click();
      element("scannerManual").click();
      await tick();
      element("scannerCode").value = code;
      element("scannerCode").emit("input");
    },
    confirm: () => element("scannerConfirmForm").emit("submit")
  };
}

test("abrir, corregir y cancelar el escáner no envía una lámina al servidor", async () => {
  const ui = fixture();
  await ui.manual("QAT 99");
  assert.equal(ui.element("scannerConfirm").disabled, true);
  ui.confirm();
  assert.equal(ui.requests.length, 0);
  ui.element("scannerCode").value = "QAT 5";
  ui.element("scannerCode").emit("input");
  assert.equal(ui.element("scannerConfirm").disabled, false);
  ui.element("scannerClose").click();
  assert.equal(ui.element("stickerScanner").open, false);
  assert.equal(ui.requests.length, 0);
  assert.equal(ui.storage.length, 0);
});

test("doble confirmación y Escape mientras se guarda no crean otro registro; otra copia exige confirmar otra vez", async () => {
  const response = deferred();
  const ui = fixture({ scan: record => ui.requests.length === 1 ? response.promise : success(record) });
  await ui.manual();
  ui.confirm();
  ui.confirm();
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.storage.length, 1);
  assert.equal(ui.element("scannerClose").disabled, true);
  assert.equal(ui.element("stickerScanner").emit("cancel").defaultPrevented, true);
  const firstId = ui.requests[0].scanId;
  response.resolve(success(ui.requests[0]));
  await tick();
  assert.equal(ui.storage.length, 0);
  assert.equal(ui.element("scannerSavedPanel").hidden, false);
  ui.element("scannerNext").click();
  assert.equal(ui.requests.length, 1);
  await ui.manual();
  assert.equal(ui.requests.length, 1);
  ui.confirm();
  await tick();
  assert.equal(ui.requests.length, 2);
  assert.notEqual(ui.requests[1].scanId, firstId);
});

test("401, 403, fallo de red, 5xx y conflicto previo al POST conservan el identificador recuperable", async t => {
  for (const [name, failure] of [
    ["sesión expirada", error({ status: 401, code: "auth", requestPath: "/api/scans" })],
    ["CSRF rotado", error({ status: 403, code: "csrf", requestPath: "/api/scans" })],
    ["respuesta perdida", error({ code: "network" })],
    ["error interno", error({ status: 500, requestPath: "/api/scans" })],
    ["conflicto en guardado previo", error({ status: 409, code: "conflict", requestPath: "/api/progress", data: { errorCode: "PROGRESS_CONFLICT" } })]
  ]) await t.test(name, async () => {
    const record = confirmation();
    const storage = new MemoryStorage();
    storage.setItem(pendingKey(record), JSON.stringify(record));
    const ui = fixture({ storage, scan: async () => { throw failure; } });
    ui.open();
    assert.equal(ui.element("scannerRecoveryPanel").hidden, false);
    ui.element("scannerRecover").click();
    await tick();
    assert.equal(ui.requests[0].scanId, record.scanId);
    assert.equal(JSON.parse(storage.getItem(pendingKey(record))).scanId, record.scanId);
    assert.equal(ui.element("scannerRecoveryPanel").hidden, false);
    assert.equal(ui.element("scannerClose").disabled, false);
    ui.element("scannerClose").click();
    ui.open();
    assert.equal(ui.element("scannerRecoveryPanel").hidden, false);
  });
});

test("recuperar una confirmación ya guardada elimina solo su propia clave y conserva las demás", async () => {
  const first = { ...confirmation(), scanId: "11111111-1111-4111-8111-111111111111" };
  const second = { ...confirmation("QAT 6"), scanId: "22222222-2222-4222-8222-222222222222" };
  const storage = new MemoryStorage();
  for (const record of [first, second]) storage.setItem(pendingKey(record), JSON.stringify(record));
  const ui = fixture({ storage, scan: async record => success(record, true) });
  ui.open();
  ui.element("scannerRecover").click();
  await tick();
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.requests[0].scanId, first.scanId);
  assert.equal(storage.getItem(pendingKey(first)), null);
  assert.notEqual(storage.getItem(pendingKey(second)), null);
  assert.match(ui.element("scannerSavedDetail").textContent, /no se sumó otra unidad/);
  ui.element("scannerNext").click();
  assert.equal(ui.element("scannerRecoveryPanel").hidden, false);
  assert.match(ui.element("scannerRecoveryDetail").textContent, /QAT 6/);
  assert.equal(ui.requests.length, 1);
});

test("un rechazo definitivo del servidor exige revisar el inventario y confirmar con un identificador nuevo", async () => {
  const record = confirmation();
  const storage = new MemoryStorage();
  storage.setItem(pendingKey(record), JSON.stringify(record));
  const ui = fixture({ storage, scan: async (request, inventory) => {
    if (ui.requests.length > 1) return success(request);
    inventory.sync.revision = 2;
    inventory.state.owned["Catar::QAT 5"] = true;
    throw error({ status: 409, code: "conflict", requestPath: "/api/scans", data: { errorCode: "PROGRESS_CONFLICT" } });
  } });
  ui.open();
  ui.element("scannerRecover").click();
  await tick();
  assert.equal(storage.getItem(pendingKey(record)), null);
  assert.equal(ui.element("scannerReviewPanel").hidden, false);
  assert.match(ui.element("scannerOutcome").textContent, /Repetidas: 0 → 1/);
  assert.equal(ui.requests.length, 1);
  ui.confirm();
  await tick();
  assert.equal(ui.requests.length, 2);
  assert.equal(ui.requests[1].expectedRevision, 2);
  assert.notEqual(ui.requests[1].scanId, record.scanId);
});

test("una segunda pestaña detecta la confirmación pendiente y no sobrescribe su identificador", async () => {
  const storage = new MemoryStorage();
  const response = deferred();
  const first = fixture({ storage, scan: () => response.promise });
  const second = fixture({ storage });
  await first.manual();
  await second.manual("QAT 6");
  first.confirm();
  const record = first.requests[0];
  second.confirm();
  assert.equal(second.requests.length, 0);
  assert.equal(second.element("scannerRecoveryPanel").hidden, false);
  assert.equal(storage.length, 1);
  assert.equal(JSON.parse(storage.getItem(pendingKey(record))).scanId, record.scanId);
  response.resolve(success(record));
  await tick();
});

test("sin almacenamiento durable o con confirmaciones ilegibles no se permite guardar otra unidad", async () => {
  const storage = new MemoryStorage();
  const ui = fixture({ storage });
  await ui.manual();
  storage.writeError = true;
  ui.confirm();
  await tick();
  assert.equal(ui.requests.length, 0);
  assert.match(ui.element("scannerMessage").textContent, /Habilita el almacenamiento/);
  ui.element("scannerClose").click();
  storage.writeError = false;
  storage.setItem(`${pendingBase}:broken`, "{malformed");
  ui.open();
  assert.equal(ui.element("scannerRecoveryPanel").hidden, false);
  assert.equal(ui.element("scannerRecover").disabled, true);
  assert.equal(ui.requests.length, 0);
});

test("cerrar el escáner apaga la cámara incluso si el permiso llega después del cierre", async () => {
  let stops = 0;
  const stream = { getTracks: () => [{ stop() { stops += 1; } }] };
  const permission = deferred();
  const ui = fixture({ camera: () => permission.promise });
  ui.open();
  ui.element("scannerStartCamera").click();
  ui.element("scannerClose").click();
  permission.resolve(stream);
  await tick();
  assert.equal(stops, 1);
  assert.equal(ui.element("scannerVideo").srcObject, null);
  const active = fixture({ camera: async () => stream });
  active.open();
  active.element("scannerStartCamera").click();
  await tick();
  assert.equal(active.element("scannerVideo").srcObject, stream);
  active.element("scannerClose").click();
  assert.equal(stops, 2);
});

test("el plazo de una lectura cancelada no termina el lector de una captura nueva", async () => {
  const workers = [];
  const ui = fixture({
    camera: async () => ({ getTracks: () => [{ stop() {} }] }),
    tesseract: { createWorker: async () => {
      const worker = { terminated: 0, setParameters: async () => {}, recognize: () => new Promise(() => {}), terminate: async () => { worker.terminated += 1; } };
      workers.push(worker);
      return worker;
    } }
  });
  ui.open();
  ui.element("scannerStartCamera").click();
  await tick();
  ui.element("scannerCapture").click();
  await tick();
  const oldDeadline = [...ui.timers.keys()][0];
  assert.equal(workers.length, 1);
  ui.element("scannerClose").click();
  await tick();
  assert.equal(workers[0].terminated, 1);
  ui.open();
  ui.element("scannerStartCamera").click();
  await tick();
  ui.element("scannerCapture").click();
  await tick();
  assert.equal(workers.length, 2);
  ui.timers.get(oldDeadline)?.();
  await tick();
  assert.equal(workers[1].terminated, 0, "Una lectura obsoleta no debe cancelar el worker de la nueva");
  ui.element("scannerClose").click();
  await tick();
});

test("un fallo tardío al iniciar el lector anterior no impide apagar el lector actual", async () => {
  const initialWorker = deferred();
  let starts = 0;
  const currentWorker = { terminated: 0, setParameters: async () => {}, recognize: () => new Promise(() => {}), terminate: async () => { currentWorker.terminated += 1; } };
  const ui = fixture({
    camera: async () => ({ getTracks: () => [{ stop() {} }] }),
    tesseract: { createWorker: () => ++starts === 1 ? initialWorker.promise : Promise.resolve(currentWorker) }
  });
  ui.open();
  ui.element("scannerStartCamera").click();
  await tick();
  ui.element("scannerCapture").click();
  await tick();
  assert.equal(starts, 1);
  ui.element("scannerClose").click();
  ui.open();
  ui.element("scannerStartCamera").click();
  await tick();
  ui.element("scannerCapture").click();
  await tick();
  assert.equal(starts, 2);
  initialWorker.reject(new Error("The old worker failed to initialize"));
  await tick();
  ui.element("scannerClose").click();
  await tick();
  assert.equal(currentWorker.terminated, 1, "Se debe conservar la referencia al lector actual hasta cerrarlo");
});

test("el lector que termina de inicializarse después del plazo no recibe un trabajo nuevo", async () => {
  const initialization = deferred();
  const worker = {
    terminated: 0, calls: 0,
    setParameters: async () => {},
    recognize: async () => { worker.calls += 1; return { data: { text: "QAT 5" } }; },
    terminate: async () => { worker.terminated += 1; }
  };
  const ui = fixture({
    camera: async () => ({ getTracks: () => [{ stop() {} }] }),
    tesseract: { createWorker: () => initialization.promise }
  });
  ui.open();
  ui.element("scannerStartCamera").click();
  await tick();
  ui.element("scannerCapture").click();
  await tick();
  [...ui.timers.values()][0]();
  await tick();
  assert.equal(ui.element("scannerReviewPanel").hidden, false, "El plazo debe permitir corregir manualmente");
  initialization.resolve(worker);
  await tick();
  assert.equal(worker.calls, 0, "Un trabajo vencido no debe reconocer con un worker ya terminado");
  assert.equal(worker.terminated, 1);
  ui.element("scannerClose").click();
});

test("abandonar la página invalida una captura que todavía está iniciando el lector", async () => {
  const initialization = deferred();
  const worker = {
    terminated: 0, calls: 0,
    setParameters: async () => {},
    recognize: async () => { worker.calls += 1; return { data: { text: "QAT 5" } }; },
    terminate: async () => { worker.terminated += 1; }
  };
  const ui = fixture({
    camera: async () => ({ getTracks: () => [{ stop() {} }] }),
    tesseract: { createWorker: () => initialization.promise }
  });
  ui.open();
  ui.element("scannerStartCamera").click();
  await tick();
  ui.element("scannerCapture").click();
  await tick();
  ui.window.emit("pagehide");
  initialization.resolve(worker);
  await tick();
  assert.equal(worker.calls, 0, "pagehide debe impedir enviar trabajo al lector terminado");
  assert.equal(worker.terminated, 1);
  ui.element("scannerClose").click();
});

test("cerrar durante la preparación de la imagen no provoca un envío a un worker terminado", async () => {
  const conversion = deferred();
  const worker = {
    terminated: false, sendsAfterTermination: 0,
    setParameters: async () => {},
    recognize: async image => {
      // Tesseract browser/loadImage awaits canvas.toBlob and FileReader before
      // startJob posts its message. Already encoded bytes/data URLs avoid this
      // asynchronous interval inside the library's unguarded send(worker).
      if (typeof image !== "string" && !(image instanceof Uint8Array)) await conversion.promise;
      if (worker.terminated) worker.sendsAfterTermination += 1;
      return { data: { text: "QAT 5" } };
    },
    terminate: async () => { worker.terminated = true; }
  };
  const ui = fixture({
    camera: async () => ({ getTracks: () => [{ stop() {} }] }),
    tesseract: { createWorker: async () => worker }
  });
  ui.open();
  ui.element("scannerStartCamera").click();
  await tick();
  ui.element("scannerCapture").click();
  await tick();
  ui.element("scannerClose").click();
  await tick();
  conversion.resolve();
  await tick();
  assert.equal(worker.sendsAfterTermination, 0, "No debe existir una conversión pendiente dentro del lector que pueda enviar después de terminar");
  assert.equal(ui.requests.length, 0);
});
