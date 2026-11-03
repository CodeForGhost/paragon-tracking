package com.identyca.paragonnative

import android.bluetooth.BluetoothAdapter
import android.content.Context
import android.content.Intent
import android.os.Build
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

class BleException(message: String) : CodedException(message)
class SocketException(message: String) : CodedException(message)
class GatewayException(message: String) : CodedException(message)

class ScanOptions : Record {
  @Field val manufacturerIds: List<Int> = emptyList()
  @Field val serviceUuids: List<String> = emptyList()
  @Field val iBeacon: Boolean = false
  @Field val unfiltered: Boolean = false
  @Field val lowPower: Boolean = false
  @Field val batchIntervalMs: Int = 500
  @Field val restartIntervalMs: Int = 60_000
}

class GatewayOptions : Record {
  @Field val title: String = "Paragon gateway"
  @Field val text: String = "Scanning for tags in the background"
  @Field val tickIntervalMs: Int = 5_000
}

class ParagonNativeModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw GatewayException("React context unavailable")

  private var scanner: BleScanner? = null
  private var sockets: SocketManager? = null

  private fun emit(name: String, body: Map<String, Any?>) {
    try {
      sendEvent(name, body)
    } catch (_: Exception) {
      // JS runtime may be gone during teardown.
    }
  }

  private fun scanner(): BleScanner =
    scanner ?: BleScanner(context.applicationContext) { n, b -> emit(n, b) }.also { scanner = it }

  private fun sockets(): SocketManager =
    sockets ?: SocketManager { n, b -> emit(n, b) }.also { sockets = it }

  override fun definition() = ModuleDefinition {
    Name("ParagonNative")

    Events(
      "onAdvertisements",
      "onScanState",
      "onGatewayTick",
      "onGatewayStopRequested",
      "onGatewayError",
      "onSocketData",
      "onSocketClose"
    )

    OnCreate {
      GatewayService.listener = object : GatewayListener {
        override fun onGatewayTick() = emit("onGatewayTick", mapOf("timestamp" to System.currentTimeMillis()))
        override fun onGatewayStopRequested() = emit("onGatewayStopRequested", emptyMap())
        override fun onGatewayError(message: String) = emit("onGatewayError", mapOf("message" to message))
      }
    }

    OnDestroy {
      scanner?.stop()
      sockets?.closeAll()
      GatewayService.listener = null
    }

    // ---- Bluetooth ----------------------------------------------------------------------------

    Function("getBluetoothState") { scanner().bluetoothState() }

    AsyncFunction("requestEnableBluetooth") {
      val activity = appContext.currentActivity ?: throw BleException("No foreground activity")
      try {
        @Suppress("DEPRECATION")
        activity.startActivity(Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE))
      } catch (e: SecurityException) {
        throw BleException("Bluetooth connect permission not granted")
      }
      true
    }

    Function("startScan") { options: ScanOptions -> scanner().start(options) }

    Function("stopScan") { scanner?.stop(); Unit }

    Function("isScanning") { scanner?.isScanning ?: false }

    // ---- Foreground gateway service -----------------------------------------------------------

    Function("startGatewayService") { options: GatewayOptions ->
      val ctx = context.applicationContext
      val intent = Intent(ctx, GatewayService::class.java)
        .setAction(GatewayService.ACTION_START)
        .putExtra(GatewayService.EXTRA_TITLE, options.title)
        .putExtra(GatewayService.EXTRA_TEXT, options.text)
        .putExtra(GatewayService.EXTRA_TICK_MS, options.tickIntervalMs.toLong())
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(intent)
        else ctx.startService(intent)
      } catch (e: Exception) {
        throw GatewayException("Could not start background service: ${e.message}")
      }
      Unit
    }

    Function("stopGatewayService") {
      if (GatewayService.isRunning) {
        val ctx = context.applicationContext
        ctx.startService(Intent(ctx, GatewayService::class.java).setAction(GatewayService.ACTION_STOP))
      }
      Unit
    }

    Function("isGatewayServiceRunning") { GatewayService.isRunning }

    // ---- Sockets (MQTT transport) -------------------------------------------------------------

    AsyncFunction("socketConnect") { id: String, host: String, port: Int, tls: Boolean, timeoutMs: Int ->
      sockets().connect(id, host, port, tls, timeoutMs)
    }

    AsyncFunction("socketWrite") { id: String, base64: String ->
      sockets().write(id, base64)
    }

    Function("socketClose") { id: String -> sockets?.close(id); Unit }
  }
}
