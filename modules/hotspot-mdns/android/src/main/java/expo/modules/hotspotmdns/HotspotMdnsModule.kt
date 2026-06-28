package expo.modules.hotspotmdns

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiManager
import android.os.Handler
import android.os.Looper
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import javax.jmdns.JmDNS
import javax.jmdns.ServiceEvent
import javax.jmdns.ServiceListener

class HotspotMdnsModule : Module() {
  private val mainHandler = Handler(Looper.getMainLooper())
  private val jmdnsExecutor = Executors.newSingleThreadExecutor()
  private var connectivityManager: ConnectivityManager? = null
  private var wifiManager: WifiManager? = null
  private var multicastLock: WifiManager.MulticastLock? = null
  private var jmdns: JmDNS? = null
  private val jmdnsListeners = mutableListOf<Pair<String, ServiceListener>>()
  private var hotspotNetwork: Network? = null
  private var upstreamWifiNetwork: Network? = null
  private var isWatching = false
  private var discoveryMode: String = MODE_NONE
  private var networkCallback: ConnectivityManager.NetworkCallback? = null
  private var hotspotScanning = false
  private var hotspotBrowseNetworkHandle: Long = -1L
  private var hotspotSubnetPrefix: String? = null
  private val knownServices = ConcurrentHashMap<String, MutableMap<String, Any?>>()
  private val browseUpdateRunnable = Runnable { applyBrowseState() }
  private var pendingMode: String = MODE_NONE
  private var pendingHotspotNetwork: Network? = null

  override fun definition() = ModuleDefinition {
    Name("HotspotMdns")

    Events(
      "onDualHomedChanged",
      "onDiscoveryModeChanged",
      "onServiceFound",
      "onServiceResolved",
      "onServiceRemoved",
      "onHotspotPurged",
    )

    Function("startWatching") {
      startWatching()
    }

    Function("stopWatching") {
      stopWatching()
    }

    Function("restartScan") {
      restartScan()
    }

    Function("isDualHomed") {
      discoveryMode == MODE_DUAL_HOMED
    }

    Function("getDiscoveryMode") {
      discoveryMode
    }
  }

  private fun appContext(): Context = requireNotNull(appContext.reactContext)

  private fun startWatching() {
    if (isWatching) return
    isWatching = true
    val context = appContext()
    connectivityManager =
      context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    wifiManager = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager

    val request =
      NetworkRequest.Builder()
        .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
        .build()

    networkCallback =
      object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
          evaluateNetworks()
        }

        override fun onLost(network: Network) {
          evaluateNetworks()
        }

