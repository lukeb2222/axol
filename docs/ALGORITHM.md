# How the axol engine works

This is the exact algorithm as implemented in `server/src`. File references point at the code.

## 1. The data model

Each user has an **interest vector**: a map `tag → weight`, stored in `interests`
(`server/src/db.js`). Weights live in roughly `[-5, 5]`. Each row also tracks how many times the
user has been shown a clip carrying that tag (`impressions`) and how many of those landed
(`positive`), plus where the interest came from: `onboarding`, `learned` (adopted from behaviour),
or `ai` (introduced by re-synthesis for exploration).

Each clip has a **tag list with relevances**: `[{ tag, relevance ∈ [0,1] }]`, produced once by the
tagger (§3) and stored on the `videos` row. Tags cover topic ("sourdough-baking"), format
("tutorial", "pov", "highlight"), and vibe ("satisfying", "comedy").

Every time a clip is served it creates an **impression** row that accumulates behaviour:
`watched_ms`, `duration_ms`, `replays`, `liked`, `shared`, `hidden`, `skipped`, and finally a
`score` once the card leaves the screen.

## 2. Cold start: onboarding → profile (`server/src/ai/profile.js`)

Input: the user's free-text intro plus any tags they tapped.

With Claude available, one structured-output call (`claude-opus-5-5`, zod schema enforced by
`output_config.format`) returns:

- `interests[]`: `{ tag, weight 0–1, why }` — central interests, weighted by centrality.
- `adjacent[]`: tasteful guesses they didn't mention (weights 0.2–0.5) to widen the feed.
- `avoid[]`: only *explicit* dislikes. These become hard filters, never soft penalties.
- `queries`: 6–10 discovery queries per platform, mixing formats within the person's topics.
- `summary`: the "what the feed thinks of you" text shown on the profile screen.

The server scales onboarding weights by 2.5 (so a top interest starts at 2.5 of a max 5) and
adjacent ones by 1.5, leaving headroom for behaviour to overtake stated preference.

Fallback (no key / refusal / API error): a keyword taxonomy of ~90 interests with prefix matching
(`server/src/ai/taxonomy.js`) extracts tags, counts mentions for weights, and a small grammar
(`no / not / hate / avoid / less …`) extracts dislikes. Queries are derived from tag names.

## 3. Ingestion and tagging (`server/src/ingest.js`, `server/src/sources/*`, `server/src/ai/tagger.js`)

Each `(user, source, query)` is a `discovery_query`. Discovery runs on onboarding, after each
re-synthesis, and lazily whenever the user's unseen pool drops below 12 clips (bounded to 12 s so the
feed never stalls). Adapters normalize each platform into the same item shape:

- **YouTube Shorts**: official Data API `search.list` (`videoDuration=short`, `videoEmbeddable=true`,
  `q="<query> #shorts"`) → `videos.list` for ISO-8601 durations; clips over 3 minutes are dropped.
- **TikTok / Instagram Reels**: a pluggable discovery provider returning URLs, or user-pasted links.
  Public oEmbed enriches titles/creators when available.

New clips are tagged in batches of 25 by one structured Claude call at `effort: "low"` (title,
description, creator, and the discovery query as a strong hint). Fallback tagging uses the taxonomy
plus the query itself at relevance 0.9.

## 4. Behaviour capture (`web/src/components/VideoCard.jsx`)

The client measures, per impression:

| Signal | How it's measured |
|---|---|
| `watched_ms` | YouTube: 250 ms polling of the IFrame Player; only time in the PLAYING state counts. TikTok/IG embeds don't expose playback, so it's **dwell time** while the card is the active slide and the tab is visible. |
| `duration_ms` | From the player, from the Data API, or assumed 20 s for opaque embeds. |
| `replays` | Each ENDED event (we loop clips manually by seeking to 0). |
| `liked`, `shared`, `hidden` | Explicit taps; double-tap is a like. |
| `skipped` | Card left the screen with < 2.5 s watched. |

Progress is sent every 2 s (survives tab close via `keepalive`), and a `finish` event fires when the
card scrolls away. Learning is triggered once per impression, on `finish`, `skip`, or `hide`.

