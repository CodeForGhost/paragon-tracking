import CoreBluetooth
import ExpoModulesCore
import Network

struct ScanOptions: Record {
  @Field var manufacturerIds: [Int] = []
  @Field var serviceUuids: [String] = []
  @Field var iBeacon: Bool = false
  @Field var unfiltered: Bool = false
  @Field var lowPower: Bool = false
  @Field var batchIntervalMs: Int = 500
  @Field var restartIntervalMs: Int = 60000
}

struct GatewayOptions: Record {
  @Field var title: String = "Paragon gateway"
  @Field var text: String = ""
  @Field var tickIntervalMs: Int = 5000
}

final class BleError: Exception, @unchecked Sendable {
  let msg: String
  init(_ msg: String) {
    self.msg = msg
    super.init()
  }
  override var reason: String { msg }
}

// MARK: - Scanner

final class BleScanner: NSObject, CBCentralManagerDelegate {
  private struct Pending {
    var name: String?
    var txPower: Int?
    var mfg: [String: String]
    var svc: [String: String]
    var rssis: [Int]
  }

  private var central: CBCentralManager?
  private var options: ScanOptions?
  private var pending: [String: Pending] = [:]
  private var flushTimer: Timer?
  private let emit: (String, [String: Any?]) -> Void
  private(set) var isScanning = false

  init(emit: @escaping (String, [String: Any?]) -> Void) {
    self.emit = emit
    super.init()
  }

  /// Creating the manager triggers the iOS Bluetooth permission prompt, so do it lazily.
  private func ensureCentral() -> CBCentralManager {
    if let c = central { return c }
    let c = CBCentralManager(delegate: self, queue: .main, options: [CBCentralManagerOptionShowPowerAlertKey: false])
    central = c
    return c
  }

  func state() -> String {
    switch CBManager.authorization {
    case .denied, .restricted: return "unauthorized"
    case .notDetermined: return "unknown"
    default: break
    }
    switch ensureCentral().state {
    case .poweredOn: return "on"
    case .poweredOff: return "off"
    case .unauthorized: return "unauthorized"
    case .unsupported: return "unsupported"
    default: return "unknown"
    }
  }

  func start(_ opts: ScanOptions) {
    options = opts
    let c = ensureCentral()
    if c.state == .poweredOn { beginScan() } // otherwise centralManagerDidUpdateState starts it
    flushTimer?.invalidate()
    flushTimer = Timer.scheduledTimer(withTimeInterval: Double(max(opts.batchIntervalMs, 100)) / 1000.0, repeats: true) { [weak self] _ in
      self?.flush()
    }
  }

  func stop() {
    options = nil
    flushTimer?.invalidate()
    flushTimer = nil
    if isScanning { central?.stopScan() }
    isScanning = false
    flush()
    emit("onScanState", ["scanning": false])
  }

