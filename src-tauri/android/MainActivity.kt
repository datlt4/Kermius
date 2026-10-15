package com.koi.kermius

import android.net.wifi.WifiManager
import android.os.Bundle
import android.os.SystemClock
import android.view.View
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
    // Edge-to-edge ignores adjustResize: keep the WebView above the on-screen keyboard ourselves.
    ViewCompat.setOnApplyWindowInsetsListener(findViewById<View>(android.R.id.content)) { v, insets ->
      v.setPadding(0, 0, 0, insets.getInsets(WindowInsetsCompat.Type.ime()).bottom)
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
    multicastLock = (applicationContext.getSystemService(WIFI_SERVICE) as WifiManager)
      .createMulticastLock("kermius-nearby").apply { setReferenceCounted(false) }
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