        override fun onCapabilitiesChanged(
          network: Network,
          networkCapabilities: NetworkCapabilities,
        ) {
          evaluateNetworks()
        }
      }

    connectivityManager?.registerNetworkCallback(request, networkCallback!!)
    evaluateNetworks()
  }

  private fun stopWatching() {
    if (!isWatching) return
    isWatching = false
    stopHotspotBrowse()
    networkCallback?.let { connectivityManager?.unregisterNetworkCallback(it) }
    networkCallback = null
    setDiscoveryMode(MODE_NONE)
    purgeSegmentServices("hotspot")
  }

  private fun restartScan() {
    if (discoveryMode == MODE_NONE) return
    hotspotBrowseNetworkHandle = -1L
    stopHotspotBrowse()
    mainHandler.postDelayed({ startBrowsesForMode(discoveryMode) }, 500)
  }

  private fun evaluateNetworks() {
    val cm = connectivityManager ?: return
    upstreamWifiNetwork = null
    hotspotNetwork = null

    val wifiNetworks = mutableListOf<Pair<Network, NetworkCapabilities>>()

    for (network in cm.allNetworks) {
      val caps = cm.getNetworkCapabilities(network) ?: continue
      if (!caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) continue

      val linkProps = cm.getLinkProperties(network)
      val ifName = linkProps?.interfaceName?.lowercase() ?: ""

      logWifiNetwork(ifName, caps)

      if (isHotspotInterface(ifName)) {
        hotspotNetwork = network
        continue
      }

      wifiNetworks.add(network to caps)

      if (
        caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) ||
          caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) ||
          caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_LOCAL_NETWORK)
      ) {
        if (
          upstreamWifiNetwork == null ||
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
        ) {
          upstreamWifiNetwork = network
        }
      }
    }

    val hotspotEnabled = isHotspotEnabled()

    if (hotspotEnabled && hotspotNetwork == null) {
      for ((network, caps) in wifiNetworks) {
        if (network == upstreamWifiNetwork) continue
        val ifName =
          connectivityManager?.getLinkProperties(network)?.interfaceName?.lowercase() ?: ""
        if (!isHotspotInterface(ifName)) continue
        if (!caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) {
          hotspotNetwork = network
          break
        }
      }
    }

    if (hotspotEnabled && hotspotNetwork == null && upstreamWifiNetwork != null) {
      for (network in cm.allNetworks) {
        if (network == upstreamWifiNetwork) continue
        val linkProps = cm.getLinkProperties(network) ?: continue
        val ifName = linkProps.interfaceName?.lowercase() ?: ""
        if (!isHotspotInterface(ifName)) continue
        val caps = cm.getNetworkCapabilities(network) ?: continue
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
          hotspotNetwork = network
          break
        }
      }
    }

    val nextMode =
      when {
        !hotspotEnabled || hotspotNetwork == null -> MODE_NONE
        upstreamWifiNetwork != null -> MODE_DUAL_HOMED
        else -> MODE_HOTSPOT_ONLY
      }

    Log.i(
      TAG,
      "mode=$nextMode ap=$hotspotEnabled upstream=${upstreamWifiNetwork != null} hotspotNet=${hotspotNetwork != null} if=${hotspotInterfaceName(hotspotNetwork)}",
    )

    if (nextMode != discoveryMode) {
      val wasMode = discoveryMode
      setDiscoveryMode(nextMode)

      when {
        wasMode != MODE_NONE && nextMode == MODE_NONE -> {
          stopHotspotBrowse()
          purgeSegmentServices("hotspot")
        }
      }
    }

    pendingMode = nextMode
    pendingHotspotNetwork = hotspotNetwork
    mainHandler.removeCallbacks(browseUpdateRunnable)
    mainHandler.postDelayed(browseUpdateRunnable, 400)
  }

  private fun applyBrowseState() {
    when {
      pendingMode == MODE_NONE -> {
        stopHotspotBrowse()
      }
      pendingMode == MODE_HOTSPOT_ONLY || pendingMode == MODE_DUAL_HOMED -> {
        val handle = pendingHotspotNetwork?.networkHandle ?: -1L
        if (hotspotBrowseNetworkHandle != handle || !hotspotScanning) {
          if (hotspotBrowseNetworkHandle != handle) {
            stopHotspotBrowse()
            mainHandler.postDelayed({ startHotspotBrowse(pendingHotspotNetwork) }, 100)
          } else {
            startHotspotBrowse(pendingHotspotNetwork)
          }
        }
      }
    }
  }

  private fun hotspotInterfaceName(network: Network?): String {
    if (network == null) return "?"
    return connectivityManager?.getLinkProperties(network)?.interfaceName ?: "?"
  }

  private fun setDiscoveryMode(mode: String) {
    if (mode == discoveryMode) return
    val wasDualHomed = discoveryMode == MODE_DUAL_HOMED
    discoveryMode = mode
    val isDualHomed = mode == MODE_DUAL_HOMED
    if (wasDualHomed != isDualHomed) {
      sendEvent("onDualHomedChanged", mapOf("dualHomed" to isDualHomed))
    }
    sendEvent("onDiscoveryModeChanged", mapOf("mode" to mode))
  }

  private fun startBrowsesForMode(mode: String) {
    if (mode == MODE_HOTSPOT_ONLY || mode == MODE_DUAL_HOMED) {
      startHotspotBrowse(hotspotNetwork)
    }
  }

  private fun startHotspotBrowse(network: Network?) {
    if (network == null) return
    val nif = hotspotNetworkInterface(network)
    val ifName = nif?.name?.lowercase() ?: ""
    if (!isHotspotInterface(ifName)) {
      Log.w(TAG, "startHotspotBrowse: skip non-hotspot iface=$ifName")
      return
    }
    val networkHandle = network.networkHandle
    if (hotspotBrowseNetworkHandle == networkHandle && hotspotScanning) return
    hotspotBrowseNetworkHandle = networkHandle
    val bindAddr = hotspotBindAddress(network) as? Inet4Address
    if (bindAddr == null && nif == null) {
      Log.w(TAG, "startHotspotBrowse: no hotspot interface address")
      hotspotBrowseNetworkHandle = -1L
      return
    }
    updateHotspotSubnetPrefix(bindAddr ?: nif?.inetAddresses?.toList()?.firstOrNull { it is Inet4Address && !it.isLoopbackAddress } as? Inet4Address)

    acquireMulticastLock()
    jmdnsExecutor.execute {
      try {
        stopJmdnsQuietly()
        val addr =
          (nif?.inetAddresses?.toList()?.firstOrNull {
            it is Inet4Address && !it.isLoopbackAddress
          } ?: bindAddr) as? Inet4Address
            ?: return@execute
        Log.i(
          TAG,
          "jmdns starting on ${addr.hostAddress} iface=${nif?.name ?: "?"} network=$network prefix=$hotspotSubnetPrefix",
        )
        val instance = JmDNS.create(addr, "HotspotMdns-${nif?.name ?: addr.hostAddress}")
        jmdns = instance
        for (serviceType in HOTSPOT_JMDNS_TYPES) {
          val listener = createJmdnsListener(serviceType)
          instance.addServiceListener(serviceType, listener)
          jmdnsListeners.add(serviceType to listener)
        }
        mainHandler.post {
          hotspotScanning = true
          hotspotBrowseNetworkHandle = networkHandle
        }
      } catch (e: Exception) {
        Log.w(TAG, "jmdns start failed", e)
        mainHandler.post { hotspotBrowseNetworkHandle = -1L }
        releaseMulticastLock()
      }
    }
  }

  private fun createJmdnsListener(serviceType: String): ServiceListener {
    val nativeType = jmdnsTypeToNative(serviceType)
    return object : ServiceListener {
      override fun serviceAdded(event: ServiceEvent) {
        Log.i(TAG, "jmdns serviceAdded ${event.name} type=$serviceType")
        sendEvent(
          "onServiceFound",
          mapOf(
            "segment" to "hotspot",
            "name" to event.name,
            "type" to nativeType,
          ),
        )
        jmdns?.requestServiceInfo(event.type, event.name, true)
      }

      override fun serviceRemoved(event: ServiceEvent) {
        knownServices.remove(serviceKey("hotspot", event.name, nativeType))
        sendEvent(
          "onServiceRemoved",
          mapOf(
            "segment" to "hotspot",
            "name" to event.name,
            "type" to nativeType,
          ),
        )
      }

      override fun serviceResolved(event: ServiceEvent) {
        val info = event.info ?: return
        val host = pickHotspotHost(info) ?: run {
          Log.i(TAG, "jmdns skip resolved ${info.name} (not on hotspot subnet prefix=$hotspotSubnetPrefix)")
          return
        }
        if (host.isEmpty()) return

        val txt = mutableMapOf<String, String>()
        info.propertyNames?.asSequence()?.forEach { key ->
          info.getPropertyString(key)?.let { txt[key] = it }
        }

        val payload =
          mutableMapOf<String, Any?>(
            "segment" to "hotspot",
            "name" to info.name,
            "type" to nativeType,
            "host" to host,
            "port" to info.port,
            "txtRecord" to txt,
            "ipv4Addresses" to listOf(host),
            "ipv6Addresses" to emptyList<String>(),
          )
        knownServices[serviceKey("hotspot", info.name, nativeType)] = payload
        sendEvent("onServiceResolved", payload)
        Log.i(TAG, "jmdns resolved ${info.name} $host:${info.port}")
      }
    }
  }

  private fun stopHotspotBrowse() {
    jmdnsExecutor.execute {
      stopJmdnsQuietly()
      mainHandler.post {
        hotspotScanning = false
        hotspotBrowseNetworkHandle = -1L
      }
    }
  }

  private fun stopJmdnsQuietly() {
    try {
      val instance = jmdns
      if (instance != null) {
        for ((type, listener) in jmdnsListeners) {
          try {
            instance.removeServiceListener(type, listener)
          } catch (_: Exception) {
          }
        }
      }
    } catch (_: Exception) {
    }
    jmdnsListeners.clear()
    try {
      jmdns?.close()
    } catch (_: Exception) {
    }
    jmdns = null
    releaseMulticastLock()
  }

  private fun updateHotspotSubnetPrefix(addr: Inet4Address?) {
    if (addr == null) return
    val parts = addr.hostAddress?.split(".") ?: return
    if (parts.size == 4) hotspotSubnetPrefix = "${parts[0]}.${parts[1]}.${parts[2]}."
  }

  private fun pickHotspotHost(info: javax.jmdns.ServiceInfo): String? {
    val candidates = linkedSetOf<String>()
    info.hostAddresses?.forEach { candidates.add(it) }
    info.inet4Addresses?.forEach { candidates.add(it.hostAddress) }
    val prefix = hotspotSubnetPrefix
    if (prefix != null) {
      return candidates.firstOrNull { !it.contains(":") && it.startsWith(prefix) }
    }
    return candidates.firstOrNull { !it.contains(":") } ?: candidates.firstOrNull()
  }

  private fun hotspotBindAddress(network: Network): InetAddress? {
    val linkProps = connectivityManager?.getLinkProperties(network) ?: return null
    return linkProps.linkAddresses
      .map { it.address }
      .firstOrNull { it is Inet4Address && !it.isLoopbackAddress }
  }

  private fun hotspotNetworkInterface(network: Network): NetworkInterface? {
    val ifName = connectivityManager?.getLinkProperties(network)?.interfaceName ?: return null
    return try {
      NetworkInterface.getByName(ifName)
    } catch (e: Exception) {
      Log.w(TAG, "NetworkInterface.getByName($ifName) failed", e)
      null
    }
  }

  private fun acquireMulticastLock() {
    val wm = wifiManager ?: return
    if (multicastLock == null) {
      multicastLock =
        wm.createMulticastLock("HotspotMdns").apply {
          setReferenceCounted(true)
        }
    }
    try {
      multicastLock?.acquire()
    } catch (e: Exception) {
      Log.w(TAG, "multicast lock acquire failed", e)
    }
  }

  private fun releaseMulticastLock() {
    try {
      multicastLock?.release()
    } catch (_: Exception) {
    }
  }

  private fun logWifiNetwork(ifName: String, caps: NetworkCapabilities) {
    Log.i(
      TAG,
      "wifi if=$ifName validated=${caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)} local=${caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_LOCAL_NETWORK)}",
    )
  }

  private fun isHotspotInterface(ifName: String): Boolean {
    if (ifName.isEmpty()) return false
    return HOTSPOT_IFACE_PREFIXES.any { ifName.startsWith(it) }
  }

  private fun isHotspotEnabled(): Boolean {
    return try {
      val wm = wifiManager ?: return hotspotNetwork != null
      val method = wm.javaClass.getMethod("isWifiApEnabled")
      method.invoke(wm) as Boolean
    } catch (_: Exception) {
      hotspotNetwork != null
    }
  }

  private fun purgeSegmentServices(segment: String) {
    knownServices.keys.removeIf { it.startsWith("$segment|") }
    if (segment == "hotspot") {
      sendEvent("onHotspotPurged", emptyMap<String, Any?>())
    }
  }

  private fun jmdnsTypeToNative(jmdnsType: String): String {
    val trimmed = jmdnsType.removeSuffix(".local.").removeSuffix(".local").trim()
    return normalizeServiceType(trimmed)
  }

  private fun normalizeServiceType(type: String): String {
    val trimmed = type.trim().trimEnd('.')
    return if (trimmed.endsWith(".")) trimmed else "$trimmed."
  }

  private fun serviceKey(segment: String, name: String, type: String): String = "$segment|$name|$type"

  companion object {
    private const val TAG = "HotspotMdns"
    private const val MODE_NONE = "none"
    private const val MODE_HOTSPOT_ONLY = "hotspotOnly"
    private const val MODE_DUAL_HOMED = "dualHomed"

    private val HOTSPOT_JMDNS_TYPES =
      listOf("_mqtt-ws._tcp.local.", "_mqtt-wss._tcp.local.")

    private val HOTSPOT_IFACE_PREFIXES =
      listOf("ap", "ap0", "wlan1", "wlan2", "swlan0", "swlan1", "softap", "rndis0")
  }
}
