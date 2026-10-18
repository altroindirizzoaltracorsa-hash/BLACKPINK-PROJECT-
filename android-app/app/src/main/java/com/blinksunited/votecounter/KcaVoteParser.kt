package com.blinksunited.votecounter

import org.json.JSONObject

/** A parsed Kids' Choice round: what of it was ours, and what the collab counts. */
data class KcaVoteResult(
    /** Picks for OUR nominees, by ballot category slug. Goes to the Kids' Choice board. */
    val cats: Map<String, Int>,
    /** Every pick the collab counts — ours AND the partner's. Goes to the collab board. */
    val collabCats: Map<String, Int>,
    /** Human label for the toast, e.g. "Music Group or Duo". */
    val label: String,
    /** Picks in the round that were nobody's we track. Normal, and not an error. */
    val skipped: Int,
    /** True when the round could not be read at all because the ballot was missing. */
    val noBallot: Boolean,
    /** Stable key for this round, so a retry is not counted twice. */
    val dedupeKey: String
) {
    val total: Int get() = cats.values.sum()
    val collabTotal: Int get() = collabCats.values.sum()
}

/**
 * Port of the extension's Kids' Choice counting (background.js: KCA_NOMINEES,
 * COLLAB, processKcaVote). Kept deliberately parallel: the two must agree, or the
 * same votes count differently depending on which one a blink happens to use.
 *
 * ONE ROUND IS SEVERAL VOTES. The Kids' Choice ballot does not submit per
 * category — a round carries up to one pick per category and is sent at the end —
 * so a round in which somebody picked BLACKPINK, ROSÉ and Dracula is 3, not 1.
 *
 * A pick counts only when BOTH the category and the nominee match. Another artist
 * in one of our categories is not ours, and that check is most of what this is
 * for: the ballot has six entries in each of ours.
 */
object KcaVoteParser {

    /** Our nominees: ballot category slug -> the title the ballot gives them. */
    private val KCA_NOMINEES: Map<String, Pair<String, String>> = mapOf(
        // slug to (nominee title as the ballot writes it, artist)
        "favorite-music-group-or-duo" to ("BLACKPINK" to "BLACKPINK"),
        "favorite-female-artist" to ("ROSÉ" to "ROSÉ"),
        "favorite-music-collaboration" to ("Dracula (with JENNIE)" to "JENNIE")
    )

    /** Short labels for the in-app roster. */
    val CATEGORIES: Map<String, String> = mapOf(
        "favorite-music-group-or-duo" to "Music Group or Duo",
        "favorite-female-artist" to "Female Artist",
        "favorite-music-collaboration" to "Music Collaboration"
    )

    /**
     * The fandom collab (blinksunited.com/collabs). BLINKs and BLOOMs fill each
     * other's categories on this ballot, so the collab counts the WHOLE pass —
     * ours as well as theirs.
     *
     * IT IS POSTED SEPARATELY AND NEVER MIXED IN. A pick for BINI is not a
     * BLACKPINK vote: adding it to the Kids' Choice total would raise a blink's
     * BLACKPINK standing for voting BINI. Two totals, two endpoints, two tables.
     */
    private val COLLAB_NOMINEES: Map<String, String> = mapOf(
        "favorite-music-group-or-duo" to "BLACKPINK",
        "favorite-music-collaboration" to "Dracula (with JENNIE)",
        "favorite-female-artist" to "ROSÉ",
        "favorite-global-music-star" to "BINI"
    )

    /** Past this the collab is over and the app stops posting to it. */
    const val COLLAB_ID = "bvp-kca-2026"
    const val COLLAB_UNTIL_MS = 1763107140000L  // 2026-11-14T07:59:00Z

    /**
     * Compare names the way a human would: case, accents and punctuation all differ
     * between how the ballot writes a name and how we do. "ROSÉ" vs "ROSE" is the
     * one that matters today — without the accent fold, ROSÉ's votes never count.
     */
    private fun norm(s: String?): String {
        if (s == null) return ""
        val stripped = java.text.Normalizer.normalize(s, java.text.Normalizer.Form.NFD)
            .replace(Regex("\\p{InCombiningDiacriticalMarks}+"), "")
        return stripped.lowercase().replace(Regex("[^a-z0-9]+"), "")
    }

    /**
     * @param json what counter.js posted: { picks:[{slug,title}], marks, sig, ballot }.
     *   `picks` are already resolved from option ids in the page, where the ballot is.
     */
    fun parse(json: String?): KcaVoteResult? {
        if (json == null) return null
        return try {
            val o = JSONObject(json)
            val marks = o.optInt("marks", 0)
            if (marks <= 0) return null
            val hadBallot = o.optBoolean("ballot", false)
            val sig = o.optString("sig", "")

            if (!hadBallot) {
                // The round was submitted and we could not read a single pick.
                // Reported rather than silently zero: it is the one failure a blink
                // can act on (reload the page), and it looks identical to "you
                // voted for nobody" if we say nothing.
                return KcaVoteResult(emptyMap(), emptyMap(), "Kids’ Choice", marks, true, sig)
            }

            val picks = o.optJSONArray("picks")
            val cats = HashMap<String, Int>()
            val collab = HashMap<String, Int>()
            var matched = 0
            var lastLabel: String? = null
            for (i in 0 until (picks?.length() ?: 0)) {
                val p = picks!!.optJSONObject(i) ?: continue
                val slug = p.optString("slug", "")
                val title = p.optString("title", "")
                if (slug.isBlank()) continue

                // Checked for every pick INCLUDING the partner's, and before the
                // "is it ours" test below, which rightly calls a BINI pick not ours.
                COLLAB_NOMINEES[slug]?.let { want ->
                    if (norm(want) == norm(title)) collab[slug] = (collab[slug] ?: 0) + 1
                }

                val mine = KCA_NOMINEES[slug] ?: continue
                if (norm(mine.first) != norm(title)) continue
                cats[slug] = (cats[slug] ?: 0) + 1
                matched += 1
                lastLabel = CATEGORIES[slug] ?: slug
            }

            val label = when {
                cats.size > 1 -> "${cats.size} categories"
                lastLabel != null -> lastLabel!!
                else -> "Kids’ Choice"
            }
            KcaVoteResult(cats, collab, label, marks - matched, false, sig)
        } catch (e: Exception) {
            null
        }
    }
}
