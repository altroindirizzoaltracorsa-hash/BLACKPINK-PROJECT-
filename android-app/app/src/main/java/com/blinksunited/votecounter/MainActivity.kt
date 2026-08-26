package com.blinksunited.votecounter

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.Executors

/**
 * A thin WebView shell around vote.mtv.com that reuses the extension's counting logic:
 * inject counter.js on the MTV site to observe your own successful votes, filter the
 * BLACKPINK/LISA ones (VoteParser), and log them to /voting (VoteApi). Link once by
 * signing in on blinksunited.com/extension-link.html, where link.js hands the token back.
 * It only reads votes you cast — it never votes for you.
 */
class MainActivity : AppCompatActivity(), Bridge.Callback {

    private lateinit var web: WebView
    private lateinit var countView: TextView
    private lateinit var statusView: TextView
    private val io = Executors.newSingleThreadExecutor()
    private val seenTs = ArrayDeque<String>()
    private var counterJs = ""
    private var linkJs = ""

    private val prefs by lazy { getSharedPreferences("bu", Context.MODE_PRIVATE) }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        countView = findViewById(R.id.count)
        statusView = findViewById(R.id.status)
        web = findViewById(R.id.web)

        findViewById<Button>(R.id.voteBtn).setOnClickListener { web.loadUrl("https://vote.mtv.com/") }
        findViewById<Button>(R.id.linkBtn).setOnClickListener { web.loadUrl("https://blinksunited.com/extension-link.html") }
        findViewById<Button>(R.id.boardBtn).setOnClickListener { web.loadUrl("https://blinksunited.com/voting") }

        counterJs = readAsset("counter.js")
        linkJs = readAsset("link.js")

        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            mediaPlaybackRequiresUserGesture = false
            // Drop the "; wv" tag so identity providers don't refuse the embedded WebView.
            userAgentString = userAgentString.replace("; wv", "")
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)
        web.addJavascriptInterface(Bridge(this), "BUAndroid")

        web.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                super.onPageStarted(view, url, favicon)
                val host = try { android.net.Uri.parse(url).host ?: "" } catch (e: Exception) { "" }
                if (host.contains("vote.mtv.com")) view.evaluateJavascript(counterJs, null)
                if (host.contains("blinksunited.com")) view.evaluateJavascript(linkJs, null)
            }
        }
        web.webChromeClient = WebChromeClient()

        updateHeader()
        if (savedInstanceState == null) web.loadUrl("https://vote.mtv.com/")
    }

    // ── Bridge callbacks ─────────────────────────────────────────────────────
    override fun onVote(url: String) {
        val res = VoteParser.parse(url) ?: return
        // Dedupe identical retried submissions by their timestamp param.
        res.timestamp?.let { ts ->
            if (seenTs.contains(ts)) return
            seenTs.addLast(ts)
            if (seenTs.size > 60) seenTs.removeFirst()
        }

        rollDayIfNeeded()
        prefs.edit()
            .putInt("count", prefs.getInt("count", 0) + res.total)
            .putInt("bp", prefs.getInt("bp", 0) + (res.breakdown["BLACKPINK"] ?: 0))
            .putInt("lisa", prefs.getInt("lisa", 0) + (res.breakdown["LISA"] ?: 0))
            .apply()
        runOnUiThread { updateHeader() }

        val token = prefs.getString("token", null)
        if (token != null) {
            io.execute { VoteApi.postVotes(token, res.total, res.breakdown) }
        } else {
            prefs.edit().putInt("pending", prefs.getInt("pending", 0) + res.total).apply()
        }
    }

    override fun onToken(token: String, profile: String?) {
        prefs.edit().apply {
            putString("token", token)
            if (!profile.isNullOrBlank()) putString("profile", profile)
        }.apply()

        val pending = prefs.getInt("pending", 0)
        if (pending > 0) {
            io.execute {
                if (VoteApi.postVotes(token, pending, emptyMap())) {
                    prefs.edit().putInt("pending", 0).apply()
                }
            }
        }
        runOnUiThread { updateHeader() }
    }

    // ── UI ───────────────────────────────────────────────────────────────────
    private fun updateHeader() {
        countView.text = prefs.getInt("count", 0).toString()
        val linked = prefs.getString("token", null) != null
        statusView.text = if (linked) {
            "● Linked" + (prefs.getString("profile", null)?.let { " · $it" } ?: "")
        } else {
            "○ Not linked — tap Link"
        }
    }

    private fun rollDayIfNeeded() {
        val today = etDay()
        if (prefs.getString("day", "") != today) {
            prefs.edit().putString("day", today).putInt("count", 0).putInt("bp", 0).putInt("lisa", 0).apply()
        }
    }

    private fun etDay(): String {
        val fmt = SimpleDateFormat("yyyy-MM-dd", Locale.US)
        fmt.timeZone = TimeZone.getTimeZone("America/New_York")
        return fmt.format(Date())
    }

    private fun readAsset(name: String): String =
        assets.open(name).bufferedReader().use { it.readText() }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else super.onBackPressed()
    }
}
