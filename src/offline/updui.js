// Botón "Actualizaciones" dentro de Ajustes (solo en la app de Android, que trae el actualizador).
// Usa las mismas clases del juego (cap, rowx, btn) para que se vea igual que el resto de la ventana.

const A = () => globalThis.PdAndroid;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function info() {
  try {
    return JSON.parse(A().updInfo() || "{}");
  } catch {
    return {};
  }
}

function block() {
  const i = info();
  const ver = i.active || i.base || "";
  const el = document.createElement("div");
  el.className = "pd-upd";
  el.style.cssText = "display:contents";
  el.innerHTML =
    `<span class="k-cap">Actualizaciones</span>` +
    `<div class="k-rowx"><span class="k-grow"><b>Buscar actualizaciones</b><small>${
      i.enabled ? `Tienes la ${esc(ver)}${i.active ? " (actualizada)" : ""} · necesita internet` : "Esta compilación es de prueba: no se actualiza"
    }</small></span><button type="button" class="k-btn k-sm" data-pd-upd="check"${i.enabled ? "" : " disabled"}>Buscar</button></div>` +
    (i.active
      ? `<div class="k-rowx"><span class="k-grow"><b>Volver a la versión de la app</b><small>Quita lo descargado y usa la ${esc(i.base)} que trae el APK</small></span><button type="button" class="k-btn k-sm" data-pd-upd="reset">Volver</button></div>`
      : "");
  el.addEventListener(
    "click",
    (e) => {
      const b = e.target.closest("[data-pd-upd]");
      if (!b) return;
      e.preventDefault();
      e.stopPropagation();
      if (b.dataset.pdUpd === "check") {
        b.textContent = "Buscando…";
        A().updCheck();
        setTimeout(() => (b.textContent = "Buscar"), 4000);
      } else if (b.dataset.pdUpd === "reset") A().updReset();
    },
    true,
  );
  return el;
}

export function installUpdateUi() {
  const put = () => {
    if (!A()?.updInfo) return;
    const pane = document.querySelector('[data-keep-scroll="settings-game"]');
    if (pane && !pane.querySelector(".pd-upd")) pane.prepend(block());
  };
  new MutationObserver(put).observe(document.documentElement, { childList: true, subtree: true });
}
