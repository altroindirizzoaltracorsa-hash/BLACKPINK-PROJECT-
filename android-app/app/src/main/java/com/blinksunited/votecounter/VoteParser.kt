package com.blinksunited.votecounter

import android.net.Uri

/** A parsed, BLACKPINK/LISA-filtered vote submission. */
data class VoteResult(
    val category: String,
    val total: Int,
    val breakdown: Map<String, Int>,
    val timestamp: String?
)

/**
 * Port of the extension's `parseVoteUrl` + `BP_SLOTS` (background.js). Everything we
 * need is in the vote request's query string:
 *   .../api/prod/vote/s2/vote?...&category=cat11&total=10&A1=9&F1=1&timestamp=...
 * We keep only the slots that belong to BLACKPINK / a member and sum them, split by who.
 */
object VoteParser {
    // Each category maps its nominee slot(s) -> member. Slot keys vary per category.
    //   cat06 (Best Pop)   -> C1 = LISA
    //   cat11 (Best K-Pop) -> A1 = BLACKPINK, F1 = LISA
    private val BP_SLOTS: Map<String, Map<String, String>> = mapOf(
        "cat06" to mapOf("C1" to "LISA"),
        "cat11" to mapOf("A1" to "BLACKPINK", "F1" to "LISA")
    )
    private val RESERVED = setOf("apikey", "timestamp", "action_type", "user_id", "method", "category", "total")
    private val SLOT_RE = Regex("^[A-Za-z]\\d+$")

    fun parse(url: String?): VoteResult? {
        if (url == null) return null
        return try {
            val u = Uri.parse(url)
            val path = u.path ?: return null
            if (!path.contains("/api/prod/vote/s2/vote", ignoreCase = true)) return null
            if ((u.getQueryParameter("action_type") ?: "") != "vote") return null
            val category = u.getQueryParameter("category") ?: return null
            val map = BP_SLOTS[category] ?: return null

            var n = 0
            val breakdown = HashMap<String, Int>()
            for (name in u.queryParameterNames) {
                if (name.lowercase() in RESERVED) continue
                if (!SLOT_RE.matches(name)) continue
                val who = map[name.uppercase()] ?: continue
                val c = u.getQueryParameter(name)?.toIntOrNull() ?: 0
                if (c > 0) {
                    n += c
                    breakdown[who] = (breakdown[who] ?: 0) + c
                }
            }
            if (n <= 0) null
            else VoteResult(category, n, breakdown, u.getQueryParameter("timestamp"))
        } catch (e: Exception) {
            null
        }
    }
}
