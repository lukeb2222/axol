// Is the tongue sticking out? Measured from the camera picture around the mouth.
//
// The face tracker has no tongue signal of its own, so this looks at colour. A strip is sampled
// down the middle of the face from the upper lip to the middle of the chin. With the mouth shut
// or smiling, that strip is mostly teeth and chin skin, with a short band of lip. With the tongue
// out, most of it is tongue. Tongue is told from skin by comparing each sample with the person's
// own cheeks: it is distinctly redder than their skin, whatever their skin tone or the lighting.
//
// `px(x, y)` returns [r, g, b] at normalised picture coordinates; `lm` are the tracker's landmarks.

const UPPER_LIP = 13, LOWER_LIP_IN = 14, CHIN = 152, FOREHEAD = 10, MOUTH_L = 61, MOUTH_R = 291, CHEEK_L = 50, CHEEK_R = 280;
const ROWS = 14, COLS = 5;

// Two colour measures that do not depend on brightness:
//   rg: how far red stands above green (white teeth and grey shadow score near zero)
//   gb: how far green stands above blue (skin is orange, so high; tongue and lips are pink, so low)
const stats = ([r, g, b]) => { const sum = r + g + b + 1; return { rg: (r - g) / sum, gb: (g - b) / sum, l: sum / 3 }; };

function patch(px, c, radius) {
  let rg = 0, gb = 0, l = 0, n = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const p = stats(px(c.x + dx * radius, c.y + dy * radius));
    rg += p.rg; gb += p.gb; l += p.l; n++;
  }
  return { rg: rg / n, gb: gb / n, l: l / n };
}

export function tongueFeatures(px, lm, margin = 0.005) {
  const top = lm[UPPER_LIP], chin = lm[CHIN], left = lm[MOUTH_L], right = lm[MOUTH_R];
  const down = { x: chin.x - top.x, y: chin.y - top.y };
  const across = { x: right.x - left.x, y: right.y - left.y };
  const faceW = Math.hypot(lm[CHEEK_R].x - lm[CHEEK_L].x, lm[CHEEK_R].y - lm[CHEEK_L].y);
  const cheekL = patch(px, lm[CHEEK_L], faceW * 0.03), cheekR = patch(px, lm[CHEEK_R], faceW * 0.03);
  const skin = { rg: (cheekL.rg + cheekR.rg) / 2, gb: (cheekL.gb + cheekR.gb) / 2, l: (cheekL.l + cheekR.l) / 2 };

  // Rows run from the upper lip (0) to 80% of the way to the chin; columns span the middle of the mouth.
  const rows = [];
  for (let i = 0; i < ROWS; i++) {
    const v = ((i + 0.5) / ROWS) * 0.8;
    let rg = 0, gb = 0, l = 0;
    for (let j = 0; j < COLS; j++) {
      const u = ((j + 0.5) / COLS - 0.5) * 0.36;
      const p = stats(px(top.x + down.x * v + across.x * u, top.y + down.y * v + across.y * u));
      rg += p.rg; gb += p.gb; l += p.l;
    }
    rows.push({ rg: rg / COLS, gb: gb / COLS, l: l / COLS });
  }
  // How many rows in a row, anywhere in the strip, look like tongue: lit (not the dark inside of
  // the mouth) and pinker than the cheeks (not teeth, not skin).
  const base = skin.rg - skin.gb;
  let run = 0, cur = 0;
  for (const r of rows) {
    cur = r.l > 0.6 * skin.l && r.rg - r.gb >= base + margin ? cur + 1 : 0;
    if (cur > run) run = cur;
  }
  // How far apart the lips are, as a share of the face's height.
  const open = Math.hypot(lm[LOWER_LIP_IN].x - top.x, lm[LOWER_LIP_IN].y - top.y) / Math.hypot(chin.x - lm[FOREHEAD].x, chin.y - lm[FOREHEAD].y);
  return { run, open, rows: ROWS };
}
