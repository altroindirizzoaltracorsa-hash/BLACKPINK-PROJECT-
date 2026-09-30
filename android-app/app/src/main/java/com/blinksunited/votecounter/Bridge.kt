package com.blinksunited.votecounter

import android.webkit.JavascriptInterface

/**
 * JS -> native bridge, exposed to the WebView as `BUAndroid`.
 *  - counter.js calls recordVote(url) for each successful MTV vote, and
 *    recordBtVote(json) for each successful BreakTudo one — two awards, two request
 *    shapes (see counter.js).
 *  - link.js (on blinksunited.com) calls setToken(token, profile) after login.
 * The native side validates everything before acting on it.
 */
class Bridge(private val cb: Callback) {
    interface Callback {
        fun onVote(url: String)
        fun onBtVote(json: String)
        fun onToken(token: String, profile: String?)
    }

    @JavascriptInterface
    fun recordVote(url: String?) {
        if (url != null) cb.onVote(url)
    }

    @JavascriptInterface
    fun recordBtVote(json: String?) {
        if (json != null) cb.onBtVote(json)
    }

    @JavascriptInterface
    fun setToken(token: String?, profile: String?) {
        if (!token.isNullOrBlank()) cb.onToken(token, profile)
    }
}
