package com.identyca.paragonnative

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.util.Base64
import android.util.Log

/**
 * BLE advertisement scanner. Uses hardware ScanFilters (manufacturer id / service UUID) so scanning
 * keeps working with the screen off, coalesces results per device and emits them in batches.
 */
class BleScanner(
  private val context: Context,
  private val emit: (String, Map<String, Any?>) -> Unit
) {
  private class Pending(
    var name: String?,
    var txPower: Int?,
    var mfg: Map<String, String>,
    var svc: Map<String, String>,
    val rssis: ArrayList<Int> = ArrayList(4)
  )

  private val handler = Handler(Looper.getMainLooper())
  private val lock = Any()
  private val pending = LinkedHashMap<String, Pending>()
  private var options: ScanOptions? = null
  @Volatile var isScanning = false
    private set

  private val adapter: BluetoothAdapter?
    get() = (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

  private val callback = object : ScanCallback() {
    override fun onScanResult(callbackType: Int, result: ScanResult) = record(result)
    override fun onBatchScanResults(results: MutableList<ScanResult>) = results.forEach { record(it) }
    override fun onScanFailed(errorCode: Int) {
      Log.w(TAG, "scan failed: $errorCode")
      isScanning = false
      emit("onScanState", mapOf("scanning" to false, "error" to "Scan failed (code $errorCode)"))
      // Retry later; code 2 (registration failed) usually clears after a short pause.
      if (options != null) handler.postDelayed(restartRunnable, 5_000)
    }
  }

  private val flushRunnable = object : Runnable {
    override fun run() {
      flush()
      val o = options ?: return
      handler.postDelayed(this, o.batchIntervalMs.toLong().coerceAtLeast(100))
    }
  }

  /** Periodic stop/pause/start: Android silently degrades scans that run for > 30 minutes. */
  private val cycleRunnable = Runnable {
    stopInternal()
    handler.postDelayed(restartRunnable, 2_000)
  }

  private val restartRunnable = Runnable {
    if (options != null) startInternal()
  }

  fun bluetoothState(): String {
    val a = adapter ?: return "unsupported"
    if (!hasScanPermission()) return "unauthorized"
    return if (a.isEnabled) "on" else "off"
  }

  private fun hasScanPermission(): Boolean {
    val perm = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) Manifest.permission.BLUETOOTH_SCAN
    else Manifest.permission.ACCESS_FINE_LOCATION
    return context.checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED
  }

  fun start(opts: ScanOptions) {
    if (!hasScanPermission()) throw BleException("Bluetooth scan permission not granted")
    val a = adapter ?: throw BleException("Bluetooth LE not supported on this device")
    if (!a.isEnabled) throw BleException("Bluetooth is turned off")
    handler.post {
      stopInternal()
      handler.removeCallbacksAndMessages(null)
      options = opts
      startInternal()
      handler.postDelayed(flushRunnable, opts.batchIntervalMs.toLong().coerceAtLeast(100))
    }
  }

  fun stop() {
    handler.post {
      options = null
      handler.removeCallbacksAndMessages(null)
      stopInternal()
      flush()
      emit("onScanState", mapOf("scanning" to false))
    }
  }

  @SuppressLint("MissingPermission")
  private fun startInternal() {
    val o = options ?: return
    val scanner = adapter?.takeIf { it.isEnabled }?.bluetoothLeScanner
    if (scanner == null) {
      emit("onScanState", mapOf("scanning" to false, "error" to "Bluetooth is off"))
      handler.postDelayed(restartRunnable, 5_000)
      return
    }
    val settings = ScanSettings.Builder()
      .setScanMode(if (o.lowPower) ScanSettings.SCAN_MODE_BALANCED else ScanSettings.SCAN_MODE_LOW_LATENCY)
      .setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
      .setReportDelay(0)
      .build()
    try {
      scanner.startScan(buildFilters(o), settings, callback)
      isScanning = true
      emit("onScanState", mapOf("scanning" to true))
      if (o.restartIntervalMs > 0) handler.postDelayed(cycleRunnable, o.restartIntervalMs.toLong())
    } catch (e: SecurityException) {
      isScanning = false
      emit("onScanState", mapOf("scanning" to false, "error" to "Permission denied: ${e.message}"))
    } catch (e: IllegalStateException) {
      isScanning = false
      emit("onScanState", mapOf("scanning" to false, "error" to (e.message ?: "Bluetooth unavailable")))
      handler.postDelayed(restartRunnable, 5_000)
    }
  }

  @SuppressLint("MissingPermission")
  private fun stopInternal() {
    if (!isScanning) return
    isScanning = false
    try {
      adapter?.takeIf { it.isEnabled }?.bluetoothLeScanner?.stopScan(callback)
    } catch (e: Exception) {
      Log.w(TAG, "stopScan: ${e.message}")
    }
  }

  private fun buildFilters(o: ScanOptions): List<ScanFilter>? {
    if (o.unfiltered) return null
    val filters = ArrayList<ScanFilter>()
    for (id in o.manufacturerIds) {
      filters += ScanFilter.Builder().setManufacturerData(id, ByteArray(0)).build()
    }
    if (o.iBeacon) {
      filters += ScanFilter.Builder()
        .setManufacturerData(0x004C, byteArrayOf(0x02, 0x15), byteArrayOf(0xFF.toByte(), 0xFF.toByte()))
        .build()
    }
    for (uuid in o.serviceUuids) {
      filters += ScanFilter.Builder().setServiceUuid(ParcelUuid.fromString(expandUuid(uuid))).build()
    }
    return filters.ifEmpty { null }
  }

  private fun record(result: ScanResult) {
    val rec = result.scanRecord
    val address = result.device?.address ?: return
    val mfg = HashMap<String, String>()
    rec?.manufacturerSpecificData?.let { arr ->
      for (i in 0 until arr.size()) {
        mfg[arr.keyAt(i).toString()] = Base64.encodeToString(arr.valueAt(i), Base64.NO_WRAP)
      }
    }
    val svc = HashMap<String, String>()
    rec?.serviceData?.forEach { (uuid, data) ->
      svc[shortUuid(uuid.uuid.toString())] = Base64.encodeToString(data ?: ByteArray(0), Base64.NO_WRAP)
    }
    val tx = when {
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && result.txPower != ScanResult.TX_POWER_NOT_PRESENT -> result.txPower
      rec != null && rec.txPowerLevel != Int.MIN_VALUE -> rec.txPowerLevel
      else -> null
    }
    synchronized(lock) {
      val p = pending[address]
      if (p == null) {
        pending[address] = Pending(rec?.deviceName, tx, mfg, svc).also { it.rssis.add(result.rssi) }
      } else {
        if (rec?.deviceName != null) p.name = rec.deviceName
        if (tx != null) p.txPower = tx
        if (mfg.isNotEmpty()) p.mfg = mfg
        if (svc.isNotEmpty()) p.svc = svc
        p.rssis.add(result.rssi)
      }
    }
  }

  private fun flush() {
    val items: List<Map<String, Any?>>
    synchronized(lock) {
      if (pending.isEmpty()) return
      items = pending.map { (id, p) ->
        mapOf(
          "id" to id,
          "name" to p.name,
          "txPower" to p.txPower,
          "mfg" to p.mfg,
          "svc" to p.svc,
          "rssis" to p.rssis.toList()
        )
      }
      pending.clear()
    }
    emit("onAdvertisements", mapOf("items" to items, "timestamp" to System.currentTimeMillis()))
  }

  companion object {
    private const val TAG = "ParagonBle"
    private const val BASE_SUFFIX = "-0000-1000-8000-00805f9b34fb"

    fun expandUuid(uuid: String): String =
      if (uuid.length == 4) "0000${uuid.lowercase()}$BASE_SUFFIX" else uuid

    fun shortUuid(uuid: String): String {
      val u = uuid.lowercase()
      return if (u.startsWith("0000") && u.endsWith(BASE_SUFFIX)) u.substring(4, 8).uppercase() else u.uppercase()
    }
  }
}