  private func beginScan() {
    guard let c = central, options != nil else { return }
    // Manufacturer data can't be filtered by CoreBluetooth; scan everything with duplicates and filter below.
    c.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
    isScanning = true
    emit("onScanState", ["scanning": true])
  }

  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    if central.state == .poweredOn {
      if options != nil { beginScan() }
    } else if isScanning || options != nil {
      isScanning = false
      emit("onScanState", ["scanning": false, "error": central.state == .unauthorized ? "Bluetooth permission denied" : "Bluetooth is off"])
    }
  }

  func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                      advertisementData: [String: Any], rssi RSSI: NSNumber) {
    guard let opts = options else { return }
    let rssi = RSSI.intValue
    if rssi >= 0 || rssi == 127 { return }

    var mfg: [String: String] = [:]
    if let data = advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data, data.count >= 2 {
      let company = Int(data[data.startIndex]) | (Int(data[data.startIndex + 1]) << 8)
      mfg[String(company)] = data.subdata(in: (data.startIndex + 2)..<data.endIndex).base64EncodedString()
    }
    var svc: [String: String] = [:]
    if let sd = advertisementData[CBAdvertisementDataServiceDataKey] as? [CBUUID: Data] {
      for (uuid, d) in sd { svc[uuid.uuidString.uppercased()] = d.base64EncodedString() }
    }

    if !opts.unfiltered {
      let wantedMfg = opts.manufacturerIds.contains { mfg[String($0)] != nil }
      let wantedSvc = opts.serviceUuids.contains { svc[$0.uppercased()] != nil }
      if !wantedMfg && !wantedSvc { return }
    }

    let id = peripheral.identifier.uuidString
    let name = (advertisementData[CBAdvertisementDataLocalNameKey] as? String) ?? peripheral.name
    let tx = (advertisementData[CBAdvertisementDataTxPowerLevelKey] as? NSNumber)?.intValue
    if var p = pending[id] {
      if name != nil { p.name = name }
      if tx != nil { p.txPower = tx }
      if !mfg.isEmpty { p.mfg = mfg }
      if !svc.isEmpty { p.svc = svc }
      p.rssis.append(rssi)
      pending[id] = p
    } else {
      pending[id] = Pending(name: name, txPower: tx, mfg: mfg, svc: svc, rssis: [rssi])
    }
  }

  private func flush() {
    if pending.isEmpty { return }
    let items: [[String: Any?]] = pending.map { id, p in
      ["id": id, "name": p.name, "txPower": p.txPower, "mfg": p.mfg, "svc": p.svc, "rssis": p.rssis]
    }
    pending.removeAll()
    emit("onAdvertisements", ["items": items, "timestamp": Date().timeIntervalSince1970 * 1000])
  }
}

// MARK: - Sockets

final class SocketManager {
  private var conns: [String: NWConnection] = [:]
  private let queue = DispatchQueue(label: "paragon.sockets")
  private let emit: (String, [String: Any?]) -> Void

  init(emit: @escaping (String, [String: Any?]) -> Void) { self.emit = emit }

  func connect(id: String, host: String, port: Int, tls: Bool, timeoutMs: Int, promise: Promise) {
    close(id)
    guard let nwPort = NWEndpoint.Port(rawValue: UInt16(clamping: port)) else {
      promise.reject(BleError("Invalid port \(port)"))
      return
    }
    let tcp = NWProtocolTCPOptions()
    tcp.noDelay = true
    tcp.connectionTimeout = max(1, timeoutMs / 1000)
    let params = tls ? NWParameters(tls: NWProtocolTLS.Options(), tcp: tcp) : NWParameters(tls: nil, tcp: tcp)
    let conn = NWConnection(host: NWEndpoint.Host(host), port: nwPort, using: params)
    var settled = false
    conn.stateUpdateHandler = { [weak self] state in
      guard let self else { return }
      switch state {
      case .ready:
        if !settled { settled = true; promise.resolve(nil) }
        self.receive(id: id, conn: conn)
      case .failed(let err), .waiting(let err):
        if !settled {
          settled = true
          conn.cancel()
          promise.reject(BleError("Connect to \(host):\(port) failed: \(err.localizedDescription)"))
        } else {
          self.closed(id: id, conn: conn, error: err.localizedDescription)
        }
      case .cancelled:
        self.closed(id: id, conn: conn, error: nil)
      default: break
      }
    }
    queue.sync { conns[id] = conn }
    conn.start(queue: queue)
  }

