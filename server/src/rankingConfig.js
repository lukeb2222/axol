// Every knob of the Reels-style feed ranking, in one place.
//
// How the pieces fit (see docs/ranking.md for the long version):
//   score(clip, viewer) =  affinity terms (creator, topic, tags, stated interests)
//                        + clip quality (how everyone else engaged with it)
//                        + freshness
//                        - already-seen penalty
//   then: diversity re-ranking (no long runs of one creator or topic)
//   then: ~15% exploration slots for clips the viewer has nothing on yet.
//
// Instagram has never published weights, only which signals matter and roughly in what order.
// The numbers below follow that order (sends/shares and completion strongest, then likes and
// saves, quick skips and "not interested" negative) and are meant to be tuned against real data.
// Raising one weight makes that signal matter more relative to the others; all are unitless.

export const RANKING = {
  /* ------------------------------------------------------------------------------------
   * 1. What one viewer action is worth. Each logged event adds this much to the viewer's
   *    affinity for the clip's creator, its main topic and its tags.
   * ---------------------------------------------------------------------------------- */
  eventValue: {
    // Watch time / completion. Value = watch * (completion - neutralCompletion), with
    // completion capped at 1. Watching the whole clip is worth +0.55, half of it about 0.
    watch: 1.0,
    neutralCompletion: 0.45,
    // Each loop back to the start (a rewatch), counted up to maxRewatches times.
    rewatch: 0.3,
    maxRewatches: 3,
    // Leaving within quickSkipMs is a quick skip. It replaces the watch term (Meta's Reels card:
    // "how many times the post has been skipped within two seconds of being opened").
    quickSkip: -0.6,
    quickSkipMs: 2000,
    // Explicit actions. Mosseri (Jan 2025): sends matter slightly more than likes for clips from
    // people you don't follow, which is every clip on axol.
    share: 1.0,        // sent through the share sheet (a "send")
    copyLink: 0.8,     // link copied: a send without the share sheet
    like: 0.7,
    save: 0.8,
    hide: -1.5,        // "Not interested": the strongest negative
  },

  /* ------------------------------------------------------------------------------------
   * 2. How fast a viewer's taste fades. Affinity halves every halfLifeDays without new
   *    activity, so last week's binge counts more than last month's.
   * ---------------------------------------------------------------------------------- */
  affinity: {
    halfLifeDays: 14,
    // Affinities are squashed with tanh(score / scale) into -1..1 before weighting, so one
    // creator binge can't swamp everything else.
    scale: 2.5,
    tagsPerClip: 5,    // only a clip's most relevant tags train / are scored
  },

  /* ------------------------------------------------------------------------------------
   * 3. The scoring weights: how much each predicted-engagement term counts.
   * ---------------------------------------------------------------------------------- */
  weights: {
    creatorAffinity: 0.9,   // "your history of interacting with the person who posted"
    topicAffinity: 0.8,     // "which reels you've liked, saved, reshared ... recently", by topic
    tagAffinity: 0.6,       // the same, at the finer level of a clip's tags
    statedInterest: 0.7,    // the interest model from onboarding, search and More/Less taps
    quality: 0.6,           // global completion / like / share rates ("popularity")
    freshness: 0.25,        // newer clips get a lift that fades with freshnessHalfLifeDays
    seenPenalty: 0.8,       // per earlier time this clip was put in front of the viewer
    instant: 0.25,          // axol holds the file: starts instantly, never fails to play
    noise: 0.05,            // tiny random tie-breaker so equal clips don't always come in one order
  },
  freshnessHalfLifeDays: 10,

  /* ------------------------------------------------------------------------------------
   * 4. Clip quality: rates over everyone's views, smoothed toward a prior so a clip with
   *    two views can't look perfect. priorViews is how many "average" views each clip
   *    starts with.
   * ---------------------------------------------------------------------------------- */
  quality: {
    priorViews: 10,
    prior: { completion: 0.45, like: 0.05, share: 0.02, save: 0.02, quickSkip: 0.3, hide: 0.02 },
    // Quality = weighted average of each rate's lift over its prior, (rate - prior) / prior,
    // with each lift clamped to [-1, maxLift] so one viral number can't run away with it.
    maxLift: 2,
    weights: { completion: 0.5, like: 0.25, share: 0.3, save: 0.15, quickSkip: -0.35, hide: -0.4 },
  },

  /* ------------------------------------------------------------------------------------
   * 5. Cold start. Until a viewer has coldStartEvents engagement events, personal affinity
   *    is blended in gradually and popularity (views x quality) fills the gap.
   * ---------------------------------------------------------------------------------- */
  coldStart: {
    events: 15,
    popularity: 0.6,        // weight of popularity at zero history (fades to 0 at `events`)
  },

  /* ------------------------------------------------------------------------------------
   * 6. Diversity. Applied after scoring, like Meta's Explore rule "do not show items from
   *    the same authors in a sequence" and Mosseri's "too many posts from the same person
   *    in a row".
   * ---------------------------------------------------------------------------------- */
  diversity: {
    maxSameCreatorInRow: 1,
    maxSameTopicInRow: 2,
    coldStartMaxSameTopicInRow: 1, // new viewers see a wider spread
    window: 60,                    // how deep in the ranked list to look for a substitute
  },

  /* ------------------------------------------------------------------------------------
   * 7. Exploration: about this share of each batch goes to clips the viewer has no history
   *    with (new creator and topic) or that few people have seen yet.
   * ---------------------------------------------------------------------------------- */
  exploration: {
    rate: 0.15,
    maxShare: 0.25,       // never more than this share of a batch
    underExposedViews: 5, // a clip with fewer global views than this counts as new
    firstSlot: 2,         // exploration never takes the first two slots of a batch
  },
};
