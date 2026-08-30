"use strict";

// Generated, versioned browser assets. All OCR runs on the device; no CDN is
// contacted while scanning and captured images never leave the browser.
const fs = require("node:fs");
const path = require("node:path");

const packageRoot = name => path.dirname(require.resolve(`${name}/package.json`));
const engineRoot = packageRoot("tesseract.js");
const engineVersion = require(path.join(engineRoot, "package.json")).version;
const coreRoot = packageRoot("tesseract.js-core");
const languageRoot = packageRoot("@tesseract.js-data/eng");
const target = path.join(__dirname, "..", "public", "vendor", "ocr", engineVersion);
fs.mkdirSync(path.join(target, "core"), { recursive: true });
fs.mkdirSync(path.join(target, "lang"), { recursive: true });
for (const file of ["tesseract.min.js", "worker.min.js"]) {
  fs.copyFileSync(path.join(engineRoot, "dist", file), path.join(target, file));
}
for (const file of fs.readdirSync(coreRoot)) {
  if (/^tesseract-core.*\.(?:js|wasm)$/.test(file)) {
    fs.copyFileSync(path.join(coreRoot, file), path.join(target, "core", file));
  }
}
fs.copyFileSync(
  path.join(languageRoot, "4.0.0_best_int", "eng.traineddata.gz"),
  path.join(target, "lang", "eng.traineddata.gz")
);
for (const [root, name] of [[engineRoot, "tesseract"], [coreRoot, "core"], [languageRoot, "eng"]]) {
  const license = fs.readdirSync(root).find(file => /^LICENSE(?:\.|$)/i.test(file));
  if (license) fs.copyFileSync(path.join(root, license), path.join(target, `${name}-LICENSE.txt`));
}
console.log(`OCR ${engineVersion}: assets locales preparados en public/vendor/ocr/${engineVersion}`);
