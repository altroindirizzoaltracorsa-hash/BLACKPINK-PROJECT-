package com.blinksunited.votecounter

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Logs counted votes to the same endpoint the extension uses:
 *   POST https://blinksunited.com/api/vma-votes
 *   body: { extToken, votes, breakdown: { BLACKPINK, LISA } }
 *
 * Unlike a browser fetch(), Android's HttpURLConnection does NOT auto-follow
 * redirects on a POST — and blinksunited.com's API can answer 308. So we follow
 * 3xx ourselves, re-POSTing the body to the Location. Native HTTP has no CORS.
 */
object VoteApi {
    private const val ENDPOINT = "https://blinksunited.com/api/vma-votes"

    // Last transport result, for the in-app diagnostic toast: the final HTTP status,
    // 0 before any call, -1 on a transport exception.
    @Volatile var lastStatus: Int = 0
    @Volatile var lastError: String = ""

    fun postVotes(token: String, votes: Int, breakdown: Map<String, Int>): Boolean {
        if (votes <= 0) return false
        return try {
            val body = JSONObject().apply {
                put("extToken", token)
                put("votes", votes)
                if (breakdown.isNotEmpty()) {
                    put("breakdown", JSONObject().apply {
                        breakdown.forEach { (k, v) -> put(k, v) }
                    })
                }
            }.toString()
            val code = postJson(ENDPOINT, body, 3)
            lastStatus = code
            lastError = ""
            code in 200..299
        } catch (e: Exception) {
            lastStatus = -1
            lastError = e.javaClass.simpleName + ": " + (e.message ?: "")
            false
        }
    }

    /** POST JSON, following up to [redirectsLeft] 3xx redirects manually. Returns the
     *  final HTTP status code (or -1 on a transport error). */
    private fun postJson(urlStr: String, body: String, redirectsLeft: Int): Int {
        val conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("Accept", "application/json")
            instanceFollowRedirects = false
            doOutput = true
            connectTimeout = 15000
            readTimeout = 15000
        }
        return try {
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            if (code in 300..399 && redirectsLeft > 0) {
                val loc = conn.getHeaderField("Location")
                if (!loc.isNullOrBlank()) {
                    val next = if (loc.startsWith("http")) loc else URL(URL(urlStr), loc).toString()
                    conn.disconnect()
                    return postJson(next, body, redirectsLeft - 1)
                }
            }
            code
        } finally {
            conn.disconnect()
        }
    }
}
