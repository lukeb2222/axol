// Lightweight interest taxonomy used by heuristic fallbacks and to normalize tags.
// Keys are canonical tags; values are trigger words/phrases.
export const TAXONOMY = {
  skateboarding: ["skate", "skateboard", "kickflip", "ollie"],
  surfing: ["surf", "surfing", "waves"],
  snowboarding: ["snowboard", "ski", "skiing"],
  basketball: ["basketball", "nba", "dunk", "hoops"],
  soccer: ["soccer", "football", "premier league", "goal"],
  "american-football": ["nfl", "touchdown", "quarterback"],
  tennis: ["tennis"],
  mma: ["mma", "ufc", "boxing", "jiu jitsu", "bjj", "wrestling"],
  fitness: ["gym", "workout", "fitness", "lifting", "bodybuilding", "calisthenics"],
  running: ["running", "marathon", "sprint"],
  climbing: ["climbing", "bouldering"],
  yoga: ["yoga", "stretching", "mobility", "pilates"],
  cooking: ["cooking", "recipe", "recipes", "chef", "kitchen", "baking", "food"],
  "street-food": ["street food", "food tour", "food review", "mukbang"],
  coffee: ["coffee", "espresso", "latte", "barista"],
  travel: ["travel", "backpacking", "trip", "vacation", "wanderlust"],
  cities: ["city", "tokyo", "new york", "london", "paris", "urban"],
  nature: ["nature", "wildlife", "forest", "ocean", "mountains", "hiking", "outdoors", "camping"],
  animals: ["animals", "dogs", "cats", "puppy", "kitten", "pets", "cute animals"],
  science: ["science", "physics", "chemistry", "biology", "experiment"],
  space: ["space", "nasa", "astronomy", "rocket", "spacex", "planets"],
  math: ["math", "mathematics", "puzzle", "geometry"],
  engineering: ["engineering", "machines", "mechanical", "how it works", "how its made", "manufacturing"],
  programming: ["coding", "programming", "developer", "software", "javascript", "python", "rust", "typescript"],
  ai: ["ai", "artificial intelligence", "machine learning", "llm", "robotics", "robots"],
  gadgets: ["tech", "gadgets", "iphone", "android", "unboxing", "pc build", "keyboard"],
  gaming: ["gaming", "video games", "minecraft", "fortnite", "valorant", "league of legends", "speedrun", "esports"],
  "retro-gaming": ["retro games", "nintendo", "n64", "snes", "arcade"],
  anime: ["anime", "manga", "one piece", "naruto", "jujutsu"],
  movies: ["movies", "film", "cinema", "movie review", "trailer"],
  tv: ["tv shows", "series", "netflix", "sitcom"],
  music: ["music", "songs", "concert", "producer", "beats"],
  guitar: ["guitar", "bass guitar", "riff"],
  piano: ["piano", "keys"],
  drums: ["drums", "drummer", "percussion"],
  "hip-hop": ["hip hop", "rap", "rapper", "freestyle"],
  edm: ["edm", "house music", "techno", "dj"],
  jazz: ["jazz", "saxophone"],
  classical: ["classical music", "orchestra", "violin", "cello"],
  dance: ["dance", "dancing", "choreography", "ballet", "breakdance"],
  comedy: ["comedy", "funny", "jokes", "stand up", "standup", "sketch", "memes", "humor"],
  pranks: ["prank", "pranks"],
  satisfying: ["satisfying", "oddly satisfying", "asmr", "relaxing"],
  art: ["art", "painting", "drawing", "sketching", "illustration", "watercolor"],
  design: ["design", "graphic design", "ui", "ux", "typography", "architecture", "interior design"],
  photography: ["photography", "camera", "photo", "cinematography", "filmmaking"],
  fashion: ["fashion", "outfit", "streetwear", "sneakers", "style", "ootd"],
  beauty: ["makeup", "skincare", "beauty", "hair", "nails"],
  diy: ["diy", "woodworking", "crafts", "home improvement", "renovation", "3d printing"],
  cars: ["cars", "supercar", "jdm", "drift", "f1", "formula 1", "racing", "motorcycle", "motorbike"],
  aviation: ["planes", "aviation", "pilot", "airport", "jets"],
  history: ["history", "ancient", "medieval", "ww2", "historical"],
  philosophy: ["philosophy", "stoicism", "ethics"],
  psychology: ["psychology", "mindset", "mental health", "habits"],
  productivity: ["productivity", "study", "studying", "notion", "focus"],
  business: ["business", "entrepreneur", "startup", "startups", "marketing"],
  finance: ["finance", "investing", "stocks", "crypto", "bitcoin", "money", "economics"],
  "real-estate": ["real estate", "house tour", "mansion"],
  books: ["books", "reading", "booktok", "novels"],
  language: ["language learning", "languages", "spanish", "japanese", "korean", "french lessons"],
  "true-crime": ["true crime", "mystery", "unsolved"],
  motivation: ["motivation", "motivational", "self improvement", "discipline"],
  parenting: ["parenting", "kids", "baby", "family"],
  gardening: ["gardening", "plants", "houseplants", "garden"],
  magic: ["magic", "magic tricks", "illusion", "card tricks"],
  chess: ["chess", "gambit", "grandmaster"],
  "extreme-sports": ["parkour", "bmx", "skydiving", "base jump", "stunts", "extreme"],
  "street-interviews": ["street interview", "interviews", "man on the street"],
  "life-hacks": ["life hacks", "hacks", "tips", "tricks"],
  "pov-storytelling": ["pov", "storytime", "story time", "vlog"],
};

export function normalizeTag(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/^#/, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 40);
}

/** Heuristic: extract canonical tags from free text. Returns Map tag -> hits. */
export function extractTags(text) {
  const t = ` ${String(text || "").toLowerCase().replace(/[^a-z0-9#\s]/g, " ")} `;
  const hits = new Map();
  for (const [tag, triggers] of Object.entries(TAXONOMY)) {
    for (const trig of triggers) {
      const esc = trig.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Short triggers must match whole words ("ai"); longer ones match as prefixes
      // so "skate" covers "skateboarding" and "surf" covers "surfing".
      const re = new RegExp(trig.length <= 4 ? `\\b${esc}\\b` : `\\b${esc}\\w*`, "g");
      const n = (t.match(re) || []).length;
      if (n) hits.set(tag, (hits.get(tag) || 0) + n);
    }
  }
  // Also keep explicit hashtags and comma-separated phrases the taxonomy missed.
  for (const m of String(text || "").matchAll(/#([a-zA-Z0-9_]+)/g)) {
    const tag = normalizeTag(m[1]);
    if (tag && !hits.has(tag)) hits.set(tag, 1);
  }
  return hits;
}
