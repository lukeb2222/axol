// Copy and a shareable "Made me laugh" card. Pure layout: no camera, no network.

export function laughHeadline({ today = 0, name = "" } = {}) {
  const you = name ? `${name}, you` : "You";
  if (today <= 0) return `${you} haven't laughed at a clip yet`;
  if (today === 1) return `${you} laughed once today`;
  return `${you} laughed ${today} times today`;
}

export function laughSubline({ total = 0, streak = 0 } = {}) {
  const bits = [];
  if (total > 0) bits.push(`${total} all time`);
  if (streak > 1) bits.push(`${streak}-day laugh streak`);
  else if (streak === 1 && total > 0) bits.push("in it today");
  return bits.join(" · ");
}

/**
 * Paint a typographic recap card onto `canvas`. Size is 1080×1350, a story-shaped share image.
 */
export function drawLaughCard(canvas, { today = 0, total = 0, streak = 0, name = "" } = {}) {
  const W = 1080, H = 1350;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#09090b";
  ctx.fillRect(0, 0, W, H);

  const glow = (x, y, r, color) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  };
  glow(200, 220, 520, "rgba(200,255,61,0.22)");
  glow(900, 980, 580, "rgba(139,92,246,0.28)");
  glow(540, 640, 420, "rgba(255,59,107,0.10)");

  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 2;
  ctx.strokeRect(48, 48, W - 96, H - 96);

  ctx.fillStyle = "#c8ff3d";
  ctx.beginPath();
  ctx.arc(96, 108, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fafafa";
  ctx.font = "800 40px ui-sans-serif, system-ui, sans-serif";
  ctx.fillText("axol", 122, 122);

  ctx.fillStyle = "#a1a1aa";
  ctx.font = "600 28px ui-sans-serif, system-ui, sans-serif";
  ctx.fillText("MADE ME LAUGH", 96, 280);

  ctx.fillStyle = "#fafafa";
  ctx.font = "800 64px ui-sans-serif, system-ui, sans-serif";
  ctx.fillText(today === 1 ? "You laughed" : today <= 0 ? "Quiet so far" : "You laughed", 96, 430);

  ctx.fillStyle = "#c8ff3d";
  ctx.font = "900 320px ui-sans-serif, system-ui, sans-serif";
  ctx.fillText(String(Math.max(0, today)), 80, 760);

  ctx.fillStyle = "#fafafa";
  ctx.font = "800 64px ui-sans-serif, system-ui, sans-serif";
  ctx.fillText(today === 1 ? "time today" : "times today", 96, 860);

  const sub = laughSubline({ total, streak });
  if (sub) {
    ctx.fillStyle = "#a1a1aa";
    ctx.font = "600 32px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(sub, 96, 940);
  }

  ctx.fillStyle = "#6b6b76";
  ctx.font = "500 24px ui-sans-serif, system-ui, sans-serif";
  ctx.fillText("Caught on this device. The face never left it.", 96, 1220);
  if (name) ctx.fillText(name, 96, 1260);
  return canvas;
}

export async function shareLaughCard(stats, { share, canShare } = {}) {
  const nav = globalThis.navigator;
  share = share || nav?.share?.bind(nav);
  canShare = canShare || nav?.canShare?.bind(nav);
  const canvas = globalThis.document?.createElement?.("canvas");
  if (!canvas) throw new Error("no canvas");
  drawLaughCard(canvas, stats);
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("could not make the card image"))), "image/png");
  });
  const file = new File([blob], "axol-made-me-laugh.png", { type: "image/png" });
  const text = laughHeadline(stats);
  try {
    if (typeof canShare === "function" && canShare({ files: [file] }) && typeof share === "function") {
      await share({ files: [file], title: "Made me laugh", text });
      return "shared";
    }
  } catch (e) {
    if (e?.name === "AbortError") return "cancelled";
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: "axol-made-me-laugh.png" });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return "downloaded";
}
