package expo.modules.zeroconfnsd

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.net.InetAddress
import java.util.concurrent.ConcurrentHashMap

typealias ServiceEventHandler = (action: String, service: Map<String, Any?>) -> Unit

class NsdDiscoveryEngine(private val context: Context) {
  companion object {
    private const val TAG = "ZeroconfNsd"
  }

  private val mainHandler = Handler(Looper.getMainLooper())
  private val nsdManager: NsdManager =
      context.getSystemService(Context.NSD_SERVICE) as NsdManager
  private val discoveryListeners = ConcurrentHashMap<String, NsdManager.DiscoveryListener>()
  private var multicastLock: WifiManager.MulticastLock? = null
  private var eventHandler: ServiceEventHandler? = null

  fun setEventHandler(handler: ServiceEventHandler?) {
    eventHandler = handler
  }

  fun watchAll(types: List<String>, domain: String) {
    for (type in types) {
      watch(type, domain)
    }
  }

  fun unwatchAll(types: List<String>, domain: String) {
    for (type in types) {
      unwatch(type, domain)
    }
  }

  fun watch(type: String, domain: String) {
    mainHandler.post {
      val serviceKey = type + domain
      Log.d(TAG, "watch $serviceKey")

      acquireMulticastLockIfNeeded()

      val listener =
          object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(regType: String) {
              Log.d(TAG, "discovery started: $regType")
            }

            override fun onServiceFound(service: NsdServiceInfo) {
              Log.d(TAG, "service found: ${service.serviceName}")
              nsdManager.resolveService(
                  service,
                  object : NsdManager.ResolveListener {
                    override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                      Log.e(
                          TAG,
                          "resolve failed: ${serviceInfo.serviceName} error=$errorCode")
                      dispatch(serviceKey, "added", serviceInfo)
                    }

                    override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                      Log.d(
                          TAG,
                          "service resolved: ${serviceInfo.serviceName} port=${serviceInfo.port}")
                      dispatch(serviceKey, "added", serviceInfo)
                      dispatch(serviceKey, "resolved", serviceInfo)
                    }
                  })
            }

            override fun onServiceLost(service: NsdServiceInfo) {
              Log.d(TAG, "service lost: ${service.serviceName}")
              dispatch(serviceKey, "removed", service)
            }

            override fun onDiscoveryStopped(serviceType: String) {
              Log.d(TAG, "discovery stopped: $serviceType")
            }

            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
              Log.e(TAG, "start discovery failed: $serviceType error=$errorCode")
            }

            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {
              Log.e(TAG, "stop discovery failed: $serviceType error=$errorCode")
            }
          }

      discoveryListeners[serviceKey]?.let { existing ->
        try {
          nsdManager.stopServiceDiscovery(existing)
        } catch (e: Exception) {
          Log.e(TAG, "error stopping prior discovery for $serviceKey", e)
        }
      }

      discoveryListeners[serviceKey] = listener

      nsdManager.discoverServices(type, NsdManager.PROTOCOL_DNS_SD, listener)
    }
  }

  fun unwatch(type: String, domain: String) {
    mainHandler.post {
      val serviceKey = type + domain
      Log.d(TAG, "unwatch $serviceKey")
      discoveryListeners.remove(serviceKey)?.let { listener ->
        try {
          nsdManager.stopServiceDiscovery(listener)
        } catch (e: Exception) {
          Log.e(TAG, "error stopping discovery for $serviceKey", e)
        }
      }
      releaseMulticastLockIfIdle()
    }
  }

  fun close() {
    mainHandler.post {
      Log.d(TAG, "close")
      for ((key, listener) in discoveryListeners) {
        try {
          nsdManager.stopServiceDiscovery(listener)
        } catch (e: Exception) {
          Log.e(TAG, "error stopping discovery for $key", e)
        }
      }
      discoveryListeners.clear()
      releaseMulticastLock()
    }
  }

  private fun dispatch(serviceKey: String, action: String, service: NsdServiceInfo) {
    if (discoveryListeners[serviceKey] == null) return
    eventHandler?.invoke(action, jsonifyService(service))
  }

  private fun acquireMulticastLockIfNeeded() {
    if (multicastLock != null) return
    @Suppress("WifiManagerLeak")
    val wifi = context.getSystemService(Context.WIFI_SERVICE) as WifiManager
    multicastLock =
        wifi.createMulticastLock("ZeroconfNsdLock").apply {
          setReferenceCounted(false)
          acquire()
        }
  }

  private fun releaseMulticastLockIfIdle() {
    if (discoveryListeners.isEmpty()) {
      releaseMulticastLock()
    }
  }

  private fun releaseMulticastLock() {
    try {
      multicastLock?.release()
    } catch (_: Exception) {
    }
    multicastLock = null
  }

  private fun jsonifyService(service: NsdServiceInfo): Map<String, Any?> {
    val domain = "local."
    val ipv4 = mutableListOf<String>()
    val ipv6 = mutableListOf<String>()
    var hostname = ""

    val host: InetAddress? = service.host
    if (host != null) {
      hostname = host.hostName ?: ""
      val hostAddress = host.hostAddress
      if (hostAddress != null) {
        if (hostAddress.contains(':')) ipv6.add(hostAddress) else ipv4.add(hostAddress)
      }
    }

    val txtRecord = mutableMapOf<String, String>()
    for ((key, value) in service.attributes.orEmpty()) {
      txtRecord[key] = value?.toString(Charsets.UTF_8) ?: ""
    }

    return mapOf(
        "domain" to domain,
        "type" to service.serviceType,
        "name" to service.serviceName,
        "port" to service.port,
        "hostname" to hostname,
        "ipv4Addresses" to ipv4,
        "ipv6Addresses" to ipv6,
        "txtRecord" to txtRecord)
  }
}
