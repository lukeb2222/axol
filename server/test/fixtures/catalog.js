// A small, fixed catalog for regression tests. Test data only: nothing here ships in the product.
// It mirrors the shapes that caused real mis-rankings: a two-word query whose words appear
// separately in unrelated clips, a substring trap ("ski" inside "skills"), and a format tag
// ("pov") shared by clips about different things.
const T = (pairs) => JSON.stringify(pairs.map(([tag, relevance]) => ({ tag, relevance })));
const DAY = 86400e3;
const BASE = Date.UTC(2026, 10, 1);

const clip = (id, source, title, tags, query, extra = {}) => ({
  id, source, external_id: `ext-${id}`, embed_kind: source, url: `https://example.test/${id}`,
  title, creator: extra.creator || `@${id}`, description: extra.description || "", thumbnail: "",
  duration_ms: 20000, tags_json: T(tags), query, tagged: 1, created_at: BASE - (extra.ageDays || 1) * DAY,
  // Non-YouTube clips are only served when axol holds the file.
  media_file: source === "youtube" ? "" : `${id}.mp4`,
});

export const CATALOG = [
  // Skiing
  clip("ski-freestyle", "tiktok", "@Alpine high club sending the park 🔥 #freestyleskiing", [["freestyle-skiing", 1], ["extreme-sports", 0.8], ["winter-sports", 0.7], ["highlight", 0.5]], "extremesports"),
  clip("ski-racing", "youtube", "Giant slalom run from the start gate", [["ski-racing", 1], ["skiing", 0.9], ["winter-sports", 0.7]], "skiing shorts"),
  // BMX freestyle
  clip("bmx-1", "instagram", "Process how to unlock new skill 💥", [["bmx", 1], ["skill-progression", 0.8], ["tutorial", 0.7], ["bmx-freestyle", 0.7]], "bmxrider"),
  clip("bmx-2", "instagram", "🔥 PURE BMX ADRENALINE! She launches, spins, lands", [["bmx", 1], ["bmx-freestyle", 0.9], ["highlight", 0.7], ["bmx-girl", 0.6]], "bmxrider"),
  clip("bmx-3", "tiktok", "Cosa de riders BMX 🔥 #bmx #bmxforever", [["bmx", 1], ["bmx-freestyle", 0.8], ["rider-culture", 0.6]], "bmxriding"),
  // Basketball drills (their discovery query contains the letters "ski")
  clip("hoops-1", "instagram", "Different drills. Different results. 🏀", [["basketball", 1], ["ball-handling", 0.9], ["drills", 0.8], ["basketball-training", 0.7]], "basketballskills"),
  clip("hoops-2", "instagram", "🏀 Build your game one skill at a time!", [["basketball", 1], ["ball-handling", 0.8], ["basketball-skills", 0.8], ["footwork", 0.6]], "basketballskills"),
  // A rap freestyle
  clip("rap-freestyle", "youtube", "Megan Thee Stallion - Thin Ice - Tina Tuesday Freestyle", [["hip-hop", 1], ["music", 0.8], ["megantheestallion", 0.7], ["freestyle", 0.7]], "music"),
  // Coffee: a tutorial, and a POV clip that shares only its format with the motocross clips
  clip("coffee-tutorial", "youtube", "How to pull a perfect espresso shot", [["coffee", 1], ["espresso", 0.9], ["tutorial", 0.7]], "coffee shorts"),
  clip("coffee-pov", "youtube", "First coffee with an upgraded setup ☕️", [["coffee", 1], ["satisfying", 0.8], ["pov-storytelling", 0.7], ["asmr", 0.6], ["pov", 0.6]], "coffee shorts"),
  // Motocross
  clip("moto-pov", "youtube", "Backflip over the big gap, rider view", [["motocross", 1], ["stunt-motocross-rider-pov", 0.9], ["pov", 0.7]], "motocross shorts"),
  clip("moto-bigair", "tiktok", "Biggest whip of the night", [["motocross", 1], ["motocross-big-air", 0.9], ["highlight", 0.6]], "motocross"),
  clip("moto-race", "youtube", "Holeshot to checkered flag", [["motocross", 1], ["motocross-racing", 0.8]], "motocross shorts"),
  // AI tools
  clip("ai-1", "youtube", "AI TOOLS TIER LIST (2026)", [["ai-tools", 1], ["tier-list", 0.7], ["review", 0.6]], "ai tools shorts"),
  clip("ai-2", "instagram", "Stop paying for AI tools you barely use", [["ai-tools", 1], ["free-tools", 0.8], ["review", 0.6]], "aitools"),
  clip("ai-3", "tiktok", "The best AI tools for every task right now", [["ai-tools", 1], ["productivity", 0.8], ["listicle", 0.6]], "aitools"),
  // "tools" without AI, and "AI" without tools
  clip("wood-tools", "youtube", "Five hand tools every woodworker needs", [["woodworking", 1], ["hand-tools", 0.9], ["tools", 0.7]], "woodworking shorts"),
  clip("ai-art", "youtube", "This painting was made by AI", [["ai-art", 1], ["digital-art", 0.8]], "ai art shorts"),
];

export const byId = Object.fromEntries(CATALOG.map((c) => [c.id, c]));
