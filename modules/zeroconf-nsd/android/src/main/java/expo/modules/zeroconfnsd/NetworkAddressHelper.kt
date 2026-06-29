package expo.modules.zeroconfnsd

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkAddress
import android.net.NetworkCapabilities
import java.net.Inet4Address

object NetworkAddressHelper {
  private val ipv4Regex = Regex("""^\d{1,3}(?:\.\d{1,3}){3}$""")

  fun isIpv4(host: String): Boolean = ipv4Regex.matches(host.trim())

  private fun subnet24(host: String): String? {
    val trimmed = host.trim()
    if (!isIpv4(trimmed)) return null
    val lastDot = trimmed.lastIndexOf('.')
    if (lastDot <= 0) return null
    return trimmed.substring(0, lastDot)
  }

  fun wifiIpv4Addresses(context: Context): List<String> {
    val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    val out = linkedSetOf<String>()
    for (network in cm.allNetworks ?: emptyArray()) {
      val caps = cm.getNetworkCapabilities(network) ?: continue
      if (!caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) continue
      val lp = cm.getLinkProperties(network) ?: continue
      for (link in lp.linkAddresses) {
        collectIpv4(link, out)
      }
    }
    return out.toList()
  }

  /** Local Wi‑Fi IPv4 on the same /24 as remoteHost (dual‑homed Android). */
  fun localIpv4ForRemote(context: Context, remoteHost: String): String? {
    val subnet = subnet24(remoteHost) ?: return null
    return wifiIpv4Addresses(context).firstOrNull { it.startsWith("$subnet.") }
  }

  private fun collectIpv4(link: LinkAddress, out: MutableSet<String>) {
    val addr = link.address
    if (addr !is Inet4Address || addr.isLoopbackAddress) return
    val host = addr.hostAddress?.trim().orEmpty()
    if (host.isNotEmpty()) out.add(host)
  }
}
