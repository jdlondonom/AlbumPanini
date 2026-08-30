(() => {
  "use strict";
  const inventory = window.stickerInventory;
  const core = window.PaniniScannerCore;
  const index = core.createIndex(inventory.catalog);
  const element = id => document.getElementById(id);
  const dialog = element("stickerScanner");
  const video = element("scannerVideo");
  const codeInput = element("scannerCode");
  const confirmButton = element("scannerConfirm");
  const previewImage = element("scannerPreview");
  const pendingKey = `mi-album-mundial-2026:scan-pending:user:${inventory.userId}`;
  const ocrRoot = "/assets/vendor/ocr/7.0.0";
  let stream = null;
  let workerPromise = null;
  let scriptPromise = null;
  let phase = "capture";
  let epoch = 0;
  let previewRevision = null;
  let pending = null;
  let pendingUnreadable = false;
  let cameraStarting = false;

  function message(text, error = false) {
    element("scannerMessage").textContent = text;
    element("scannerMessage").dataset.error = String(error);
  }

  function setPhase(next) {
    phase = next;
    element("scannerCapturePanel").hidden = !["capture", "reading"].includes(next);
    element("scannerReviewPanel").hidden = !["review", "saving"].includes(next);
    element("scannerSavedPanel").hidden = next !== "saved";
    element("scannerRecoveryPanel").hidden = !["recover", "recovering"].includes(next);
    const busy = ["reading", "saving", "recovering"].includes(next);
    for (const id of ["scannerCapture", "scannerStartCamera", "scannerChoosePhoto", "scannerManual", "scannerRetake", "scannerRefresh", "scannerRecover"]) element(id).disabled = busy;
    element("scannerClose").disabled = ["saving", "recovering"].includes(next);
    codeInput.disabled = next === "saving";
    confirmButton.disabled = next !== "review";
  }

  function stopCamera() {
    if (stream) for (const track of stream.getTracks()) track.stop();
    stream = null;
    video.srcObject = null;
    video.hidden = true;
    element("scannerGuide").hidden = true;
    element("scannerCameraPlaceholder").hidden = false;
    element("scannerCapture").hidden = true;
    element("scannerStartCamera").hidden = false;
  }

  function releaseOcr() {
    const previous = workerPromise;
    workerPromise = null;
    if (previous) previous.then(worker => worker.terminate()).catch(() => {});
  }

  function loadPending() {
    pendingUnreadable = false;
    try {
      // One key per confirmation keeps parallel tabs from overwriting each
      // other's recovery identifiers. The server serializes their mutations.
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key === pendingKey || key?.startsWith(`${pendingKey}:`)) keys.push(key);
      }
      for (const key of keys.sort()) {
        const value = JSON.parse(localStorage.getItem(key));
        if (!value) continue;
        if (!/^[0-9a-f-]{36}$/i.test(value.scanId) || !index.has(core.normalizeCode(value.code)) || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) throw new Error("Invalid pending scan");
        return value;
      }
      return null;
    } catch {
      pendingUnreadable = true;
      return null;
    }
  }

  function clearPending() {
    if (pending) {
      for (const key of [`${pendingKey}:${pending.scanId}`, pendingKey]) {
        const value = JSON.parse(localStorage.getItem(key));
        if (value?.scanId === pending.scanId) localStorage.removeItem(key);
      }
    }
    pending = null;
  }

  function showRecovery() {
    stopCamera();
    setPhase("recover");
    element("scannerRecoveryDetail").textContent = pending
      ? `${pending.code}: comprobaremos esta misma confirmación sin agregar otra unidad si ya se guardó.`
      : "No se pudo leer la confirmación pendiente. No borres los datos del navegador: conserva esta página y revisa tu inventario antes de continuar.";
    element("scannerRecover").disabled = !pending || pendingUnreadable;
  }

  function resetCapture() {
    pending = loadPending();
    if (pending || pendingUnreadable) { showRecovery(); return; }
    epoch += 1;
    previewRevision = null;
    codeInput.value = "";
    previewImage.removeAttribute("src");
    previewImage.hidden = true;
    element("scannerPhoto").value = "";
    setPhase("capture");
    message("Coloca solo el código dentro del recuadro y pulsa Leer código.");
  }

  async function startCamera() {
    if (cameraStarting || !dialog.open || phase !== "capture") return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      message("La cámara necesita HTTPS y permiso del navegador. Puedes usar una foto o escribir el código.", true);
      return;
    }
    cameraStarting = true;
    const token = epoch;
    element("scannerStartCamera").disabled = true;
    message("Permite el acceso a la cámara para continuar. No se solicita micrófono.");
    try {
      const camera = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
      if (!dialog.open || token !== epoch) {
        for (const track of camera.getTracks()) track.stop();
        return;
      }
      stopCamera();
      stream = camera;
      video.srcObject = camera;
      video.hidden = false;
      element("scannerGuide").hidden = false;
      element("scannerCameraPlaceholder").hidden = true;
      element("scannerCapture").hidden = false;
      element("scannerStartCamera").hidden = true;
      await video.play();
      message("Acerca el código al recuadro. Evita reflejos y espera a que esté enfocado.");
    } catch (error) {
      if (token !== epoch || !dialog.open) return;
      stopCamera();
      message(error.name === "NotAllowedError" ? "No se permitió usar la cámara. Habilita el permiso en el navegador o usa una foto." : "No se pudo abrir la cámara. Cierra otras apps que la usen, o utiliza una foto.", true);
    } finally {
      cameraStarting = false;
      element("scannerStartCamera").disabled = false;
    }
  }

  function canvasFrom(source, rectangle) {
    const width = source.videoWidth || source.naturalWidth || source.width;
    const height = source.videoHeight || source.naturalHeight || source.height;
    const area = rectangle || { x: 0, y: 0, width, height };
    if (!area.width || !area.height) throw new Error("Espera a que la cámara enfoque antes de capturar.");
    const scale = Math.min(3, 1400 / area.width);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(area.width * scale));
    canvas.height = Math.max(1, Math.round(area.height * scale));
    canvas.getContext("2d").drawImage(source, area.x, area.y, area.width, area.height, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  function prepareCanvas(source, invert) {
    const canvas = canvasFrom(source);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let offset = 0; offset < pixels.data.length; offset += 4) {
      const grey = pixels.data[offset] * .299 + pixels.data[offset + 1] * .587 + pixels.data[offset + 2] * .114;
      const value = invert ? 255 - grey : grey;
      pixels.data[offset] = pixels.data[offset + 1] = pixels.data[offset + 2] = value;
    }
    context.putImageData(pixels, 0, 0);
    return canvas;
  }

  function loadOcrScript() {
    if (window.Tesseract) return Promise.resolve();
    if (scriptPromise) return scriptPromise;
    scriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `${ocrRoot}/tesseract.min.js`;
      script.onload = resolve;
      script.onerror = () => { script.remove(); scriptPromise = null; reject(new Error("No se pudo descargar el lector. Revisa la conexión o escribe el código.")); };
      document.head.append(script);
    });
    return scriptPromise;
  }

  async function getWorker() {
    if (!workerPromise) {
      const candidate = (async () => {
        await loadOcrScript();
        const worker = await window.Tesseract.createWorker("eng", 1, {
          workerPath: `${ocrRoot}/worker.min.js`,
          corePath: `${ocrRoot}/core`,
          langPath: `${ocrRoot}/lang`,
          workerBlobURL: false,
          logger: event => {
            if (workerPromise === candidate && dialog.open && phase === "reading") message(event.status === "recognizing text" ? `Leyendo código… ${Math.round((event.progress || 0) * 100)} %` : "Preparando lector en tu dispositivo… La primera carga puede tardar unos segundos.");
          }
        });
        await worker.setParameters({ tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ", tessedit_pageseg_mode: "11" });
        return worker;
      })();
      workerPromise = candidate;
      candidate.catch(() => { if (workerPromise === candidate) workerPromise = null; });
    }
    return workerPromise;
  }

  function renderPreview() {
    const item = index.get(core.normalizeCode(codeInput.value));
    const match = element("scannerMatch");
    const outcome = element("scannerOutcome");
    outcome.className = "scan-outcome";
    confirmButton.disabled = true;
    if (!item) {
      match.textContent = codeInput.value.trim() ? "Código no encontrado en el catálogo." : "Escribe el equipo y número de la lámina.";
      outcome.textContent = "Ejemplos: QAT 5, COL 12, FWC 1, CC 3 o 00. No se crean códigos desconocidos.";
      return;
    }
    match.textContent = `${item.seleccion} · ${item.jugador}`;
    const preview = core.previewUnit(inventory.state, item);
    if (!preview.allowed) {
      outcome.classList.add("scan-outcome--error");
      outcome.textContent = "Ya tienes 99 repetidas de esta lámina. Se alcanzó el límite; no se agregará otra.";
    } else if (inventory.state.locked) {
      outcome.textContent = "La edición está bloqueada. Cierra el escáner y desbloquéala para registrar láminas.";
    } else if (preview.action === "album") {
      outcome.textContent = `${item.code}: primera copia. Se agregará al álbum.`;
    } else {
      outcome.classList.add("scan-outcome--repeat");
      outcome.textContent = `${item.code}: ya tienes esta lámina. Repetidas: ${preview.duplicates} → ${preview.nextDuplicates}.`;
    }
    confirmButton.disabled = phase !== "review" || !preview.allowed || inventory.state.locked || previewRevision === null || inventory.sync.conflicted || pendingUnreadable;
  }

  async function refreshPreview() {
    const token = epoch;
    previewRevision = null;
    renderPreview();
    element("scannerRefresh").hidden = true;
    try {
      await inventory.sync.refresh();
      if (token !== epoch || !dialog.open || phase !== "review") return;
      previewRevision = inventory.sync.revision;
      renderPreview();
    } catch (error) {
      if (token !== epoch || !dialog.open) return;
      message(error.code === "conflict" ? "Resuelve los cambios pendientes entre dispositivos antes de escanear. Cierra este cuadro para ver las opciones." : "Necesitas conexión y el inventario sincronizado antes de confirmar. Puedes corregir el código y volver a revisar la conexión.", true);
      element("scannerRefresh").hidden = false;
      renderPreview();
    }
  }

  async function showReview(code, image = null, note = "Revisa equipo y número. Puedes corregirlos antes de confirmar.") {
    setPhase("review");
    codeInput.value = code;
    if (image) {
      previewImage.src = image.toDataURL("image/jpeg", .85);
      previewImage.hidden = false;
    }
    message(note);
    renderPreview();
    await refreshPreview();
    if (dialog.open && phase === "review") codeInput.focus({ preventScroll: true });
  }

  async function recognize(canvas, fromPhoto = false) {
    if (phase !== "capture") return;
    const token = epoch;
    setPhase("reading");
    message("Preparando lectura…");
    let deadline;
    let cancelled = false;
    try {
      const job = (async () => {
        const worker = await getWorker();
        if (cancelled || token !== epoch || !dialog.open) return [];
        // A full-back photo is first cropped to its upper strip, where the
        // printed team code lives. A camera capture already contains the guide.
        const crop = fromPhoto && canvas.height > canvas.width * .7
          ? canvasFrom(canvas, { x: 0, y: 0, width: canvas.width, height: canvas.height * .30 })
          : canvas;
        // Tesseract converts a canvas asynchronously before sending its job.
        // A synchronous data URL avoids sending to an already-closed worker
        // when the user cancels during that conversion.
        const first = await worker.recognize(prepareCanvas(crop, true).toDataURL("image/png"));
        if (cancelled || token !== epoch || !dialog.open) return [];
        let found = core.candidatesFromText(first.data.text, index);
        if (!found.length) {
          const second = await worker.recognize(prepareCanvas(fromPhoto ? canvas : crop, false).toDataURL("image/png"));
          found = core.candidatesFromText(second.data.text, index);
        }
        return found;
      })();
      const candidates = await Promise.race([job, new Promise((_, reject) => {
        deadline = setTimeout(() => {
          cancelled = true;
          // Closing a read can leave Tesseract's old job pending. Its deadline
          // must never terminate a worker belonging to a later capture.
          if (token === epoch) releaseOcr();
          reject(new Error("La lectura tardó demasiado. Acerca el código o escríbelo manualmente."));
        }, 45000);
      })]);
      if (token !== epoch || !dialog.open) return;
      const only = candidates.length === 1 ? candidates[0] : null;
      const note = only
        ? only.corrected ? "La lectura contenía caracteres dudosos. Verifica cuidadosamente equipo y número." : "Código detectado. Confírmalo mirando la lámina antes de agregarla."
        : candidates.length ? `Detecté varios códigos (${candidates.map(item => item.code).join(", ")}). Escribe el de esta lámina.` : "No pude reconocer un código válido. Puedes escribirlo o repetir la lectura con mejor enfoque.";
      await showReview(only?.code || "", canvas, note);
    } catch (error) {
      if (token !== epoch || !dialog.open) return;
      await showReview("", canvas, error.message || "No se pudo leer la imagen. Escribe el código manualmente.");
    } finally {
      clearTimeout(deadline);
    }
  }

  async function submitPending(recovering = false) {
    if (!pending) return;
    if (inventory.state.locked) { message("La edición está bloqueada. Desbloquéala antes de continuar.", true); return; }
    setPhase(recovering ? "recovering" : "saving");
    message(recovering ? "Comprobando la confirmación anterior…" : "Guardando una unidad en tu cuenta…");
    try {
      const result = await inventory.sync.scan(pending);
      clearPending();
      const item = index.get(result.scan.code);
      element("scannerSavedTitle").textContent = result.scan.action === "album" ? "Agregada al álbum" : "Repetida registrada";
      element("scannerSavedDetail").textContent = `${result.scan.code} · ${item?.seleccion || ""} · ${item?.jugador || ""}. ${result.replayed ? "Esta confirmación ya estaba guardada; no se sumó otra unidad." : "Una unidad guardada correctamente."}`;
      setPhase("saved");
      message("Para registrar otra copia, inicia una nueva lectura y confírmala.");
      element("scannerNext").focus({ preventScroll: true });
    } catch (error) {
      // Only a scan rejection AFTER the server's idempotency lookup proves it
      // did not commit. Auth failures or a conflict while flushing local edits
      // cannot tell us whether an older attempt succeeded; retain its ID.
      const rejectedScan = error.requestPath === "/api/scans"
        && ["PROGRESS_CONFLICT", "DUPLICATE_LIMIT"].includes(error.data?.errorCode);
      if (rejectedScan) {
        const code = pending.code;
        clearPending();
        await showReview(code, null, error.code === "conflict" ? "El inventario cambió en otro dispositivo. Revisa la acción actualizada y confirma de nuevo." : (error.message || "No se pudo registrar esta lámina."));
      } else {
        showRecovery();
        message(error.code === "conflict"
          ? "Resuelve primero el conflicto de sincronización fuera del escáner. Esta confirmación queda protegida para comprobarla después."
          : error.code === "auth" ? "Inicia sesión de nuevo y comprueba este registro pendiente. Conservamos su confirmación para no duplicarlo."
          : "No recibimos confirmación del servidor. Usa Comprobar registro pendiente; no vuelvas a capturar esta copia todavía.", true);
      }
    }
  }

  element("openStickerScanner").addEventListener("click", () => {
    if (inventory.state.locked) { inventory.showToast("Desbloquea la edición para escanear láminas"); return; }
    pending = loadPending();
    dialog.showModal();
    if (pending || pendingUnreadable) { showRecovery(); message("Resolveremos esta confirmación antes de permitir otra captura."); }
    else resetCapture();
  });
  element("scannerClose").addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", event => { if (["saving", "recovering"].includes(phase)) event.preventDefault(); });
  dialog.addEventListener("close", () => { epoch += 1; stopCamera(); releaseOcr(); previewImage.removeAttribute("src"); element("scannerPhoto").value = ""; });
  element("scannerStartCamera").addEventListener("click", startCamera);
  element("scannerCapture").addEventListener("click", () => {
    if (phase !== "capture") return;
    try {
      const bounds = video.getBoundingClientRect();
      const area = core.guideRectangle(video.videoWidth, video.videoHeight, bounds.width, bounds.height);
      recognize(canvasFrom(video, area));
    } catch (error) { message(error.message, true); }
  });
  element("scannerChoosePhoto").addEventListener("click", () => element("scannerPhoto").click());
  element("scannerPhoto").addEventListener("change", async event => {
    const file = event.target.files[0];
    if (!file || phase !== "capture") return;
    if (!file.type.startsWith("image/") || file.size > 15 * 1024 * 1024) { message("Elige una imagen de hasta 15 MB.", true); return; }
    const token = epoch;
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
      if (token !== epoch || !dialog.open || phase !== "capture") return;
      await recognize(canvasFrom(bitmap), true);
    } catch { if (token === epoch && dialog.open) message("No se pudo abrir la foto. Usa una imagen JPG/PNG o escribe el código.", true); }
    finally { bitmap?.close(); event.target.value = ""; }
  });
  element("scannerManual").addEventListener("click", () => { epoch += 1; showReview(""); });
  codeInput.addEventListener("input", renderPreview);
  element("scannerRefresh").addEventListener("click", refreshPreview);
  element("scannerRetake").addEventListener("click", resetCapture);
  element("scannerNext").addEventListener("click", resetCapture);
  element("scannerRecover").addEventListener("click", () => submitPending(true));
  element("scannerConfirmForm").addEventListener("submit", event => {
    event.preventDefault();
    if (phase !== "review" || confirmButton.disabled) return;
    const item = index.get(core.normalizeCode(codeInput.value));
    if (!item || !core.previewUnit(inventory.state, item).allowed || inventory.state.locked || previewRevision === null) return;
    // Saving this identifier is a prerequisite: it survives reloads and a lost
    // HTTP response, so retrying cannot create an accidental duplicate.
    try {
      pending = loadPending();
      if (pending || pendingUnreadable) { showRecovery(); message("Hay otra confirmación pendiente. La comprobaremos antes de agregar una nueva."); return; }
      pending = { scanId: crypto.randomUUID(), code: item.code, expectedRevision: previewRevision };
      localStorage.setItem(`${pendingKey}:${pending.scanId}`, JSON.stringify(pending));
    } catch {
      pending = null;
      message("No se puede guardar la confirmación de forma segura en este navegador. Habilita el almacenamiento antes de escanear.", true);
      return;
    }
    submitPending();
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden) stopCamera(); });
  window.addEventListener("pagehide", () => { epoch += 1; stopCamera(); releaseOcr(); });
  window.addEventListener("panini:progress", () => { if (phase === "review") renderPreview(); });
  window.addEventListener("panini:lock", () => { if (phase === "review") renderPreview(); });
})();
