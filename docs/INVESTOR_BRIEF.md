# axol — investor brief

## One line

axol is a short-video feed with no creators to please and no platform to grow: every clip is
selected by AI for exactly one person, from across YouTube Shorts, TikTok and Instagram Reels, and
the selection is retrained from how long that person actually watches.

## The problem

Every major short-video feed optimizes for the platform: ad load, creator retention, trending
amplification, cross-promotion of its own products. Users feel it as drift. They say they want
cooking and climbing; within a week they're watching rage bait. There is no feed whose only objective
is *this user's* satisfaction, and no feed that spans platforms.

## What we built

1. **Natural-language onboarding.** You write a paragraph about what you love and what you never
   want to see. A language model turns it into a weighted interest profile, a set of adjacent
   interests to explore, hard exclusions, and search queries per platform.
2. **Cross-platform sourcing.** The same profile drives discovery on Shorts (official API), TikTok
   and Reels (licensed providers and user links), with playback through each platform's official
   embed player — no rehosting, no copyright exposure.
3. **A two-speed learning engine.**
   - *Fast loop, every clip:* the app measures real watch time, loops, likes, skips and hides,
     converts that to an engagement score, and nudges the interest weights on the spot. The user
     sees it happen ("Learned: ▲ jazz piano").
   - *Slow loop, every dozen clips:* a language model re-reads the history and the weights, rewrites
     the person's taste summary in plain English, introduces new interests to test, and reissues
     discovery queries. It reasons about *why* things worked, not just *that* they did.
4. **Ranking that stays interesting.** Interest fit plus a formal exploration bonus (the same
   upper-confidence-bound idea used in bandit systems), a diversity penalty so the feed never feels
   like one note, and one deliberate wild card per batch for variable reward.
5. **Transparency as a feature.** Every card says why it's there. The profile screen shows every
   weight, where it came from, and lets the user boost, mute, or delete it.

## Why it's defensible

- **The data is the moat, and it's per-user.** Watch-time-trained preference vectors across three
  platforms don't exist anywhere else; each day of use makes a user's feed harder to replicate.
- **Platform-agnostic by design.** When the next short-video platform appears, it's one adapter.
  axol owns the taste layer, not the content.
- **LLM-native profiling.** Competitors' recommenders are embedding similarity over clicks. Ours
  combines that style of fast numeric learning with a model that can read "I want to get better at
  cooking, mostly street food, no pranks" and act on it in one step — and explain itself.

## Traction plan

- Pilot: invite-only cohort; the metric that matters is **average completion rate** trend over the
  first 50 clips per user (our engine's direct objective) and **day-7 return**.
- Expansion: creator-free means no cold-start chicken-and-egg; growth is pure user acquisition.
- Monetization options that don't corrupt the objective: subscription ("your feed, no ads"),
  and opt-in sponsored discovery queries that are ranked by the same engine and labelled as such.

## What's real today

A working product: accounts, onboarding, ingestion from all three platforms, the full learning and
ranking engine, re-synthesis, a profile screen with controls, and a feed built for feel: instant
autoplay, preloaded next clips, double-tap hearts, and live "what I just learned" feedback.
Runs on one small server (Node + SQLite); the AI layer is Claude with deterministic fallbacks, so
cost per user is a few cents per day at pilot scale and an outage degrades quality, not uptime.

## Honest constraints

- TikTok and Instagram do not offer public search APIs to third parties. Automated discovery there
  requires licensed data access; until then those platforms are fed by user-shared links while
  Shorts is fully automated. This is a business-development item, not an engineering one.
- Opaque embed players report dwell time rather than exact playback; the model treats both the same
  way and it is enough signal, but direct partnerships would sharpen it.

## The ask

Seed funding for: licensed TikTok/Reels discovery access, a mobile wrapper, and a 5,000-user pilot
to produce the completion-rate and retention curves above.
