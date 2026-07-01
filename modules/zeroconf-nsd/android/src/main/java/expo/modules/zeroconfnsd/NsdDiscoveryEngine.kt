package expo.modules.zeroconfnsd

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.net.InetAddress
import java.util.concurrent.ConcurrentHashMap

typealias ServiceEventHandler = (action: String, service: Map<String, Any?>) -> Unit

class NsdDiscoveryEngine(private val context: Context) {
  companion object {
    private const val TAG = "ZeroconfNsd"
    private const val RETRY_DELAY_MS = 3000L
    private const val MAX_RETRIES = 3
  }

  private val mainHandler = Handler(Looper.getMainLooper())
  private val nsdManager: NsdManager =
      context.getSystemService(Context.NSD_SERVICE) as NsdManager
  private val discoveryListeners = ConcurrentHashMap<String, NsdManager.DiscoveryListener>()
  // On API 34+ each found service gets a live ServiceInfoCallback, keyed by "type + serviceName".
  private val serviceCallbacks =
      ConcurrentHashMap<String, NsdManager.ServiceInfoCallback>()
  // Per-type FAILURE_MAX_LIMIT retry attempt counters, keyed by "type + domain".
  private val retryAttempts = ConcurrentHashMap<String, Int>()
  private var multicastLock: WifiManager.MulticastLock? = null
  private var eventHandler: ServiceEventHandler? = null

  private val supportsServiceInfoCallback: Boolean
    get() = Build.VERSION.SDK_INT >= 34

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
              retryAttempts.remove(serviceKey)
            }

            override fun onServiceFound(service: NsdServiceInfo) {
              Log.d(TAG, "service found: ${service.serviceName}")
              resolve(type, serviceKey, service)
            }

            override fun onServiceLost(service: NsdServiceInfo) {
              Log.d(TAG, "service lost: ${service.serviceName}")
              unregisterServiceCallback(type + service.serviceName)
              dispatch(serviceKey, "removed", service)
            }

            override fun onDiscoveryStopped(serviceType: String) {
              Log.d(TAG, "discovery stopped: $serviceType")
            }

            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
              Log.e(TAG, "start discovery failed: $serviceType error=$errorCode")
              if (errorCode == NsdManager.FAILURE_MAX_LIMIT) {
                scheduleRetry(type, domain, serviceKey)
              }
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
      retryAttempts.remove(serviceKey)
      discoveryListeners.remove(serviceKey)?.let { listener ->
        try {
          nsdManager.stopServiceDiscovery(listener)
        } catch (e: Exception) {
          Log.e(TAG, "error stopping discovery for $serviceKey", e)
        }
      }
      unregisterServiceCallbacksForType(type)
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
      retryAttempts.clear()
      for (key in serviceCallbacks.keys.toList()) {
        unregisterServiceCallback(key)
      }
      releaseMulticastLock()
    }
  }

  // Resolve a found service. On API 34+ uses a live ServiceInfoCallback (multi-address,
  // auto-updating); on 24-33 falls back to the deprecated single-address resolveService.
  private fun resolve(type: String, serviceKey: String, service: NsdServiceInfo) {
    if (supportsServiceInfoCallback) {
      registerServiceInfoCallback(type, serviceKey, service)
    } else {
      @Suppress("DEPRECATION")
      nsdManager.resolveService(
          service,
          object : NsdManager.ResolveListener {
            override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
              Log.e(TAG, "resolve failed: ${serviceInfo.serviceName} error=$errorCode")
              dispatch(serviceKey, "added", serviceInfo)
            }

            override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
              Log.d(TAG, "service resolved: ${serviceInfo.serviceName} port=${serviceInfo.port}")
              dispatch(serviceKey, "added", serviceInfo)
              dispatch(serviceKey, "resolved", serviceInfo)
            }
          })
    }
  }

  @androidx.annotation.RequiresApi(34)
  private fun registerServiceInfoCallback(type: String, serviceKey: String, service: NsdServiceInfo) {
    // Key on the discovery `type` (stable) not service.serviceType, which Android may
    // normalize differently for a discovered service — must match unwatch/lost teardown.
    val callbackKey = type + service.serviceName
    // Replace any stale registration for the same service before re-registering.
    unregisterServiceCallback(callbackKey)

    val callback =
        object : NsdManager.ServiceInfoCallback {
          private var emittedAdded = false

          override fun onServiceInfoCallbackRegistrationFailed(errorCode: Int) {
            Log.e(TAG, "service info callback registration failed: $callbackKey error=$errorCode")
            serviceCallbacks.remove(callbackKey)
          }

          override fun onServiceUpdated(serviceInfo: NsdServiceInfo) {
            Log.d(TAG, "service updated: ${serviceInfo.serviceName} port=${serviceInfo.port}")
            if (!emittedAdded) {
              emittedAdded = true
              dispatch(serviceKey, "added", serviceInfo)
            }
            dispatch(serviceKey, "resolved", serviceInfo)
          }

          override fun onServiceLost() {
            Log.d(TAG, "service info lost: $callbackKey")
            unregisterServiceCallback(callbackKey)
            dispatch(serviceKey, "removed", service)
          }

          override fun onServiceInfoCallbackUnregistered() {
            Log.d(TAG, "service info callback unregistered: $callbackKey")
          }
        }

    serviceCallbacks[callbackKey] = callback
    try {
      nsdManager.registerServiceInfoCallback(service, { it.run() }, callback)
    } catch (e: Exception) {
      Log.e(TAG, "error registering service info callback for $callbackKey", e)
      serviceCallbacks.remove(callbackKey)
    }
  }

  private fun unregisterServiceCallback(callbackKey: String) {
    serviceCallbacks.remove(callbackKey)?.let { callback ->
      if (supportsServiceInfoCallback) {
        try {
          nsdManager.unregisterServiceInfoCallback(callback)
        } catch (e: Exception) {
          Log.e(TAG, "error unregistering service info callback for $callbackKey", e)
        }
      }
    }
  }

  private fun unregisterServiceCallbacksForType(type: String) {
    for (key in serviceCallbacks.keys.toList()) {
      if (key.startsWith(type)) unregisterServiceCallback(key)
    }
  }

  private fun scheduleRetry(type: String, domain: String, serviceKey: String) {
    val attempt = (retryAttempts[serviceKey] ?: 0) + 1
    if (attempt > MAX_RETRIES) {
      Log.e(TAG, "giving up discovery retry for $serviceKey after $MAX_RETRIES attempts")
      return
    }
    retryAttempts[serviceKey] = attempt
    Log.d(TAG, "scheduling discovery retry $attempt/$MAX_RETRIES for $serviceKey")
    mainHandler.postDelayed(
        {
          // Skip if the watch was torn down while waiting.
          if (retryAttempts.containsKey(serviceKey)) watch(type, domain)
        },
        RETRY_DELAY_MS)
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

    // API 34+ exposes the full A/AAAA list; below 34 NsdServiceInfo carries a single host.
    val addresses: List<InetAddress> =
        if (supportsServiceInfoCallback) {
          service.hostAddresses
        } else {
          @Suppress("DEPRECATION") listOfNotNull(service.host)
        }
    for (addr in addresses) {
      if (hostname.isEmpty()) hostname = addr.hostName ?: ""
      val hostAddress = addr.hostAddress ?: continue
      if (hostAddress.contains(':')) ipv6.add(hostAddress) else ipv4.add(hostAddress)
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
