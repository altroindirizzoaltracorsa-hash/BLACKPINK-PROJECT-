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
    val dedupeKey: String,
    /**
     * A nominee whose ballot title CONTAINS the name we look for but does not
     * match it — (what we expect, what the ballot said). It means a vote is
     * being thrown away, which is otherwise indistinguishable from nobody
     * voting: "Asia: BINI" ran for days as a zero on the board. Port of
     * kcaNameNearMiss in background.js. Null is the normal case.
     */
    val renamed: Pair<String, String>? = null
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

    /**
     * The sides a person can say they belong to, in step with COLLAB.fandoms in
     * background.js and COLLABS[].fandoms on /collabs. The KEY is what the board
     * counts people by; a key only this file knows counts nobody.
     *
     * It changes nothing about what is counted. The same picks are posted either
     * way, and the collab's per-act totals stay pooled — everyone votes the whole
     * ballot, so no vote belongs to a side. This counts PEOPLE.
     */
    val FANDOMS: List<Pair<String, String>> = listOf(
        "blink" to "BLINK",
        "bloom" to "BLOOM"
    )

    /** Past this the collab is over and the app stops posting to it. */
    const val COLLAB_ID = "bvp-kca-2026"
    // 2026-11-14T07:59:00Z. Written as an epoch literal because a Kotlin const
    // cannot parse a date, which is exactly how the first one was a YEAR out —
    // it read 2025 and would have stopped the app posting collab votes
    // immediately, with no symptom but an empty column. test_collab_slugs.mjs
    // now compares it against the page's deadline.
    const val COLLAB_UNTIL_MS = 1794643140000L

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
     * Does this option name the nominee we are looking for? Port of kcaTitleIs
     * in background.js, and it must stay a port: the two counting the same
     * ballot differently is the whole reason they are written in parallel.
     *
     * Exact first. The fallback is for the one category the ballot labels by
     * region — Favorite Global Music Star lists BINI as "Asia: BINI" — which
     * against an exact match is a different string, so every BINI pick was
     * dropped and looked exactly like nobody voting. The prefix is not written
     * into the table instead: it depends on the region the ballot is served
     * for, so pinning it would fix one ballot and break the rest.
     *
     * Everything after the first colon is compared WHOLE, so a different act
     * is still refused: "Asia: BTS" does not become BINI.
     */
    private fun titleIs(want: String, title: String?): Boolean {
        val w = norm(want)
        if (w.isEmpty()) return false
        val t = title ?: ""
        if (norm(t) == w) return true
        val i = t.indexOf(':')
        return i > -1 && norm(t.substring(i + 1)) == w
    }

    /**
     * A title that CONTAINS the nominee but does not match it. The ballot has
     * decorated the name in a way titleIs does not handle, and that pick is
     * being dropped without a word — the failure that ran for days as a zero.
     *
     * The contains test is what keeps it from firing on a vote for a rival:
     * "BTS" does not contain "BLACKPINK". Port of kcaNameNearMiss.
     */
    private fun nearMiss(want: String, title: String?): Boolean {
        val w = norm(want)
        val t = norm(title)
        return w.isNotEmpty() && t.isNotEmpty() && t != w && t.contains(w)
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
            var renamed: Pair<String, String>? = null
            for (i in 0 until (picks?.length() ?: 0)) {
                val p = picks!!.optJSONObject(i) ?: continue
                val slug = p.optString("slug", "")
                val title = p.optString("title", "")
                if (slug.isBlank()) continue

                // Checked for every pick INCLUDING the partner's, and before the
                // "is it ours" test below, which rightly calls a BINI pick not ours.
                COLLAB_NOMINEES[slug]?.let { want ->
                    if (titleIs(want, title)) collab[slug] = (collab[slug] ?: 0) + 1
                    else if (nearMiss(want, title) && renamed == null) renamed = want to title
                }

                val mine = KCA_NOMINEES[slug] ?: continue
                if (!titleIs(mine.first, title)) {
                    if (nearMiss(mine.first, title) && renamed == null) renamed = mine.first to title
                    continue
                }
                cats[slug] = (cats[slug] ?: 0) + 1
                matched += 1
                lastLabel = CATEGORIES[slug] ?: slug
            }

            val label = when {
                cats.size > 1 -> "${cats.size} categories"
                lastLabel != null -> lastLabel!!
                else -> "Kids’ Choice"
            }
            KcaVoteResult(cats, collab, label, marks - matched, false, sig, renamed)
        } catch (e: Exception) {
            null
        }
    }
}
