// app.js — bootstrap entry point.
// The application is split into focused ES modules:
//   notation.js — pure music/notation + section-data logic (unit-tested, no DOM)
//   dom.js      — thin browser helpers ($, toast, prefersTap)
//   store.js    — single source of truth for state + palette selection
//   render.js   — view layer: builds score HTML and writes it to the DOM
//   events.js   — all user interaction, listeners, import/export, and bootstrap wiring
import { initEvents } from "./events.js?v=20260821-import24";

initEvents();
