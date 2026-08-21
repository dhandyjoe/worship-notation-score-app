// history.js — undo/redo stack management (generic, no DOM).
// Usage: call saveState() after every mutative action.
// Call undo()/redo() to restore previous/future states via callbacks.

const MAX_HISTORY = 50;

let past = []; // Array of snapshots
let future = []; // For redo

export function clearHistory() {
   past = [];
   future = [];
}

export function saveState(currentSnapshot) {
   if (past.length > 0) {
      const last = past.at(-1);
      if (JSON.stringify(last) === JSON.stringify(currentSnapshot)) return;
   }
   past.push(JSON.parse(JSON.stringify(currentSnapshot)));
   if (past.length > MAX_HISTORY) past.shift(); // Trim old entries
   future = []; // Clear redo buffer on new action
}

export function canUndo() {
   return past.length > 1;
}

export function canRedo() {
   return future.length > 0;
}

export function undo(callbackApply) {
   if (!canUndo()) return false;
   const current = JSON.parse(JSON.stringify(past.at(-1)));
   future.push(current);
   past.pop();
   if (callbackApply) callbackApply(past.at(-1));
   return true;
}

export function redo(callbackApply) {
   if (!canRedo()) return null; // Return null instead of false for clarity
   const next = future.pop();
   past.push(next);
   if (callbackApply) callbackApply(next); // Pass the restored state
   return next;
}

export function getPastLength() {
   return past.length - 1;
}

export function getFutureLength() {
   return future.length;
}
