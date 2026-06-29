package com.balthazargronon.RCTZeroconf;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.wifi.WifiManager;
import android.os.Handler;
import android.os.Looper;
import android.system.Os;
import android.util.Log;

import androidx.annotation.Nullable;

import java.net.Inet4Address;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import android.net.LinkAddress;
import android.net.LinkProperties;

/**
 * Tracks upstream WiFi STA vs phone hotspot AP interfaces for dual DNSSD browse.
 */
public class NetworkDiscoveryManager {
    public static final String MODE_NONE = "none";
    public static final String MODE_HOTSPOT_ONLY = "hotspotOnly";
    public static final String MODE_DUAL_HOMED = "dualHomed";

    public interface Listener {
        void onDiscoveryModeChanged(String mode, int upstreamIfIndex, int hotspotIfIndex);
    }

    private static final String TAG = "NetworkDiscovery";
    private static final List<String> HOTSPOT_IFACE_PREFIXES =
            Arrays.asList("ap", "ap0", "wlan1", "wlan2", "swlan0", "swlan1", "softap", "rndis0");

    private final Context appContext;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Runnable debouncedEvaluate = this::evaluateNetworks;

    @Nullable
    private ConnectivityManager connectivityManager;
    @Nullable
    private WifiManager wifiManager;
    @Nullable
    private ConnectivityManager.NetworkCallback networkCallback;
    @Nullable
    private Listener listener;

    private boolean watching = false;
    private String discoveryMode = MODE_NONE;
    private int lastUpstreamIfIndex = -1;
    private int lastHotspotIfIndex = -1;
    @Nullable
    private Network hotspotNetwork;
    @Nullable
    private Network upstreamWifiNetwork;

    public NetworkDiscoveryManager(Context context) {
        this.appContext = context.getApplicationContext();
    }

    public void setListener(@Nullable Listener listener) {
        this.listener = listener;
    }

    public String getDiscoveryMode() {
        return discoveryMode;
    }

    public void startWatching() {
        if (watching) return;
        watching = true;
        connectivityManager =
                (ConnectivityManager) appContext.getSystemService(Context.CONNECTIVITY_SERVICE);
        wifiManager = (WifiManager) appContext.getSystemService(Context.WIFI_SERVICE);

        NetworkRequest request =
                new NetworkRequest.Builder()
                        .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                        .build();

        networkCallback =
                new ConnectivityManager.NetworkCallback() {
                    @Override
                    public void onAvailable(Network network) {
                        scheduleEvaluate();
                    }

                    @Override
                    public void onLost(Network network) {
                        scheduleEvaluate();
                    }

                    @Override
                    public void onCapabilitiesChanged(
                            Network network, NetworkCapabilities networkCapabilities) {
                        scheduleEvaluate();
                    }
                };

        connectivityManager.registerNetworkCallback(request, networkCallback);
        scheduleEvaluate();
    }

    public void stopWatching() {
        if (!watching) return;
        watching = false;
        mainHandler.removeCallbacks(debouncedEvaluate);
        if (networkCallback != null && connectivityManager != null) {
            connectivityManager.unregisterNetworkCallback(networkCallback);
        }
        networkCallback = null;
        hotspotNetwork = null;
        upstreamWifiNetwork = null;
        lastUpstreamIfIndex = -1;
        lastHotspotIfIndex = -1;
        setDiscoveryMode(MODE_NONE, -1, -1);
    }

    /** Re-apply browse legs for the current network mode without unregistering callbacks. */
    public void refresh() {
        if (!watching) return;
        evaluateNetworks();
    }

    private void scheduleEvaluate() {
        mainHandler.removeCallbacks(debouncedEvaluate);
        mainHandler.postDelayed(debouncedEvaluate, 400);
    }

