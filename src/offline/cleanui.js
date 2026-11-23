// Preservación offline: fuera todo lo que lleva a cuentas, servidores o webs de fuera.
// Se ocultan los botones (sin tocar los archivos del juego) y ningún enlace externo se abre.

const HIDE = [
  // Cuenta: guardar con Google/Discord/email, contraseña, cerrar sesión, borrar cuenta
  '[data-act="guest-save"]',
  ".tt-save",
  '[data-act="open-account"]',
  '[data-act="oauth-link"]',
  '[data-act="guest-email"]',
  ".oauth",
  '[data-act="logout"]',
  '[data-act="logout-all"]',
  '[data-act="del-toggle"]',
  '.srow:has([data-act="del-toggle"])',
  '.slist:has([data-act="logout"])',
  '.scap:has(+ .slist [data-act="logout"])',
  '.slist:has([data-act="del-toggle"])',
  '.scap:has(+ .slist [data-act="del-toggle"])',
  // Reportar un bug (se envía a los servidores del juego) y elegir servidor
  '[data-act="open-bug"]',
  '.rowx:has([data-act="settings-server"])',
  // Wiki, Discord y cualquier enlace a webs de fuera
  "a.tc-tb",
  'a[href^="http"]',
  // Amigos y clanes en línea, y la política de privacidad de las cuentas del servidor
  '[data-act="open-friends"]',
  '[data-act="open-clan"]',
  '[data-act="open-privacy"]',
  // Pestaña Cuenta de Ajustes (correo, Google, Discord, contraseña, códigos de regalo del servidor)
  '[data-tab="account"]',
  // Los eventos ya no caducan: sin cuenta atrás
  ".tc-ev .left",
  ".ncard.ev .nleft",
  ".ncard.ev .grow > span",
];

export function installCleanUi() {
  const st = document.createElement("style");
  st.id = "pd-offline-clean";
  st.textContent = HIDE.join(",\n") + " { display: none !important; }";
  (document.head || document.documentElement).appendChild(st);
  // Pie de la portada: quitar "Privacidad" con su separador
  const tidy = () => {
    for (const b of document.querySelectorAll('.tt-legal [data-act="open-privacy"]')) {
      const prev = b.previousSibling;
      if (prev?.nodeType === 3) prev.textContent = prev.textContent.replace(/\s*·\s*$/, " ");
      b.remove();
    }
    // Si la pestaña Cuenta estaba abierta, volver a Juego
    const acc = document.querySelector('[data-keep-scroll="settings-account"]');
    if (acc) document.querySelector('[data-tab="game"]')?.click();
  };
  new MutationObserver(tidy).observe(document.documentElement, { childList: true, subtree: true });
  // Ningún enlace externo se abre (ni con window.open)
  document.addEventListener(
    "click",
    (e) => {
      const a = e.target.closest?.("a[href]");
      if (!a) return;
      const href = a.getAttribute("href") || "";
      if (/^(https?:)?\/\//i.test(href) && !href.startsWith(location.origin)) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true,
  );
  const open = window.open;
  window.open = (url, ...rest) => {
    const u = String(url ?? "");
    if (/^(https?:)?\/\//i.test(u) && !u.startsWith(location.origin)) return null;
    return open.call(window, url, ...rest);
  };
}
