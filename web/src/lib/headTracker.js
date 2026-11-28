// Watches the viewer's head through the device's front camera (the webcam on a computer, the
// selfie camera on a phone) and reports its angle about twelve times a second.
//
// Everything happens on the device: the picture goes from the camera to a face tracker running in
// the browser (MediaPipe Face Landmarker, served from axol's own files) and is then thrown away.
// No image, video or face data is stored or sent anywhere.
//
// Each camera frame is first copied onto an ordinary canvas and the tracker reads that copy.
// Browsers differ in how reliably a live camera <video> can be handed to the tracker directly
// (some give it black frames, especially when the video is not on the page); a canvas copy works
// everywhere, and it lets a sideways camera picture be turned upright first.
import { headAngles, blendScores } from "./gestures.js";
import { tongueFeatures } from "./tongue.js";

const MODEL = "/mediapipe/face_landmarker.task";
const WASM = "/mediapipe/wasm";
const EVERY_MS = 80;
const MAX_SIDE = 480;                 // frames are scaled down to this before analysis
const ROTATIONS = [0, 90, 270, 180];  // tried in turn until a face is found

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
        // People watch reels in dim rooms lit by the screen: accept less certain faces than the default 0.5.
        minFaceDetectionConfidence: 0.3, minFacePresenceConfidence: 0.3, minTrackingConfidence: 0.3,
      });
    })().catch((e) => { trackers.delete(withJaw); throw e; }));
  }
  return trackers.get(withJaw);
}

async function openCamera(deviceId) {
  const base = { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15, max: 30 } };
  if (deviceId) {
    try { return await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...base, deviceId: { exact: deviceId } } }); }
    catch (e) { if (e?.name === "NotAllowedError" || e?.name === "SecurityError") throw e; /* that camera is gone: fall back */ }
  }
  try { return await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...base, facingMode: "user" } }); }
  catch (e) { if (e?.name !== "OverconstrainedError") throw e; }
  return navigator.mediaDevices.getUserMedia({ audio: false, video: true });
}

/** The cameras this device has, once permission has been given: [{ id, label }]. */
export async function listCameras() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === "videoinput" && d.deviceId).map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }));
  } catch { return []; }
}

/**
 * Start watching.
 *   onReading({ t, face, pitch, yaw, jaw, run })  for each analysed frame
 *   onStatus(s)   "starting" | "on" | "noface" | "dark" | "stalled" | "denied" | "nocamera" | "error"
 *   onFrame(canvas)  the upright frame just analysed, for a preview
 * Returns a function that stops the camera.
 */