## 5. Engagement score (`server/src/learner.js → engagementScore`)

```
completion = min(1.5, watched_ms / max(duration_ms, 5000))      # loops push it above 1
if hidden:                                score = -1.5
elif watched < 2.5 s and completion < .25: score = -1.0           # hard skip
else:                                     score = clamp((completion - 0.45) * 2, -1, 1.2)
score += 0.6 if liked, 0.5 if shared, 0.2 × min(3, replays)
score = clamp(score, -1.5, 2)
```

The key design choice is the **neutral point at 45 % completion**: watching less than half is a
negative signal, finishing is strongly positive, and looping or liking stacks on top. This makes
the dominant input *time*, which is far harder to fake than a tap.

## 6. Interest update (`server/src/learner.js → learnFromImpression`)

For every tag `t` on the clip with relevance `r`, and the current weight `w`:

```
decay:   all of the user's weights *= 0.995                      # keeps the model plastic
room  = 1 - min(1, |w| / 5)                                      # soft ceiling
Δw    = 0.18 · score · r · (0.35 + 0.65 · room)
w'    = clamp(w + Δw, -5, 5)
```

- A tag the user has never had is **adopted** only when the clip clearly landed
  (`score > 0.3` and `r ≥ 0.5`), starting at `0.18 · score · r`. This is how the profile grows
  beyond what the user said.
- `impressions` increments on every tag seen; `positive` increments when `score > 0.15`. These feed
  the exploration term in ranking.
- A per-platform **source affinity** (mean score on that platform) is updated at the same time.

This is an online stochastic-gradient style update on a linear preference model: cheap, incremental,
and fully explainable (every weight is the sum of visible nudges).

## 7. Ranking (`server/src/ranker.js`)

Candidates are all tagged clips the user hasn't been served, minus any carrying an `avoid` tag.
Each gets:

```
match     = Σ_t w_t · r_t / max(1, Σ_t r_t)                        # interest fit
explore   = 0.35 · Σ_t r_t · sqrt( ln(N + 2) / (n_t + 1) ) / max(1, Σ r_t)
            # UCB1 bonus: tags shown rarely (n_t small) get a chance; N = user's total views
freshness = 0.20 · exp(-age_days / 14)
platform  = 0.30 · source_affinity[source]
noise     = 0.08 · Gumbel()                                        # stochastic ordering
total     = match + explore + freshness + platform + noise
```

**Topic matching.** A clip tag counts toward `match` when it is the same topic as an interest, or a
related one sharing a subject word (see section 9). Format words never link two topics.

Batch assembly is **greedy with a diversity penalty**: after each pick, any candidate sharing one of
its top-3 tags loses `0.3 × relevance` per repeat, and the same creator loses `0.45` per repeat.
Then, with 60 % probability, the highest-`explore` leftover is inserted at position 4 as a
**wild card** labelled "Something new, to see if it lands". That's the variable-reward element: most
of the batch is reliably on-taste, one card is a genuine surprise, and its outcome feeds straight
back into §6.

Each card carries a human-readable `reason` ("Because you watch skateboarding") derived from the
highest `w_t · r_t` term, so the ranking is transparent in the UI.

## 8. Periodic re-synthesis (`server/src/profileService.js → maybeResynthesize`)

Every 12 finalized impressions (or on demand from the profile screen), the server sends Claude the
current weights table plus the last 40 clips with their tags, watch percentage, likes, loops, skips.
The structured response contains:

- `adjustments[]`: `{ tag, delta ∈ [-1, 1], reason }` → applied as `w += 1.5 · delta`.
- `new_interests[]`: exploratory interests introduced at low weight (origin `ai`).
- `queries`: fresh discovery queries leaning into what is working → triggers ingestion.
- `summary` and a one-line `insight` ("You keep watching jazz piano to the end…") shown as a toast.

So the numeric learner handles fast, per-clip adaptation, and the language model handles the
slower, semantic layer: noticing that "sourdough" and "wood-fired pizza" are one appetite, that
the skateboarding interest is really about *filmmaking*, or that a stated interest is being skipped
every time. Fallback re-synthesis compares each tag's mean completion to the user's average and
nudges accordingly.

