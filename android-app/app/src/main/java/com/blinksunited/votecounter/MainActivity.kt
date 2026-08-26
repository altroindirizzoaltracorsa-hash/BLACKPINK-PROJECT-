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
    private lateinit var acctToggle: TextView
    private lateinit var acctScroll: android.widget.ScrollView
    private lateinit var acctList: android.widget.LinearLayout
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

        acctToggle = findViewById(R.id.acctToggle)
        acctScroll = findViewById(R.id.acctScroll)
        acctList = findViewById(R.id.acctList)
        acctToggle.setOnClickListener {
            val show = acctScroll.visibility != android.view.View.VISIBLE
            acctScroll.visibility = if (show) android.view.View.VISIBLE else android.view.View.GONE
            renderAccounts()
        }

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
        renderAccounts()
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
        recordAccount(res.account, res.category, res.total)
        runOnUiThread { updateHeader(); renderAccounts() }

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
            // New MTV voting day — reset the day's counters and the accounts roster.
            prefs.edit()
                .putString("day", today)
                .putInt("count", 0).putInt("bp", 0).putInt("lisa", 0)
                .putString("accounts", "[]")
                .apply()
        }
    }

    // ── Voting-accounts roster ────────────────────────────────────────────────
    // Tracks each account (the vote's user_id, usually the email) used today and which
    // of the 2 fan-voted categories it has covered → 2/2 or 1/2. Reset daily. Stored
    // locally only — never sent to our server (the POST carries just extToken + a count).
    private val FAN_CATS = listOf("cat06", "cat11")

    private fun recordAccount(account: String?, category: String, votes: Int) {
        if (account.isNullOrBlank()) return
        synchronized(prefs) {
            val arr = try { org.json.JSONArray(prefs.getString("accounts", "[]")) } catch (e: Exception) { org.json.JSONArray() }
            var obj: org.json.JSONObject? = null
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                if (o.optString("id") == account) { obj = o; break }
            }
            if (obj == null) {
                obj = org.json.JSONObject().put("id", account).put("cats", org.json.JSONArray()).put("votes", 0)
                arr.put(obj)
            }
            val cats = obj.optJSONArray("cats") ?: org.json.JSONArray()
            var has = false
            for (i in 0 until cats.length()) if (cats.getString(i) == category) { has = true; break }
            if (!has) cats.put(category)
            obj.put("cats", cats)
            obj.put("votes", obj.optInt("votes", 0) + votes)
            obj.put("ts", System.currentTimeMillis())
            prefs.edit().putString("accounts", arr.toString()).apply()
        }
    }

    private fun renderAccounts() {
        if (!::acctList.isInitialized) return
        val arr = try { org.json.JSONArray(prefs.getString("accounts", "[]")) } catch (e: Exception) { org.json.JSONArray() }
        acctToggle.text = if (acctScroll.visibility == android.view.View.VISIBLE)
            "👤 Accounts used today — ${arr.length()} (tap to hide)"
        else
            "👤 Accounts used today — ${arr.length()} (tap to show)"
        if (acctScroll.visibility != android.view.View.VISIBLE) return

        acctList.removeAllViews()
        if (arr.length() == 0) {
            acctList.addView(makeAcctText("No votes logged yet today.", "#9A8F95", 12f))
            return
        }
        // newest activity first
        val items = (0 until arr.length()).map { arr.getJSONObject(it) }
            .sortedByDescending { it.optLong("ts", 0) }
        for (o in items) {
            val id = o.optString("id")
            val cats = o.optJSONArray("cats") ?: org.json.JSONArray()
            val covered = FAN_CATS.count { c -> (0 until cats.length()).any { cats.getString(it) == c } }
            val full = covered >= FAN_CATS.size

            val row = android.widget.LinearLayout(this).apply {
                orientation = android.widget.LinearLayout.HORIZONTAL
                gravity = android.view.Gravity.CENTER_VERTICAL
                setPadding(dp(4), dp(7), dp(4), dp(7))
            }
            val name = makeAcctText(id, "#F5F0F0", 13f).apply {
                maxLines = 1
                ellipsize = android.text.TextUtils.TruncateAt.MIDDLE
                layoutParams = android.widget.LinearLayout.LayoutParams(0, -2, 1f)
            }
            val badge = makeAcctText("$covered/${FAN_CATS.size}", if (full) "#3FD982" else "#F5C542", 13f).apply {
                setTypeface(typeface, android.graphics.Typeface.BOLD)
            }
            row.addView(name)
            row.addView(badge)
            acctList.addView(row)

            val div = android.view.View(this).apply {
                layoutParams = android.widget.LinearLayout.LayoutParams(-1, 1)
                setBackgroundColor(android.graphics.Color.parseColor("#22FF2E77"))
            }
            acctList.addView(div)
        }
    }

    private fun makeAcctText(text: String, color: String, size: Float): TextView =
        TextView(this).apply {
            this.text = text
            setTextColor(android.graphics.Color.parseColor(color))
            textSize = size
            typeface = android.graphics.Typeface.MONOSPACE
        }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

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
