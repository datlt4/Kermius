package com.koi.kermius

import android.Manifest
import android.content.ClipboardManager
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private var multicastLock: WifiManager.MulticastLock? = null
  private var lastBack = 0L

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Edge-to-edge ignores adjustResize: keep the WebView between the status bar and the
    // keyboard / navigation bar ourselves (a WebView that does not reach the screen edges gets
    // no safe-area insets), painting the gaps in the app's background colour.
    val content = findViewById<View>(android.R.id.content)
    content.setBackgroundColor(Color.parseColor("#14161d"))
    ViewCompat.setOnApplyWindowInsetsListener(content) { v, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      v.setPadding(0, bars.top, 0, maxOf(ime, bars.bottom))
      insets
    }
    // A stray back swipe should not leave the app: ask for a second one within 2 s.
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val now = SystemClock.elapsedRealtime()
        if (now - lastBack < 2000) {
          moveTaskToBack(true)
        } else {
          lastBack = now
          Toast.makeText(this@MainActivity, "Swipe back again to exit", Toast.LENGTH_SHORT).show()
        }
      }
    })
    // Android 10 and older: saving received Nearby Share files to Download/ needs this permission.
    if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.Q &&
      checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE), 1)
    }
    multicastLock = (applicationContext.getSystemService(WIFI_SERVICE) as WifiManager)
      .createMulticastLock("kermius-nearby").apply { setReferenceCounted(false) }
  }

  // Called from the page as window.KermiusAndroid.*
  override fun onWebViewCreate(webView: WebView) {
    webView.addJavascriptInterface(Bridge(), "KermiusAndroid")
  }

  inner class Bridge {
    // Settings → "Keep the screen on".
    @JavascriptInterface
    fun keepAwake(on: Boolean) {
      runOnUiThread {
        if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      }
    }

    // Paste: any clip as text (the clipboard plugin rejects HTML clips, e.g. text copied in a browser).
    @JavascriptInterface
    fun clipboardText(): String {
      val clip = (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager).primaryClip ?: return ""
      if (clip.itemCount == 0) return ""
      return clip.getItemAt(0).coerceToText(this@MainActivity)?.toString() ?: ""
    }
  }

  // Nearby Share discovery: Android drops multicast packets unless an app holds this lock.
  override fun onResume() {
    super.onResume()
    multicastLock?.acquire()
  }

  override fun onPause() {
    multicastLock?.release()
    super.onPause()
  }
}