  private func receive(id: String, conn: NWConnection) {
    conn.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) { [weak self] data, _, isComplete, error in
      guard let self else { return }
      if let data, !data.isEmpty {
        self.emit("onSocketData", ["id": id, "data": data.base64EncodedString()])
      }
      if isComplete || error != nil {
        self.closed(id: id, conn: conn, error: error?.localizedDescription)
        conn.cancel()
        return
      }
      self.receive(id: id, conn: conn)
    }
  }

  private func closed(id: String, conn: NWConnection, error: String?) {
    // Called on `queue`.
    guard let current = conns[id], current === conn else { return }
    conns.removeValue(forKey: id)
    emit("onSocketClose", ["id": id, "error": error])
  }

  func write(id: String, base64: String, promise: Promise) {
    guard let conn = queue.sync(execute: { conns[id] }) else {
      promise.reject(BleError("Socket \(id) is not connected"))
      return
    }
    guard let data = Data(base64Encoded: base64) else {
      promise.reject(BleError("Invalid base64"))
      return
    }
    conn.send(content: data, completion: .contentProcessed { error in
      if let error { promise.reject(BleError("Write failed: \(error.localizedDescription)")) } else { promise.resolve(nil) }
    })
  }

  func close(_ id: String) {
    let conn: NWConnection? = queue.sync { conns.removeValue(forKey: id) }
    conn?.cancel()
  }

  func closeAll() {
    let all: [NWConnection] = queue.sync {
      let v = Array(conns.values)
      conns.removeAll()
      return v
    }
    all.forEach { $0.cancel() }
  }
}

// MARK: - Module

public class ParagonNativeModule: Module {
  private lazy var scanner = BleScanner { [weak self] name, body in self?.sendEvent(name, body as [String: Any?]) }
  private lazy var sockets = SocketManager { [weak self] name, body in self?.sendEvent(name, body as [String: Any?]) }
  private var ticker: Timer?

  public func definition() -> ModuleDefinition {
    Name("ParagonNative")

    Events(
      "onAdvertisements", "onScanState", "onGatewayTick", "onGatewayStopRequested",
      "onGatewayError", "onSocketData", "onSocketClose"
    )

    OnDestroy {
      DispatchQueue.main.async { [weak self] in
        self?.ticker?.invalidate()
        self?.scanner.stop()
      }
      self.sockets.closeAll()
    }

    Function("getBluetoothState") { () -> String in
      if Thread.isMainThread { return self.scanner.state() }
      return DispatchQueue.main.sync { self.scanner.state() }
    }

    AsyncFunction("requestEnableBluetooth") { () -> Bool in
      // iOS has no API to turn Bluetooth on; JS sends the user to Settings instead.
      false
    }

    Function("startScan") { (options: ScanOptions) in
      DispatchQueue.main.async { self.scanner.start(options) }
    }

    Function("stopScan") {
      DispatchQueue.main.async { self.scanner.stop() }
    }

    Function("isScanning") { () -> Bool in
      self.scanner.isScanning
    }

    // iOS cannot run a background gateway (no manufacturer-data scanning in background).
    // The ticker runs while the app is in the foreground so the same JS pipeline works.
    Function("startGatewayService") { (options: GatewayOptions) in
      DispatchQueue.main.async {
        self.ticker?.invalidate()
        let interval = Double(min(max(options.tickIntervalMs, 1000), 60000)) / 1000.0
        self.ticker = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
          self?.sendEvent("onGatewayTick", ["timestamp": Date().timeIntervalSince1970 * 1000])
        }
      }
    }

    Function("stopGatewayService") {
      DispatchQueue.main.async {
        self.ticker?.invalidate()
        self.ticker = nil
      }
    }

    Function("isGatewayServiceRunning") { () -> Bool in
      self.ticker != nil
    }

    AsyncFunction("socketConnect") { (id: String, host: String, port: Int, tls: Bool, timeoutMs: Int, promise: Promise) in
      self.sockets.connect(id: id, host: host, port: port, tls: tls, timeoutMs: timeoutMs, promise: promise)
    }

    AsyncFunction("socketWrite") { (id: String, base64: String, promise: Promise) in
      self.sockets.write(id: id, base64: base64, promise: promise)
    }

    Function("socketClose") { (id: String) in
      self.sockets.close(id)
    }
  }
}
