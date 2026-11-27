# Reels-style feed ranking

The main feed (`GET /api/feed`) is ordered by `server/src/reelsRanker.js`, modelled on what
Instagram has said publicly about how Reels and Explore are ranked. Instagram's real system is
private and uses large learned models; this is a transparent, hand-weighted version of the same
idea that runs inside axol's SQLite database with no extra services.

## Pipeline

1. **Log engagement** (`web/src/lib/engagement.js`). Every per-clip beacon the player already
   sends (finish, skip, like, share, hide) is mirrored into a queue, so buttons, double taps and
   hands-free actions are all covered without extra calls. The queue sends batches to
   `POST /api/engagement` every 5 s, when 20 are waiting, and when the page is hidden or closed
   (keepalive request).
   - `view`: sent once when a clip leaves the screen, with watch time, length, completion,
     rewatches and `quickSkip` (left within 2 s)
   - `like` / `unlike`, `share` (share sheet), `copy_link`, `hide` ("Not interested"), and
     `save` / `unsave` (the server accepts these; there's no Save button yet)
2. **Store and aggregate** (`server/src/engagement.js`, migration 1 in `server/src/migrations.js`).
   - `engagement_events`: the raw log. Repeats (a retried batch, a double tap) are logged with
     `applied = 0` and not counted twice; an unlike only counts after a counted like.
   - `user_affinity`: per viewer, a decaying score for each **creator**, **main topic** and
     **tag** (top 5 by relevance). Each event adds its value (below). Scores halve every 14 days
     without new activity, so recent taste matters most.
   - `clip_stats`: per clip, everyone's views, completion, quick skips, rewatches, likes,
     shares, saves and hides. No user ids.
   - Promoted and sponsored clips are logged but don't train anything.
3. **Score every candidate** (`scoreCandidate`). The score is a weighted sum of predicted engagement:
   `creator affinity + topic affinity + tag affinity + stated interests + clip quality + freshness
   - already-seen penalty (+ an "instant play" bonus and a tiny tie-break noise)`.
   - Affinities are squashed with `tanh` so one binge can't swamp everything.
   - *Stated interests* is the existing interest model (onboarding, search, More/Less taps), so
     everything axol already learned still counts, and muted topics are still never shown.
   - *Clip quality* is each rate (completion, likes, shares, saves, quick skips, hides per view)
     smoothed toward a prior, so a clip with two views can't look perfect.
4. **Cold start.** Until a viewer has 15 counted events, personal affinity fades in gradually and
   *popularity* (views × quality) fills the gap, and the batch is spread one topic at a time.
5. **Diversity re-rank** (`diversify`): never two clips in a row from one creator, never more than
   two in a row on one topic (one for new viewers). If the catalog can't satisfy that, the feed
   still fills rather than coming back empty.
6. **Exploration** (`explorationSlots`, `assembleBatch`): each slot from the third on has a 15%
   chance (max 25% of a batch, about 11% on average for a batch of 8) of going to a clip that's new
   to the viewer (no creator, topic or tag history) or seen by fewer than 5 people. These are
   labelled "Something new, to see if it lands".
7. **Explanations** keep axol's truthful labels. A clip picked mainly for its creator, after at
   least two positive interactions with them, says "Because you watch @creator".

## Where each signal comes from

| Signal in axol | What Instagram has said |
| --- | --- |
| Completion / watch time, rewatches | Mosseri (2023): the top predictions include how likely you are to "watch a reel all the way through". Mosseri (Jan 2025): "The top three signals that matter most for ranking are watch time, likes and sends." |
| Shares and copied links ("sends"), weighted above likes | Mosseri (2023) lists "how likely you are to reshare a reel" first. In 2025 he said sends are "slightly more important for unconnected content", which is every clip on axol. |
| Likes, saves | Mosseri (2023): "which reels you've liked, saved, reshared, commented on, and engaged with recently". |
| Quick skips (< 2 s) as negative | Meta's Reels Chaining system card: "How many times the post has been skipped within two seconds of being opened" feeds the prediction "how likely you are to watch less than three seconds of a reel". |
| Hide / Not interested as the strongest negative | Reels Chaining card: "Not interested" makes the system "filter out similar content". Meta's Explore post: `Expected Value = W_click * P(click) + W_like * P(like) – W_see_less * P(see less)`. |
| Creator affinity | Mosseri (2023): "Your history of interacting with the person who posted". |
| Topic and tag affinity, time decay | Mosseri (2023): engagement "recently"; the Reels Chaining card: "how well the reel matches content you tend to interact with". |
| Clip quality / popularity, cold start | Mosseri (2023): "information about the reel ... as well as popularity"; Mosseri (2025): judge reels by "likes per reach, and sends per reach" (rates, not totals). |
| Weighted sum of predicted actions | Meta's Explore engineering post (the value model above). |
| Diversity rule | Explore post: "Do not show items from the same authors in a sequence". Mosseri: "we try to avoid showing too many posts from the same person in a row". |
| Exploration | Explore is for discovering "new content and creators" (Mosseri, 2023). The exploration rate is axol's choice. |

Sources:
- Adam Mosseri, "Instagram Ranking Explained", May 31 2023: https://about.instagram.com/blog/announcements/instagram-ranking-explained
- Mosseri's Jan 2025 video, as quoted by Social Media Today: https://www.socialmediatoday.com/news/instagram-shares-algorithm-insights-2025/738034/
- Meta Transparency Center, Instagram Reels Chaining AI system card: https://transparency.meta.com/features/explaining-ranking/ig-reels-chaining/
- Meta Engineering, "Scaling the Instagram Explore recommendations system", Aug 9 2023: https://engineering.fb.com/2023/08/09/ml-applications/scaling-instagram-explore-recommendations-system/

None of these give weights or thresholds. The numbers in axol are starting guesses that follow
the published order of importance.

## Tuning

All the knobs are in `server/src/rankingConfig.js`, with comments:
- `eventValue`: what each action is worth (sends > likes, hides most negative, the 2 s quick-skip line).
- `affinity.halfLifeDays`: how fast taste fades. Lower it for a feed that reacts faster.
- `weights`: the balance between creator, topic, tag, stated interest, quality, freshness and the seen penalty.
- `quality`: priors and how much each global rate counts.
- `coldStart.events` / `coldStart.popularity`: how long popularity carries a new viewer.
- `diversity`: the maximum run per creator and per topic.
- `exploration.rate` / `maxShare`: how much of the feed tests new things.

To check a change, run `npm test --prefix server`. `server/test/ranking.test.js` covers the
scoring rules and `server/test/engagement.test.js` covers the feed end to end. Both use a seeded
RNG, so the results don't change between runs.

## Limits

- Personalization needs data. A viewer's own affinities reach full weight after 15 counted
  events, and clip quality means little until a clip has a few dozen views. Until then the feed
  runs on onboarding interests, popularity and freshness.
- Weights are hand-set, not learned. A next step would be fitting them to logged completions.
- Aggregates are updated as each event arrives, inside SQLite. That's fine at axol's scale; at
  much larger scale the stats would move to a batch job.
