package com.identyca.paragonnative

import android.util.Base64
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

/**
 * Raw TCP / TLS sockets for the JS MQTT client. TLS uses the platform trust store and verifies the
 * host name (no "accept any certificate").
 */
class SocketManager(private val emit: (String, Map<String, Any?>) -> Unit) {
  private class Conn(val socket: Socket, val input: InputStream, val output: OutputStream)

  private val conns = ConcurrentHashMap<String, Conn>()

  /** Blocking; call from a background thread (Expo AsyncFunction). */
  fun connect(id: String, host: String, port: Int, tls: Boolean, timeoutMs: Int) {
    close(id, notify = false)
    val raw = Socket()
    try {
      raw.tcpNoDelay = true
      raw.keepAlive = true
      raw.connect(InetSocketAddress(host, port), timeoutMs)
      val socket: Socket = if (tls) {
        val factory = SSLSocketFactory.getDefault() as SSLSocketFactory
        (factory.createSocket(raw, host, port, true) as SSLSocket).apply {
          sslParameters = sslParameters.apply { endpointIdentificationAlgorithm = "HTTPS" }
          soTimeout = timeoutMs
          startHandshake()
          soTimeout = 0
        }
      } else raw
      val conn = Conn(socket, socket.getInputStream(), socket.getOutputStream())
      conns[id] = conn
      Thread({ readLoop(id, conn) }, "paragon-socket-$id").apply { isDaemon = true }.start()
    } catch (e: Exception) {
      try { raw.close() } catch (_: Exception) {}
      throw SocketException("Connect to $host:$port failed: ${e.message}")
    }
  }

  private fun readLoop(id: String, conn: Conn) {
    val buf = ByteArray(16 * 1024)
    var error: String? = null
    try {
      while (true) {
        val n = conn.input.read(buf)
        if (n < 0) break
        if (n > 0) emit("onSocketData", mapOf("id" to id, "data" to Base64.encodeToString(buf, 0, n, Base64.NO_WRAP)))
      }
    } catch (e: Exception) {
      error = e.message ?: e.javaClass.simpleName
    }
    // Only report if this connection is still the current one for the id.
    if (conns.remove(id, conn)) {
      try { conn.socket.close() } catch (_: Exception) {}
      emit("onSocketClose", mapOf("id" to id, "error" to error))
    }
  }

  fun write(id: String, base64: String) {
    val conn = conns[id] ?: throw SocketException("Socket $id is not connected")
    val bytes = Base64.decode(base64, Base64.NO_WRAP)
    try {
      synchronized(conn) {
        conn.output.write(bytes)
        conn.output.flush()
      }
    } catch (e: Exception) {
      throw SocketException("Write failed: ${e.message}")
    }
  }

  fun close(id: String, notify: Boolean = false) {
    val conn = conns.remove(id) ?: return
    try { conn.socket.close() } catch (_: Exception) {}
    if (notify) emit("onSocketClose", mapOf("id" to id, "error" to null))
  }

  fun closeAll() {
    for (id in conns.keys.toList()) close(id)
  }
}
