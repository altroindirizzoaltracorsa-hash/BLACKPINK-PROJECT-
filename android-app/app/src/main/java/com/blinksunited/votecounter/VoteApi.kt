package com.blinksunited.votecounter

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Logs counted votes to the same endpoint the extension uses:
 *   POST https://blinksunited.com/api/vma-votes
 *   body: { extToken, votes, breakdown: { BLACKPINK, LISA } }
 * Native HTTP has no CORS restriction, so we post straight from the app.
 */
object VoteApi {
    private const val ENDPOINT = "https://blinksunited.com/api/vma-votes"

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
            }
            val conn = (URL(ENDPOINT).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                setRequestProperty("Content-Type", "application/json")
                doOutput = true
                connectTimeout = 15000
                readTimeout = 15000
            }
            conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            conn.disconnect()
            code in 200..299
        } catch (e: Exception) {
            false
        }
    }
}
