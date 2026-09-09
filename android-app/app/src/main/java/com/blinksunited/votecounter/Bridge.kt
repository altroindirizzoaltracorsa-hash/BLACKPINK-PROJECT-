package com.blinksunited.votecounter

import android.webkit.JavascriptInterface

/**
 * JS -> native bridge, exposed to the WebView as `BUAndroid`.
 *  - counter.js (on vote.mtv.com) calls recordVote(url) on each successful vote.
 *  - link.js (on blinksunited.com) calls setToken(token, profile) after login.
 * The native side validates everything before acting on it.
 */
class Bridge(private val cb: Callback) {
    interface Callback {
        fun onVote(url: String)
        fun onToken(token: String, profile: String?)
    }

    @JavascriptInterface
    fun recordVote(url: String?) {
        if (url != null) cb.onVote(url)
    }

    @JavascriptInterface
    fun setToken(token: String?, profile: String?) {
        if (!token.isNullOrBlank()) cb.onToken(token, profile)
    }
}