export function startHeadTracker({ tongue = false, faces = false, margin = 0.005, deviceId = "", onReading, onStatus, onFrame }) {
  let stopped = false, stream = null, timer = 0, status = "";
  const say = (s) => { if (!stopped && s !== status) { status = s; onStatus?.(s); } };

  // The video has to be on the page (some browsers stop updating one that is not), but nobody needs to see it.
  const video = document.createElement("video");
  video.muted = true; video.playsInline = true; video.autoplay = true;
  video.setAttribute("playsinline", ""); video.setAttribute("muted", ""); video.setAttribute("aria-hidden", "true");
  Object.assign(video.style, { position: "fixed", left: "0", top: "0", width: "2px", height: "2px", opacity: "0.01", pointerEvents: "none", zIndex: "-1" });
  document.body.appendChild(video);

  const frame = document.createElement("canvas");
  const ctx = frame.getContext("2d", { willReadFrequently: true });
  const thumb = document.createElement("canvas");
  thumb.width = thumb.height = 16;
  const tctx = thumb.getContext("2d", { willReadFrequently: true });

  // Copy the current camera frame onto the canvas, turned by `deg` so that it is upright.
  function draw(deg) {
    const vw = video.videoWidth, vh = video.videoHeight, k = Math.min(1, MAX_SIDE / Math.max(vw, vh));
    const w = Math.round(vw * k), h = Math.round(vh * k), side = deg === 90 || deg === 270;
    const cw = side ? h : w, ch = side ? w : h;
    if (frame.width !== cw || frame.height !== ch) { frame.width = cw; frame.height = ch; }
    ctx.save();
    ctx.translate(cw / 2, ch / 2);
    ctx.rotate((deg * Math.PI) / 180);
    ctx.drawImage(video, -w / 2, -h / 2, w, h);
    ctx.restore();
  }
  function brightness() {
    tctx.drawImage(frame, 0, 0, 16, 16);
    const d = tctx.getImageData(0, 0, 16, 16).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
    return sum / (d.length / 4) / 3;
  }
  // Colours around the mouth, read from the frame canvas.
  function pixelReader(lm) {
    const xs = [lm[50].x, lm[280].x, lm[152].x, lm[13].x, lm[61].x, lm[291].x], ys = [lm[50].y, lm[280].y, lm[152].y, lm[13].y];
    const W = frame.width, H = frame.height, pad = 0.04;
    const x0 = Math.max(0, Math.floor((Math.min(...xs) - pad) * W)), y0 = Math.max(0, Math.floor((Math.min(...ys) - pad) * H));
    const x1 = Math.min(W, Math.ceil((Math.max(...xs) + pad) * W)), y1 = Math.min(H, Math.ceil((Math.max(...ys) + pad) * H));
    const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0), data = ctx.getImageData(x0, y0, w, h).data;
    return (x, y) => {
      const X = Math.max(0, Math.min(w - 1, Math.round(x * W) - x0)), Y = Math.max(0, Math.min(h - 1, Math.round(y * H) - y0)), i = (Y * w + X) * 4;
      return [data[i], data[i + 1], data[i + 2]];
    };
  }

  (async () => {
    say("starting");
    if (!navigator.mediaDevices?.getUserMedia) return say("nocamera");
    let tracker;
    try {
      [stream, tracker] = await Promise.all([openCamera(deviceId), getTracker(tongue || faces)]); // the tracker loads alongside the permission prompt
    } catch (e) {
      stream?.getTracks().forEach((t) => t.stop());
      return say(e?.name === "NotAllowedError" || e?.name === "SecurityError" ? "denied" : e?.name === "NotFoundError" || e?.name === "OverconstrainedError" ? "nocamera" : "error");
    }
    if (stopped) return stream.getTracks().forEach((t) => t.stop());
    video.srcObject = stream;
    try { await video.play(); } catch {}

    let lastT = 0, lastFace = performance.now(), found = false, rot = 0, rotSince = performance.now(), tick = 0, dark = false;
    let lastTime = -1, movedAt = performance.now();
    let sidewaysSince = 0;
    timer = setInterval(() => {
      if (stopped || document.visibilityState !== "visible") return;
      const t = performance.now();
      if (video.paused) video.play().catch(() => {});
      if (video.currentTime !== lastTime) { lastTime = video.currentTime; movedAt = t; }
      if (video.readyState < 2 || !video.videoWidth || t - movedAt > 2500) { if (t - movedAt > 2500) say("stalled"); return; }
      if (t <= lastT) return;
      lastT = t;
      let res;
      try {
        draw(ROTATIONS[rot]);
        if (tick++ % 12 === 0) dark = brightness() < 12;
        onFrame?.(frame);
        res = tracker.detectForVideo(frame, t);
      } catch { return; }
      const lm = res.faceLandmarks?.[0], matrix = res.facialTransformationMatrixes?.[0]?.data;
      if (!lm || !matrix) {
        if (t - lastFace > 1500) say(dark ? "dark" : "noface");
        // Until a face has been seen once, the picture may simply be sideways: try the next turn.
        if (!found && !dark && t - rotSince > 1200) { rot = (rot + 1) % ROTATIONS.length; rotSince = t; }
        return onReading?.({ t, face: false });
      }
      found = true; lastFace = t; say("on");
      // A face lying on its side means the picture itself is sideways. The tracker reads an
      // upright face far better, so turn the copy until the face stands up.
      const roll = Math.abs(Math.atan2(matrix[4], matrix[5]) * 57.3);
      if (roll < 55) sidewaysSince = 0;
      else if (!sidewaysSince) sidewaysSince = t;
      else if (t - sidewaysSince > 700) { rot = (rot + 1) % ROTATIONS.length; sidewaysSince = 0; return onReading?.({ t, face: false }); }
      const reading = { t, face: true, ...headAngles(matrix) };
      if (tongue || faces) Object.assign(reading, blendScores(res.faceBlendshapes?.[0]?.categories));
      if (tongue) reading.run = tongueFeatures(pixelReader(lm), lm, margin).run;
      onReading?.(reading);
    }, EVERY_MS);
  })().catch(() => say("error"));

  return () => {
    stopped = true;
    clearInterval(timer);
    stream?.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
    video.remove();
  };
}
