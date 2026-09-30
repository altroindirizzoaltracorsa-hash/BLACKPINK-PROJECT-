package com.blinksunited.votecounter

import org.json.JSONArray
import org.json.JSONObject

/** A parsed, BLACKPINK/member/BLINKs-filtered BreakTudo submission. */
data class BtVoteResult(
    /** BreakTudo's own /vote/<slug>/ category slug, canonicalised. Null if unknown. */
    val category: String?,
    /** Human label for the category, for the in-app roster. */
    val label: String,
    /** How many votes of ours this submission carried. */
    val total: Int,
    /** Marks in the batch that were NOT ours (a different artist, another category). */
    val skipped: Int,
    /** Stable key for this submission, so a retry is not counted twice. */
    val dedupeKey: String
)

/**
 * Port of the extension's BreakTudo counting (background.js: BT_CATS, BT_CANDIDATES,
 * processBtVote). The app sees the vote in-page rather than through webRequest, so
 * counter.js hands over the body and the page's slug together and this only has to
 * decide what the batch is worth.
 *
 * Kept deliberately parallel to the extension: the two must agree, or the same votes
 * count differently depending on which one the blink happens to be using.
 */
object BtVoteParser {

    /** Candidate ids (base64, as BreakTudo sends them) known to be ours. */
    private val BT_CANDIDATES: Map<String, String> = mapOf(
        "NjAwNkJUVzI1MTk2MjU4" to "BLACKPINK"
    )

    /**
     * The ONLY categories we count — the /vote/<slug>/ pages BLACKPINK, the members
     * or BLINKs are nominated on. A vote counts iff its candidate id is a known one
     * OR it was cast on one of these pages. Anything else is somebody else's vote.
     */
    private val BT_CATS: Map<String, String> = mapOf(
        "grupo-feminino-internacional" to "Int. Female Group",
        "artista-feminina-internacional" to "Int. Female Artist",
        "artista-asiatico" to "Asian Artist",
        "colaboracao-internacional-do-ano" to "Int. Collaboration",
        "hit-internacional-do-ano" to "Int. Hit of the Year",
        "clipe-internacional-do-ano" to "Int. Music Video",
        "fandom-internacional-do-ano" to "Int. Fandom",
        "serie-internacional" to "Int. Series"
    )

    /**
     * BreakTudo serves some categories under more than one slug spelling. The board
     * keys each blink's per-category breakdown by this slug, so posting an alias
     * would split one category into two chips — the bug already fixed site-side in
     * BT_CAT_ALIASES. Fold here too, so the app never creates a new one.
     */
    private val BT_CAT_ALIASES: Map<String, String> = mapOf(
        "videoclipe-internacional-do-ano" to "clipe-internacional-do-ano",
        "videoclipe-internacional" to "clipe-internacional-do-ano",
        "clipe-internacional" to "clipe-internacional-do-ano",
        "serie-internacional-do-ano" to "serie-internacional"
    )

    /** Every category we count, canonical slug -> label. Used for the coverage roster. */
    val CATEGORIES: Map<String, String> get() = BT_CATS

    private fun canon(slug: String?): String? =
        slug?.lowercase()?.let { BT_CAT_ALIASES[it] ?: it }

    /**
     * @param json what counter.js posted: { slug, votes, valid, action }, where
     *   `votes` is BreakTudo's own votes array, still encoded as a string.
     */
    fun parse(json: String?): BtVoteResult? {
        if (json == null) return null
        return try {
            val o = JSONObject(json)
            val slug = canon(o.optString("slug", "").takeIf { it.isNotBlank() })
            val label = slug?.let { BT_CATS[it] } ?: "BreakTudo"
            val catIsOurs = slug != null && BT_CATS.containsKey(slug)

            val votes = readVotes(o.opt("votes")) ?: return null
            if (votes.length() == 0) return null

            val posIsIndex = posIsIndex(votes)

            var n = 0
            var skipped = 0
            val sig = StringBuilder()
            for (i in 0 until votes.length()) {
                val v = votes.optJSONObject(i) ?: continue
                val id = v.opt("id")?.toString() ?: continue
                val posRaw = v.opt("pos")?.toString() ?: ""
                sig.append(id).append(':').append(posRaw).append(',')

                val known = BT_CANDIDATES[id]
                if (known == null && !catIsOurs) { skipped += 1; continue }

                val c = if (posIsIndex) 1 else {
                    val p = posRaw.toIntOrNull() ?: 1
                    // Per-candidate sanity bound; a BreakTudo sequence is 5.
                    if (p <= 0) 1 else minOf(p, 50)
                }
                n += c
            }
            if (n <= 0) {
                return if (skipped > 0)
                    BtVoteResult(slug, label, 0, skipped, "")
                else null
            }
            n = minOf(n, 500) // batch sanity bound

            // Mirrors the extension's key. Several distinct marks can ride the SAME
            // Turnstile token — BreakTudo's rules are 5 votes = 5 votes, no cap — so
            // keying on the token alone would fold real votes together and undercount.
            // Token AND the exact marks: a true retry folds, different marks do not.
            val valid = o.optString("valid", "")
            val head = if (valid.isNotBlank()) "t:" + valid.take(48) else "s:" + (slug ?: "?")
            BtVoteResult(slug, label, n, skipped, "$head|$sig")
        } catch (e: Exception) {
            null
        }
    }

    /** `votes` arrives as a JSON string (form-encoded body) or as an array (JSON body). */
    private fun readVotes(raw: Any?): JSONArray? = when (raw) {
        null -> null
        is JSONArray -> raw
        is String -> try { JSONArray(raw) } catch (e: Exception) { null }
        else -> null
    }

    /**
     * `pos` is ambiguous across BreakTudo's own payload shapes, and reading it wrong
     * silently mis-scales every vote:
     *   [{id:BP,pos:1},{id:BP,pos:2}…{id:BP,pos:5}]  → pos is the mark's INDEX → 5 votes
     *   [{id:BP,pos:5}]                              → pos is a COUNT          → 5 votes
     * Summing blindly turns the first into 15; counting entries blindly turns the
     * second into 1. A run of distinct positions 1..N on ONE nominee is an index
     * sequence. Different ids mean different nominees — a fan voting for both
     * BLACKPINK and LISA in Int. Music Video — and each entry's pos is that
     * nominee's own count, so that is never an index sequence.
     */
    private fun posIsIndex(votes: JSONArray): Boolean {
        if (votes.length() < 2) return false
        val ids = HashSet<String>()
        for (i in 0 until votes.length()) {
            ids.add(votes.optJSONObject(i)?.opt("id")?.toString() ?: return false)
        }
        if (ids.size != 1) return false
        val seen = HashSet<Int>()
        for (i in 0 until votes.length()) {
            val p = votes.optJSONObject(i)?.opt("pos")?.toString()?.toIntOrNull() ?: return false
            if (p < 1 || p > votes.length() || !seen.add(p)) return false
        }
        return seen.size == votes.length()
    }
}
