import { test } from "node:test";
import assert from "node:assert/strict";
import { laughHeadline, laughSubline } from "../src/lib/laughRecap.js";
import { setPlayerCommands, playerCommands } from "../src/lib/playerCommands.js";

test("laugh headlines and sublines cover none, one, many, and a streak", () => {
  assert.equal(laughHeadline({ today: 0 }), "You haven't laughed at a clip yet");
  assert.equal(laughHeadline({ today: 1 }), "You laughed once today");
  assert.equal(laughHeadline({ today: 14 }), "You laughed 14 times today");
  assert.equal(laughHeadline({ today: 14, name: "Luke" }), "Luke, you laughed 14 times today");
  assert.equal(laughSubline({ total: 32, streak: 3 }), "32 all time · 3-day laugh streak");
  assert.equal(laughSubline({ total: 0, streak: 0 }), "");
  assert.match(laughSubline({ total: 4, streak: 1 }), /4 all time/);
});

test("playerCommands exposes and then clears the active card's like and pause", () => {
  const like = () => "liked";
  const togglePause = () => true;
  setPlayerCommands({ like, togglePause });
  assert.equal(playerCommands().like(), "liked");
  assert.equal(playerCommands().togglePause(), true);
  setPlayerCommands({});
  assert.equal(playerCommands().like, undefined);
});