    private void evaluateNetworks() {
        ConnectivityManager cm = connectivityManager;
        if (cm == null) return;

        upstreamWifiNetwork = null;
        hotspotNetwork = null;
        List<NetworkCaps> wifiNetworks = new ArrayList<>();

        for (Network network : cm.getAllNetworks()) {
            NetworkCapabilities caps = cm.getNetworkCapabilities(network);
            if (caps == null || !caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) continue;

            String ifName = interfaceName(cm, network);
            if (isHotspotInterface(ifName)) {
                hotspotNetwork = network;
                continue;
            }

            wifiNetworks.add(new NetworkCaps(network, caps));

            if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    || caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                    || caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_LOCAL_NETWORK)) {
                if (upstreamWifiNetwork == null
                        || caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) {
                    upstreamWifiNetwork = network;
                }
            }
        }

        boolean hotspotEnabled = isHotspotEnabled();

        if (hotspotEnabled && hotspotNetwork == null) {
            for (NetworkCaps entry : wifiNetworks) {
                if (entry.network.equals(upstreamWifiNetwork)) continue;
                String ifName = interfaceName(cm, entry.network);
                if (!isHotspotInterface(ifName)) continue;
                if (!entry.caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) {
                    hotspotNetwork = entry.network;
                    break;
                }
            }
        }

        if (hotspotEnabled && hotspotNetwork == null && upstreamWifiNetwork != null) {
            for (Network network : cm.getAllNetworks()) {
                if (network.equals(upstreamWifiNetwork)) continue;
                String ifName = interfaceName(cm, network);
                if (!isHotspotInterface(ifName)) continue;
                NetworkCapabilities caps = cm.getNetworkCapabilities(network);
                if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                    hotspotNetwork = network;
                    break;
                }
            }
        }

        String nextMode;
        if (!hotspotEnabled || hotspotNetwork == null) {
            nextMode = MODE_NONE;
        } else if (upstreamWifiNetwork != null) {
            nextMode = MODE_DUAL_HOMED;
        } else {
            nextMode = MODE_HOTSPOT_ONLY;
        }

        int upstreamIfIndex = ifIndexForNetwork(cm, upstreamWifiNetwork);
        int hotspotIfIndex = ifIndexForNetwork(cm, hotspotNetwork);

        Log.i(
                TAG,
                "mode="
                        + nextMode
                        + " upstreamIf="
                        + upstreamIfIndex
                        + " hotspotIf="
                        + hotspotIfIndex
                        + " upstreamCidr="
                        + getUpstreamCidr()
                        + " hotspotCidr="
                        + getHotspotCidr());

        setDiscoveryMode(nextMode, upstreamIfIndex, hotspotIfIndex);
    }

    @Nullable
    public String getHotspotCidr() {
        return ipv4Cidr(connectivityManager, hotspotNetwork);
    }

    @Nullable
    public String getUpstreamCidr() {
        return ipv4Cidr(connectivityManager, upstreamWifiNetwork);
    }

    private static String ipv4Cidr(ConnectivityManager cm, @Nullable Network network) {
        if (cm == null || network == null) return null;
        LinkProperties linkProperties = cm.getLinkProperties(network);
        if (linkProperties == null) return null;

        for (LinkAddress linkAddress : linkProperties.getLinkAddresses()) {
            if (linkAddress.getAddress() instanceof Inet4Address) {
                Inet4Address address = (Inet4Address) linkAddress.getAddress();
                int prefix = linkAddress.getPrefixLength();
                // Samsung dual-homed STA often reports /32; use typical LAN prefix for filter.
                if (prefix >= 31 && address.isSiteLocalAddress()) {
                    prefix = 24;
                }
                return address.getHostAddress() + "/" + prefix;
            }
        }
        return null;
    }

    private void setDiscoveryMode(String mode, int upstreamIfIndex, int hotspotIfIndex) {
        if (mode.equals(discoveryMode)
                && upstreamIfIndex == lastUpstreamIfIndex
                && hotspotIfIndex == lastHotspotIfIndex) {
            return;
        }
        discoveryMode = mode;
        lastUpstreamIfIndex = upstreamIfIndex;
        lastHotspotIfIndex = hotspotIfIndex;
        if (listener != null) {
            listener.onDiscoveryModeChanged(mode, upstreamIfIndex, hotspotIfIndex);
        }
    }

    private boolean isHotspotEnabled() {
        try {
            WifiManager wm = wifiManager;
            if (wm == null) return hotspotNetwork != null;
            return (Boolean) wm.getClass().getMethod("isWifiApEnabled").invoke(wm);
        } catch (Exception ignored) {
            return hotspotNetwork != null;
        }
    }

    private static boolean isHotspotInterface(String ifName) {
        if (ifName == null || ifName.isEmpty()) return false;
        String lower = ifName.toLowerCase();
        for (String prefix : HOTSPOT_IFACE_PREFIXES) {
            if (lower.startsWith(prefix)) return true;
        }
        return false;
    }

    private static String interfaceName(ConnectivityManager cm, Network network) {
        if (cm.getLinkProperties(network) == null) return "";
        String ifName = cm.getLinkProperties(network).getInterfaceName();
        return ifName != null ? ifName : "";
    }

    static int ifIndexForNetwork(ConnectivityManager cm, @Nullable Network network) {
        if (cm == null || network == null) return -1;
        String ifName = interfaceName(cm, network);
        if (ifName.isEmpty()) return -1;
        try {
            return Os.if_nametoindex(ifName);
        } catch (Exception e) {
            Log.w(TAG, "if_nametoindex(" + ifName + ") failed", e);
            return -1;
        }
    }

    private static final class NetworkCaps {
        final Network network;
        final NetworkCapabilities caps;

        NetworkCaps(Network network, NetworkCapabilities caps) {
            this.network = network;
            this.caps = caps;
        }
    }
}
