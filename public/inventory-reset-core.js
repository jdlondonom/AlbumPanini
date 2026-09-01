(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PaniniInventoryReset = api;
})(typeof window !== "undefined" ? window : this, function () {
  "use strict";

  const FIELDS = ["owned", "collection", "duplicates", "adrenalyn", "adrenalynDuplicates"];
  const SCOPES = {
    album: ["owned", "collection", "duplicates"],
    adrenalyn: ["adrenalyn", "adrenalynDuplicates"]
  };

  function assertProgress(progress) {
    if (!progress || typeof progress !== "object" || Array.isArray(progress)) throw new TypeError("Inventario inválido");
    for (const field of FIELDS) {
      const value = progress[field];
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`Inventario ${field} inválido`);
    }
  }

  function scopeFields(scope) {
    const fields = SCOPES[scope];
    if (!fields) throw new TypeError("Tipo de inventario inválido");
    return fields;
  }

  function reset(progress, scope) {
    assertProgress(progress);
    const fieldsToClear = new Set(scopeFields(scope));
    return {
      version: 5,
      ...Object.fromEntries(FIELDS.map(field => [field, fieldsToClear.has(field) ? {} : { ...progress[field] }]))
    };
  }

  function count(progress, scope) {
    assertProgress(progress);
    return scopeFields(scope).reduce((total, field) => {
      const values = Object.values(progress[field]);
      return total + (field.toLowerCase().includes("duplicates")
        ? values.reduce((sum, value) => sum + Number(value || 0), 0)
        : values.length);
    }, 0);
  }

  return { reset, count };
});
