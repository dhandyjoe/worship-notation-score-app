// beatMenu.js — small floating context menu anchored to a point (right-click on
// desktop, long-press on touch). UI-only: the caller supplies the menu items and
// their actions, so this module stays free of app state / notation logic.
//
// Used for the rhythm subdivision menu (½, ⅓, ¼, remove) on a beat, replacing
// the old drag-a-duration-chip flow now that the arrangement ribbon is hidden.

let menu = null;
let outsideBound = false;

function ensureMenu() {
   if (menu) return;
   menu = document.createElement("div");
   menu.className = "beat-menu";
   menu.hidden = true;
   menu.setAttribute("role", "menu");
   document.body.appendChild(menu);
   menu.addEventListener("click", (event) => {
      const item = event.target.closest(".beat-menu-item");
      if (!item || item.getAttribute("aria-disabled") === "true") return;
      const index = Number(item.dataset.index);
      const action = menu._items?.[index]?.action;
      closeBeatMenu();
      action?.();
   });
   // Prevent a nested contextmenu on the menu itself.
   menu.addEventListener("contextmenu", (event) => event.preventDefault());
}

function bindOutside() {
   if (outsideBound) return;
   outsideBound = true;
   document.addEventListener("pointerdown", onOutside, true);
   window.addEventListener("scroll", closeBeatMenu, true);
   window.addEventListener("resize", closeBeatMenu, true);
   document.addEventListener("keydown", onKeydown, true);
}
function unbindOutside() {
   if (!outsideBound) return;
   outsideBound = false;
   document.removeEventListener("pointerdown", onOutside, true);
   window.removeEventListener("scroll", closeBeatMenu, true);
   window.removeEventListener("resize", closeBeatMenu, true);
   document.removeEventListener("keydown", onKeydown, true);
}
function onOutside(event) {
   if (menu && !menu.hidden && !menu.contains(event.target)) closeBeatMenu();
}
function onKeydown(event) {
   if (event.key === "Escape") closeBeatMenu();
}

export function isBeatMenuOpen() {
   return !!menu && !menu.hidden;
}

/**
 * Open the context menu at viewport coordinates.
 * @param {{x:number, y:number, items:Array<{label:string, hint?:string, disabled?:boolean, danger?:boolean, action:Function}>}} opts
 */
export function openBeatMenu({ x, y, items }) {
   ensureMenu();
   menu._items = items;
   menu.innerHTML = items
      .map(
         (item, index) =>
            `<button type="button" class="beat-menu-item${item.danger ? " is-danger" : ""}" role="menuitem" data-index="${index}"${item.disabled ? ' aria-disabled="true"' : ""}>` +
            `<span class="beat-menu-label">${item.label}</span>` +
            (item.hint ? `<span class="beat-menu-hint">${item.hint}</span>` : "") +
            `</button>`,
      )
      .join("");
   // Show then measure to clamp within the viewport.
   menu.style.visibility = "hidden";
   menu.hidden = false;
   const mw = menu.offsetWidth;
   const mh = menu.offsetHeight;
   const vw = window.innerWidth;
   const vh = window.innerHeight;
   const left = Math.max(8, Math.min(x, vw - mw - 8));
   const top = Math.max(8, Math.min(y, vh - mh - 8));
   menu.style.left = `${Math.round(left)}px`;
   menu.style.top = `${Math.round(top)}px`;
   menu.style.visibility = "";
   bindOutside();
}

export function closeBeatMenu() {
   if (!menu || menu.hidden) return;
   menu.hidden = true;
   menu._items = null;
   unbindOutside();
}
