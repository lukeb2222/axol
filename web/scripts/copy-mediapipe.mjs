// Copies the face tracker's WebAssembly runtime from node_modules into public/, so axol serves it
// itself and the camera feature never depends on (or reports to) a third-party server.
// The model file (public/mediapipe/face_landmarker.task, Apache-2.0, from Google's MediaPipe) is
// committed to the repository.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const from = path.join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const to = path.join(root, "public", "mediapipe", "wasm");
fs.mkdirSync(to, { recursive: true });
for (const f of fs.readdirSync(from)) fs.copyFileSync(path.join(from, f), path.join(to, f));
console.log(`copied ${fs.readdirSync(to).length} tracker files to public/mediapipe/wasm`);
