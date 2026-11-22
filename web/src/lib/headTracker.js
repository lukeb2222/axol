// Watches the viewer's head through the device's front camera (the webcam on a computer, the
// selfie camera on a phone) and reports its angle about twelve times a second.
//
// Everything happens on the device: the picture goes from the camera to a face tracker running in
// the browser (MediaPipe Face Landmarker, served from axol's own files) and is then thrown away.
// No image, video or face data is stored or sent anywhere.
import { headAngles } from "./gestures.js";
import { tongueFeatures } from "./tongue.js";

const MODEL = "/mediapipe/face_landmarker.task";
const WASM = "/mediapipe/wasm";
const EVERY_MS = 80;

// The tracker takes a second or two to load, so one is kept per configuration once made.
const trackers = new Map();
function getTracker(withJaw) {
  if (!trackers.has(withJaw)) {
    trackers.set(withJaw, (async () => {
      const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");
      const files = await FilesetResolver.forVisionTasks(WASM);
      return FaceLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: MODEL, delegate: "CPU" },
        runningMode: "VIDEO", numFaces: 1, outputFacialTransformationMatrixes: true, outputFaceBlendshapes: withJaw,
      });
    })().catch((e) => { trackers.delete(withJaw); throw e; }));
  }
  return trackers.get(withJaw);
}

// Reads colours from a small copy of the lower half of the face (all the tongue measure needs).
function makePixelReader() {
  const canvas = document.createElement("canvas");
  canvas.width = 96; canvas.height = 96;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  return (video, lm) => {
    const xs = [lm[50].x, lm[280].x, lm[152].x, lm[13].x, lm[61].x, lm[291].x], ys = [lm[50].y, lm[280].y, lm[152].y, lm[13].y];
    const pad = 0.04, x0 = Math.max(0, Math.min(...xs) - pad), x1 = Math.min(1, Math.max(...xs) + pad), y0 = Math.max(0, Math.min(...ys) - pad), y1 = Math.min(1, Math.max(...ys) + pad);
    const vw = video.videoWidth, vh = video.videoHeight;
    ctx.drawImage(video, x0 * vw, y0 * vh, (x1 - x0) * vw, (y1 - y0) * vh, 0, 0, 96, 96);
    const data = ctx.getImageData(0, 0, 96, 96).data;
    return (x, y) => {
      const X = Math.max(0, Math.min(95, Math.round(((x - x0) / (x1 - x0)) * 95))), Y = Math.max(0, Math.min(95, Math.round(((y - y0) / (y1 - y0)) * 95)));
      const i = (Y * 96 + X) * 4;
      return [data[i], data[i + 1], data[i + 2]];
    };
  };
}

/**
 * Start watching. `onReading({ t, face, pitch, yaw, jaw, run })` is called for each analysed frame;
 * `onStatus` reports "starting" | "on" | "noface" | "denied" | "nocamera" | "error".
 * Returns a function that stops the camera.
 */
export function startHeadTracker({ tongue = false, margin = 0.005, onReading, onStatus }) {
  let stopped = false, stream = null, timer = 0, lastFace = 0, status = "";
  const say = (s) => { if (!stopped && s !== status) { status = s; onStatus?.(s); } };
  const video = document.createElement("video");
  video.muted = true; video.playsInline = true; video.setAttribute("playsinline", "");

  (async () => {
    say("starting");
    if (!navigator.mediaDevices?.getUserMedia) return say("nocamera");
    try {
      [stream] = await Promise.all([
        navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: "user", width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15, max: 30 } } }),
        getTracker(tongue), // loaded alongside the permission prompt
      ]);
    } catch (e) {
      stream?.getTracks().forEach((t) => t.stop());
      return say(e?.name === "NotAllowedError" || e?.name === "SecurityError" ? "denied" : e?.name === "NotFoundError" || e?.name === "OverconstrainedError" ? "nocamera" : "error");
    }
    if (stopped) return stream.getTracks().forEach((t) => t.stop());
    const tracker = await getTracker(tongue);
    video.srcObject = stream;
    try { await video.play(); } catch {}
    const readPixels = tongue ? makePixelReader() : null;
    lastFace = performance.now();
    let lastT = 0;
    timer = setInterval(() => {
      if (stopped || document.visibilityState !== "visible" || video.readyState < 2 || !video.videoWidth) return;
      const t = performance.now();
      if (t <= lastT) return;
      lastT = t;
      let res;
      try { res = tracker.detectForVideo(video, t); } catch { return; }
      const lm = res.faceLandmarks?.[0], matrix = res.facialTransformationMatrixes?.[0]?.data;
      if (!lm || !matrix) {
        if (t - lastFace > 1500) say("noface");
        return onReading?.({ t, face: false });
      }
      lastFace = t; say("on");
      const reading = { t, face: true, ...headAngles(matrix) };
      if (tongue) {
        reading.jaw = res.faceBlendshapes?.[0]?.categories.find((c) => c.categoryName === "jawOpen")?.score || 0;
        reading.run = tongueFeatures(readPixels(video, lm), lm, margin).run;
      }
      onReading?.(reading);
    }, EVERY_MS);
  })().catch(() => say("error"));

  return () => {
    stopped = true;
    clearInterval(timer);
    stream?.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  };
}