## 9. Topics: one vocabulary for search, ranking, explanations and steering (`server/src/topics.js`)

Interest names and clip tags are written by different AI calls, so the engine needs one definition
of "the same topic" and of "a real overlap":

- **Canonical identity.** `topicKey` stems each word and ignores order and filler, so
  `motocross-big-air` and `big-air-motocross` are one topic. The ranker merges such rows into one
  entry, the profile shows them as one control, and every write (boost, less, mute, learning) lands
  on the viewer's existing row for that topic.
- **Subject words versus format words.** Words such as `pov`, `tutorial`, `highlight`, `tricks`,
  `freestyle`, `satisfying` describe how a clip is made, not what it is about. Two topics are
  *related* only if they share a subject word (`specialty-coffee` and `coffee-making` share
  "coffee"); a shared format word links nothing (`coffee-pov` and `motocross-rider-pov` do not match).
  Related topics count at up to 60 % of an exact match, scaled by how much they overlap.

## 10. Search (`server/src/search.js`)

A result must match the meaning of the whole query in the clip's **own** metadata.

1. The query is reduced to its meaningful words, stemmed (`skiing` -> `ski`), and matched as whole
   words. A substring is not a match: "ski" does not hit "basketballskills".
2. Each word is looked for in the clip's tags (strongest evidence), caption/title, and description.
   The search that originally fetched the clip counts only as a weak hint, never as a match.
3. Each word is weighted by how specific it is within the catalog (inverse document frequency):
   "freestyle" appears in BMX, rap and skiing clips, "skiing" in few.
4. **Results** are clips matching every word (a long query may miss one minor word). The heading's
   count is the length of this list, and the grid and the swipeable player page through the same
   ordered ids, so they cannot disagree.
5. **Related** clips match the query's most specific word but not all of it. They are never mixed
   into the results; the screen offers them separately.
6. **Fresh discovery is explicit.** Searching never spends platform quota by itself. A separate
   action runs a live search where budget allows; when a platform's daily budget is spent the screen
   says so. Whatever is fetched is shown only if it passes steps 1-4 like everything else.

A search still records the topic as an interest (0.8, or +0.3 if present) and saves discovery
queries, so the feed's own discovery cadence looks for it later.

## 11. Explanations (`server/src/ranker.js -> explain`)

Each clip's explanation is built from the terms that actually produced its score, and the short
label and the Why panel are the same object. "Because you watch X" requires both sides:

- **the viewer's side:** an interest they have watched through at least once, and
- **the clip's side:** a tag relevant to the clip (>= 0.5) that is that topic, or contains it,

and the interest fit must be what selected the clip (not exploration or freshness). The label names
the common ground, so `specialty-coffee` + a clip tagged `coffee` reads "Because you watch coffee".
An interest the viewer stated but has not watched reads "Because you asked for X". Everything
weaker, including interests axol only guessed, uses the discovery label.

## 12. Steering from the player (`server/src/feedService.js -> steerFeed`)

The Why panel offers "More X" / "Less X" for the subjects that describe the clip on screen.

- **More** is the profile's boost (+1, lifting a turned-down topic back above zero), and creates the
  interest if the viewer had none. **Less** is a lasting down-weight (to at most -1.5). It is
  deliberately not mute: mute removes a topic entirely and stays on the profile screen.
- The clips already loaded *after* the current one are re-planned at once; the current clip is not
  touched. Less swaps every queued clip about the topic for the best clip that is not. More places
  up to two clips about the topic within the next three, taken first from further down the queue.
- The response states what actually changed. If nothing matching is in stock, the app says the wish
  was noted rather than implying an immediate match.

Clips a platform refuses to play are closed at a neutral score, so they never count as a skip. A
definitive verdict from the platform (removed, private, embedding disabled) retires the clip for
everyone.

## 13. Safeguards and controls

- `avoid` tags are hard filters at ranking time; users can mute, boost, or remove any interest.
- Weights saturate softly and decay globally, so no single interest can permanently dominate.
- Every re-synthesis is logged (`synth_log`) and visible as "tuning history".
- All AI calls have deterministic fallbacks; a refusal or outage degrades quality, never availability.
