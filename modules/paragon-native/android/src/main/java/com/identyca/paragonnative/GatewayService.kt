package com.identyca.paragonnative

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log

interface GatewayListener {
  fun onGatewayTick()
  fun onGatewayStopRequested()
  fun onGatewayError(message: String)
}

/**
 * Foreground service that keeps the process (and therefore the JS runtime, BLE scanning and the
 * MQTT socket) alive while the app is in the background, and drives a periodic tick that JS uses
 * instead of setTimeout/setInterval (which React Native pauses when the activity is backgrounded).
 */
class GatewayService : Service() {
  companion object {
    private const val TAG = "ParagonGateway"
    const val ACTION_START = "com.identyca.paragonnative.START"
    const val ACTION_STOP = "com.identyca.paragonnative.STOP"
    const val ACTION_STOP_FROM_NOTIFICATION = "com.identyca.paragonnative.STOP_NOTIFICATION"
    const val EXTRA_TITLE = "title"
    const val EXTRA_TEXT = "text"
    const val EXTRA_TICK_MS = "tickMs"
    private const val CHANNEL_ID = "paragon_gateway"
    private const val NOTIFICATION_ID = 0x0EB8

    @Volatile var isRunning = false
      private set
    @Volatile var listener: GatewayListener? = null
  }

  private val handler = Handler(Looper.getMainLooper())
  private var tickMs = 5_000L
  private var wakeLock: PowerManager.WakeLock? = null

  private val tick = object : Runnable {
    override fun run() {
      try {
        listener?.onGatewayTick()
      } catch (e: Exception) {
        Log.w(TAG, "tick listener failed", e)
      }
      handler.postDelayed(this, tickMs)
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP_FROM_NOTIFICATION -> {
        listener?.onGatewayStopRequested()
        shutdown()
        return START_NOT_STICKY
      }
      ACTION_STOP -> {
        shutdown()
        return START_NOT_STICKY
      }
    }
    val title = intent?.getStringExtra(EXTRA_TITLE) ?: "Paragon gateway"
    val text = intent?.getStringExtra(EXTRA_TEXT) ?: "Scanning for tags in the background"
    tickMs = (intent?.getLongExtra(EXTRA_TICK_MS, 5_000L) ?: 5_000L).coerceIn(1_000L, 60_000L)

    try {
      startInForeground(buildNotification(title, text))
    } catch (e: Exception) {
      // e.g. ForegroundServiceStartNotAllowedException or missing runtime permission for the type.
      Log.e(TAG, "startForeground failed", e)
      listener?.onGatewayError("Could not start background service: ${e.message}")
      shutdown()
      return START_NOT_STICKY
    }
    if (!isRunning) {
      isRunning = true
      acquireWakeLock()
      handler.removeCallbacks(tick)
      handler.postDelayed(tick, tickMs)
    }
    // Not sticky: if the system kills us the JS side is gone too, so a restart would be an empty shell.
    return START_NOT_STICKY
  }

  private fun startInForeground(n: Notification) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
      val fine = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
      if (fine) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
      startForeground(NOTIFICATION_ID, n, type)
    } else {
      startForeground(NOTIFICATION_ID, n)
    }
  }

  private fun buildNotification(title: String, text: String): Notification {
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(CHANNEL_ID) == null) {
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "Background tracking", NotificationManager.IMPORTANCE_LOW).apply {
          description = "Shown while the phone is acting as a tag gateway"
          setShowBadge(false)
        }
      )
    }
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    val stopIntent = PendingIntent.getService(
      this, 1, Intent(this, GatewayService::class.java).setAction(ACTION_STOP_FROM_NOTIFICATION), flags
    )
    val launch = packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(this, 0, it, flags)
    }
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL_ID)
    else @Suppress("DEPRECATION") Notification.Builder(this)
    return builder
      .setContentTitle(title)
      .setContentText(text)
      .setSmallIcon(applicationInfo.icon)
      .setOngoing(true)
      .setContentIntent(launch)
      .addAction(Notification.Action.Builder(null as android.graphics.drawable.Icon?, "Stop", stopIntent).build())
      .build()
  }

  private fun acquireWakeLock() {
    val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "paragon:gateway").apply {
      setReferenceCounted(false)
      acquire()
    }
  }

  private fun shutdown() {
    isRunning = false
    handler.removeCallbacks(tick)
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE)
    else @Suppress("DEPRECATION") stopForeground(true)
    stopSelf()
  }

  override fun onDestroy() {
    isRunning = false
    handler.removeCallbacks(tick)
    wakeLock?.let { if (it.isHeld) it.release() }
    super.onDestroy()
  }
}
