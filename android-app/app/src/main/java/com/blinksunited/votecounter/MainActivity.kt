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
        findViewById<Button>(R.id.linkBtn).setOnClickListener { startLinkFlow() }
        // Open the board in the real browser: blinksunited.com sign-in uses X/Google
        // OAuth, which is refused inside an embedded WebView. The browser also carries
        // the user's existing site session, so they see their signed-in board directly.
        findViewById<Button>(R.id.boardBtn).setOnClickListener { openExternal("https://blinksunited.com/voting") }

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
        // A deep link (buvotecounter://link?token=…) may have launched us.
        if (!handleLinkIntent(intent) && savedInstanceState == null) {
            web.loadUrl("https://vote.mtv.com/")
        }
    }

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleLinkIntent(intent)
    }

    /** Open the account-link page in the REAL browser (so OAuth works), tagged so it
     *  returns the token to us via the buvotecounter:// deep link. */
    private fun startLinkFlow() {
        if (!openExternal("https://blinksunited.com/extension-link.html?app=android")) {
            // No browser? Fall back to linking inside the WebView (email/password only).
            web.loadUrl("https://blinksunited.com/extension-link.html")
        }
    }

    /** Open a URL in the user's default browser (outside the WebView). Returns false
     *  if no browser could handle it. */
    private fun openExternal(url: String): Boolean {
        return try {
            startActivity(
                android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url))
            )
            true
        } catch (e: Exception) {
            false
        }
    }

    /** If this intent is our token deep link, store the token. Returns true if handled. */
    private fun handleLinkIntent(intent: android.content.Intent?): Boolean {
        val data = intent?.data ?: return false
        if (data.scheme != "buvotecounter") return false
        val token = data.getQueryParameter("token") ?: return false
        onToken(token, data.getQueryParameter("profile"))
        runOnUiThread {
            web.loadUrl("https://vote.mtv.com/")
            android.widget.Toast.makeText(this, "✅ Linked — you can vote now", android.widget.Toast.LENGTH_LONG).show()
        }
        return true
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
            io.execute {
                val ok = VoteApi.postVotes(token, res.total, res.breakdown)
                if (!ok) addPending(res.total) else flushPending(token)
                runOnUiThread { updateHeader() }
            }
        } else {
            addPending(res.total)
            runOnUiThread { updateHeader() }
        }
    }

    override fun onToken(token: String, profile: String?) {
        prefs.edit().apply {
            putString("token", token)
            if (!profile.isNullOrBlank()) putString("profile", profile)
        }.apply()
        io.execute { flushPending(token); runOnUiThread { updateHeader() } }
        runOnUiThread { updateHeader() }
    }

    override fun onResume() {
        super.onResume()
        val token = prefs.getString("token", null)
        if (token != null && prefs.getInt("pending", 0) > 0) {
            io.execute { flushPending(token); runOnUiThread { updateHeader() } }
        }
    }

    private fun addPending(n: Int) = synchronized(prefs) {
        prefs.edit().putInt("pending", prefs.getInt("pending", 0) + n).apply()
    }

    /** Retry votes that failed to post, oldest-first. The BP/LISA split is lost for
     *  these (they count toward the total only), but no vote is dropped. */
    private fun flushPending(token: String) {
        val pending = prefs.getInt("pending", 0)
        if (pending <= 0) return
        if (VoteApi.postVotes(token, pending, emptyMap())) {
            synchronized(prefs) {
                prefs.edit().putInt("pending", (prefs.getInt("pending", 0) - pending).coerceAtLeast(0)).apply()
            }
        }
    }

    // ── UI ───────────────────────────────────────────────────────────────────
    private fun updateHeader() {
        countView.text = prefs.getInt("count", 0).toString()
        val linked = prefs.getString("token", null) != null
        val base = if (linked) {
            "● Linked" + (prefs.getString("profile", null)?.let { " · $it" } ?: "")
        } else {
            "○ Not linked — tap Link"
        }
        val pending = prefs.getInt("pending", 0)
        statusView.text = if (pending > 0) "$base · ⏳ $pending syncing" else base
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
