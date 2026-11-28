// The clip on screen can register like / share / pause handlers so the reel player can drive them
// from the keyboard without reaching into the card.

let current = null;

export function setPlayerCommands(handlers) {
  current = handlers || null;
  return () => { if (current === handlers) current = null; };
}

export function playerCommands() {
  return current;
}

export const SHORTCUTS = [
  { keys: "J or ↓", action: "Next clip" },
  { keys: "K or ↑", action: "Previous clip" },
  { keys: "Space", action: "Pause or play" },
  { keys: "L", action: "Like" },
  { keys: "C", action: "Copy link" },
  { keys: "M", action: "Sound on or off" },
  { keys: "?", action: "Show these shortcuts" },
  { keys: "Esc", action: "Close this, or go back" },
];
