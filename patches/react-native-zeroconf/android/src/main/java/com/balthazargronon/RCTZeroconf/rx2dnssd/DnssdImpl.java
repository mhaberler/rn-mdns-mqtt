package com.balthazargronon.RCTZeroconf.rx2dnssd;

import android.annotation.SuppressLint;
import android.content.Context;
import android.net.wifi.WifiManager;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import com.balthazargronon.RCTZeroconf.NetworkDiscoveryManager;
import com.balthazargronon.RCTZeroconf.Ipv4Subnet;
import com.balthazargronon.RCTZeroconf.Zeroconf;
import com.balthazargronon.RCTZeroconf.ZeroconfModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.ReadableMapKeySetIterator;
import com.facebook.react.bridge.WritableArray;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.bridge.WritableNativeArray;
import com.facebook.react.bridge.WritableNativeMap;
import com.github.druk.dnssd.DNSSD;
import com.github.druk.dnssd.DNSSDEmbedded;
import com.github.druk.rx2dnssd.BonjourService;
import com.github.druk.rx2dnssd.Rx2Dnssd;
import com.github.druk.rx2dnssd.Rx2DnssdEmbedded;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import javax.annotation.Nullable;

import io.reactivex.android.schedulers.AndroidSchedulers;
import io.reactivex.disposables.Disposable;
import io.reactivex.schedulers.Schedulers;
import io.reactivex.Scheduler;

public class DnssdImpl implements Zeroconf {
    public static final String BROWSE_KEY_UPSTREAM = "upstream";
    public static final String BROWSE_KEY_HOTSPOT = "hotspot";
    public static final String KEY_BROWSE_KEY = "browseKey";

    private static final String TAG = "DnssdImpl";
    private static final String DEFAULT_SERVICE_TYPE = "_mqtt-ws._tcp";
    private static final int RESTART_SETTLE_MS = 800;
    private static final int BROWSE_DISPOSE_SETTLE_MS = 600;
    private static final int HOTSPOT_PROBE_DELAY_MS = 800;
    /** Align with typical ESP mDNS re-announce interval. */
    private static final int HOTSPOT_WATCHDOG_INTERVAL_MS = 15_000;
    /** Force hotspot re-browse when no resolve or browse event this long. */
    private static final int HOTSPOT_STALE_MS = 20_000;
    /** Time-slice swlan0 browse while dual-homed (one native browse at a time). */
    private static final int HOTSPOT_ROTATION_MS = 20_000;
    private static final int HOTSPOT_WINDOW_MS = 5_000;
    private static final Scheduler DNSSD_SCHEDULER = Schedulers.single();

    private final Rx2Dnssd rxDnssd;
    private final ZeroconfModule zeroconfModule;
    private final ReactApplicationContext reactApplicationContext;
    private final NetworkDiscoveryManager networkDiscoveryManager;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private final Map<String, BonjourService> mPublishedServices = new HashMap<>();
    private final Map<String, Disposable> mRegisteredDisposables = new HashMap<>();
    private final Map<String, Disposable> browseDisposables = new HashMap<>();
    private final Map<String, Integer> activeBrowseIfIndexes = new HashMap<>();
    private final Map<String, Runnable> pendingBrowseStarts = new HashMap<>();

    @Nullable
    private WifiManager.MulticastLock multicastLock;
    private boolean discoveryWatching = false;
    private String pendingScanType = DEFAULT_SERVICE_TYPE;
    private String pendingScanProtocol = "tcp";
    private String pendingScanDomain = "local.";

    public DnssdImpl(ZeroconfModule zeroconfModule, ReactApplicationContext reactApplicationContext) {
        this.zeroconfModule = zeroconfModule;
        this.reactApplicationContext = reactApplicationContext;
        this.rxDnssd = new Rx2DnssdEmbedded(reactApplicationContext);
        this.networkDiscoveryManager = new NetworkDiscoveryManager(reactApplicationContext);
        this.networkDiscoveryManager.setListener(this::applyDiscoveryMode);
    }

    @Override
    public void scan(String type, String protocol, String domain) {
        pendingScanType = getServiceType(type, protocol);
        pendingScanDomain = domain != null && !domain.isEmpty() ? domain : "local.";
        pendingScanProtocol = protocol;
        startDiscoveryWatching();
    }

    @Override
    public void stop() {
        stopDiscoveryWatching();
    }

    public void restartDiscoveryScan() {
        stopAllBrowses();
        mainHandler.removeCallbacks(restartAfterSettleRunnable);
        mainHandler.postDelayed(restartAfterSettleRunnable, RESTART_SETTLE_MS);
    }

    private void restartAfterSettle() {
        if (!discoveryWatching) return;
        networkDiscoveryManager.refresh();
    }

    private final Runnable restartAfterSettleRunnable = this::restartAfterSettle;
    @Nullable private Runnable pendingHotspotProbe;
    @Nullable private Runnable hotspotWatchdogRunnable;
    private int hotspotWatchdogIfIndex = -1;
    private long lastHotspotResolveAtMs = 0;
    private long lastHotspotBrowseEventAtMs = 0;
    private long lastAnyBrowseEventAtMs = 0;
    /** Dual-homed uses one ALL_INTERFACES browse; segment by resolved IP. */
    private boolean dualHomedSingleBrowse = false;
    private int storedUpstreamIfIndex = DNSSD.ALL_INTERFACES;
    private int storedHotspotIfIndex = -1;
    @Nullable private Runnable hotspotRotationRunnable;
    @Nullable private Runnable hotspotWindowEndRunnable;
    private boolean hotspotRotationActive = false;

    public void startDiscoveryWatching() {
        if (discoveryWatching) return;
        discoveryWatching = true;
        DNSSDEmbedded.setSessionKeepAlive(true);
        networkDiscoveryManager.startWatching();
        zeroconfModule.sendEvent(reactApplicationContext, ZeroconfModule.EVENT_START, null);
    }

    public void stopDiscoveryWatching() {
        if (!discoveryWatching) return;
        discoveryWatching = false;
        cancelAllPendingBrowseStarts();
        stopHotspotRotation();
        stopAllBrowses();
        networkDiscoveryManager.stopWatching();
        releaseMulticastLock();
        mainHandler.postDelayed(
                () -> {
                    if (!discoveryWatching) {
                        DNSSDEmbedded.shutdownSession();
                    }
                },
                BROWSE_DISPOSE_SETTLE_MS);
        zeroconfModule.sendEvent(reactApplicationContext, ZeroconfModule.EVENT_STOP, null);
    }

    public String getDiscoveryMode() {
        return networkDiscoveryManager.getDiscoveryMode();
    }

    private void applyDiscoveryMode(String mode, int upstreamIfIndex, int hotspotIfIndex) {
        zeroconfModule.sendEvent(
                reactApplicationContext,
                ZeroconfModule.EVENT_DISCOVERY_MODE,
                mode);

        switch (mode) {
            case NetworkDiscoveryManager.MODE_DUAL_HOMED:
                dualHomedSingleBrowse = true;
                storedUpstreamIfIndex =
                        upstreamIfIndex > 0 ? upstreamIfIndex : DNSSD.ALL_INTERFACES;
                storedHotspotIfIndex = hotspotIfIndex;
                stopBrowse(BROWSE_KEY_HOTSPOT);
                stopHotspotRotation();
                lastAnyBrowseEventAtMs = 0;
                startBrowse(BROWSE_KEY_UPSTREAM, storedUpstreamIfIndex, true);
                startHotspotRotation();
                break;
            case NetworkDiscoveryManager.MODE_HOTSPOT_ONLY:
                dualHomedSingleBrowse = false;
                stopHotspotRotation();
                stopBrowse(BROWSE_KEY_UPSTREAM);
                if (hotspotIfIndex > 0) {
                    startBrowse(BROWSE_KEY_HOTSPOT, hotspotIfIndex);
                } else {
                    stopBrowse(BROWSE_KEY_HOTSPOT);
                }
                break;
            case NetworkDiscoveryManager.MODE_NONE:
            default:
                dualHomedSingleBrowse = false;
                stopHotspotRotation();
                stopBrowse(BROWSE_KEY_HOTSPOT);
                zeroconfModule.sendEvent(
                        reactApplicationContext, ZeroconfModule.EVENT_HOTSPOT_PURGED, null);
                startBrowse(BROWSE_KEY_UPSTREAM, DNSSD.ALL_INTERFACES);
                break;
        }
    }

    private void startBrowse(String browseKey, int ifIndex) {
        startBrowse(browseKey, ifIndex, false);
    }

    private void startBrowse(String browseKey, int ifIndex, boolean force) {
        Integer currentIfIndex = activeBrowseIfIndexes.get(browseKey);
        if (!force && currentIfIndex != null && currentIfIndex == ifIndex) {
            Disposable existing = browseDisposables.get(browseKey);
            if (existing != null && !existing.isDisposed()) return;
        }
        boolean needsSettle = force || browseDisposables.containsKey(browseKey);
        stopBrowse(browseKey);
        if (needsSettle) {
            scheduleBrowseStart(browseKey, ifIndex, force, BROWSE_DISPOSE_SETTLE_MS);
        } else {
            beginBrowseSubscription(browseKey, ifIndex, force);
        }
    }

    private void scheduleBrowseStart(String browseKey, int ifIndex, boolean force, long delayMs) {
        cancelPendingBrowseStart(browseKey);
        Runnable startTask =
                () -> {
                    pendingBrowseStarts.remove(browseKey);
                    if (!discoveryWatching) return;
                    beginBrowseSubscription(browseKey, ifIndex, force);
                };
        pendingBrowseStarts.put(browseKey, startTask);
        mainHandler.postDelayed(startTask, delayMs);
    }

    private void cancelPendingBrowseStart(String browseKey) {
        Runnable pending = pendingBrowseStarts.remove(browseKey);
        if (pending != null) {
            mainHandler.removeCallbacks(pending);
        }
    }

    private void cancelAllPendingBrowseStarts() {
        for (String key : new ArrayList<>(pendingBrowseStarts.keySet())) {
            cancelPendingBrowseStart(key);
        }
    }

    private void beginBrowseSubscription(String browseKey, int ifIndex, boolean force) {
        acquireMulticastLock();

        Log.d(
                TAG,
                "Starting browse key="
                        + browseKey
                        + " ifIndex="
                        + ifIndex
                        + " type="
                        + pendingScanType
                        + (dualHomedSingleBrowse ? " (dual-homed single)" : "")
                        + (force ? " (forced)" : ""));

        Disposable disposable =
                rxDnssd
                        .browseOnInterface(pendingScanType, pendingScanDomain, ifIndex)
                        .compose(rxDnssd.resolve())
                        .compose(rxDnssd.queryRecords())
                        .subscribeOn(DNSSD_SCHEDULER)
                        .observeOn(AndroidSchedulers.mainThread())
                        .subscribe(
                                bonjourService -> {
                                    if (dualHomedSingleBrowse
                                            && BROWSE_KEY_UPSTREAM.equals(browseKey)) {
                                        lastAnyBrowseEventAtMs = System.currentTimeMillis();
                                    }
                                    String effectiveBrowseKey =
                                            resolveBrowseKey(bonjourService, browseKey);
                                    if (BROWSE_KEY_HOTSPOT.equals(effectiveBrowseKey)) {
                                        lastHotspotBrowseEventAtMs = System.currentTimeMillis();
                                    }
                                    String mismatchReason =
                                            subnetMismatchReason(
                                                    bonjourService, browseKey, effectiveBrowseKey);
                                    if (mismatchReason != null) {
                                        if (dualHomedSingleBrowse
                                                && BROWSE_KEY_UPSTREAM.equals(browseKey)) {
                                            lastAnyBrowseEventAtMs = System.currentTimeMillis();
                                        }
                                        logSubnetMismatch(
                                                bonjourService, effectiveBrowseKey, mismatchReason);
                                        return;
                                    }
                                    if (BROWSE_KEY_HOTSPOT.equals(effectiveBrowseKey)) {
                                        lastHotspotResolveAtMs = System.currentTimeMillis();
                                    }
                                    WritableMap service =
                                            serviceInfoToMap(bonjourService, effectiveBrowseKey);
                                    Log.d(TAG, service.toString());
                                    zeroconfModule.sendEvent(
                                            reactApplicationContext,
                                            ZeroconfModule.EVENT_RESOLVE,
                                            service);
                                },
                                throwable -> {
                                    Log.e(TAG, "Browse error key=" + browseKey, throwable);
                                    zeroconfModule.sendEvent(
                                            reactApplicationContext,
                                            ZeroconfModule.EVENT_ERROR,
                                            throwable.getMessage());
                                });

        browseDisposables.put(browseKey, disposable);
        activeBrowseIfIndexes.put(browseKey, ifIndex);

        if (BROWSE_KEY_HOTSPOT.equals(browseKey)) {
            if (!force && !hotspotRotationActive) {
                lastHotspotResolveAtMs = 0;
                lastHotspotBrowseEventAtMs = 0;
                scheduleHotspotProbe(ifIndex);
            }
            if (!hotspotRotationActive) {
                startHotspotWatchdog(ifIndex);
            }
        } else if (dualHomedSingleBrowse && BROWSE_KEY_UPSTREAM.equals(browseKey)) {
            if (!force) {
                lastHotspotResolveAtMs = 0;
                lastHotspotBrowseEventAtMs = 0;
                lastAnyBrowseEventAtMs = 0;
            }
            startHotspotWatchdog(storedUpstreamIfIndex);
        }
    }

    private void startHotspotRotation() {
        stopHotspotRotation();
        if (!dualHomedSingleBrowse || storedHotspotIfIndex <= 0) return;
        hotspotRotationRunnable =
                () -> {
                    if (!discoveryWatching || !dualHomedSingleBrowse) return;
                    openHotspotRotationWindow();
                };
        mainHandler.postDelayed(hotspotRotationRunnable, HOTSPOT_ROTATION_MS);
    }

    private void openHotspotRotationWindow() {
        if (!discoveryWatching || !dualHomedSingleBrowse || storedHotspotIfIndex <= 0) return;
        Log.d(TAG, "Hotspot rotation window ifIndex=" + storedHotspotIfIndex);
        hotspotRotationActive = true;
        stopHotspotWatchdog();
        stopBrowse(BROWSE_KEY_UPSTREAM);
        scheduleBrowseStart(
                BROWSE_KEY_HOTSPOT, storedHotspotIfIndex, true, BROWSE_DISPOSE_SETTLE_MS);
        if (hotspotWindowEndRunnable != null) {
            mainHandler.removeCallbacks(hotspotWindowEndRunnable);
        }
        hotspotWindowEndRunnable =
                () -> {
                    hotspotWindowEndRunnable = null;
                    hotspotRotationActive = false;
                    if (!discoveryWatching || !dualHomedSingleBrowse) return;
                    stopBrowse(BROWSE_KEY_HOTSPOT);
                    startBrowse(BROWSE_KEY_UPSTREAM, storedUpstreamIfIndex, true);
                    startHotspotRotation();
                };
        mainHandler.postDelayed(
                hotspotWindowEndRunnable, BROWSE_DISPOSE_SETTLE_MS + HOTSPOT_WINDOW_MS);
    }

    private void stopHotspotRotation() {
        hotspotRotationActive = false;
        if (hotspotRotationRunnable != null) {
            mainHandler.removeCallbacks(hotspotRotationRunnable);
            hotspotRotationRunnable = null;
        }
        if (hotspotWindowEndRunnable != null) {
            mainHandler.removeCallbacks(hotspotWindowEndRunnable);
            hotspotWindowEndRunnable = null;
        }
    }

    private void scheduleHotspotProbe(int ifIndex) {
        if (pendingHotspotProbe != null) {
            mainHandler.removeCallbacks(pendingHotspotProbe);
        }
        pendingHotspotProbe =
                () -> {
                    pendingHotspotProbe = null;
                    if (!discoveryWatching) return;
                    Integer activeIf = activeBrowseIfIndexes.get(BROWSE_KEY_HOTSPOT);
                    if (activeIf == null || activeIf != ifIndex) return;
                    Log.d(TAG, "Hotspot browse probe ifIndex=" + ifIndex);
                    startBrowse(BROWSE_KEY_HOTSPOT, ifIndex, true);
                };
        mainHandler.postDelayed(pendingHotspotProbe, HOTSPOT_PROBE_DELAY_MS);
    }

    private void startHotspotWatchdog(int ifIndex) {
        stopHotspotWatchdog();
        hotspotWatchdogIfIndex = ifIndex;
        hotspotWatchdogRunnable =
                () -> {
                    if (!discoveryWatching) return;

                    if (dualHomedSingleBrowse) {
                        if (activeBrowseIfIndexes.get(BROWSE_KEY_UPSTREAM) == null) return;
                    } else {
                        Integer activeIf = activeBrowseIfIndexes.get(BROWSE_KEY_HOTSPOT);
                        if (activeIf == null || activeIf != hotspotWatchdogIfIndex) return;
                    }

                    long now = System.currentTimeMillis();
                    if (dualHomedSingleBrowse) {
                        long anyEventAgeMs =
                                lastAnyBrowseEventAtMs == 0
                                        ? Long.MAX_VALUE
                                        : now - lastAnyBrowseEventAtMs;
                        if (anyEventAgeMs >= HOTSPOT_STALE_MS) {
                            Log.w(
                                    TAG,
                                    "Dual-homed browse stale: anyEventAge="
                                            + anyEventAgeMs
                                            + "ms — forcing upstream re-browse ifIndex="
                                            + storedUpstreamIfIndex);
                            startBrowse(
                                    BROWSE_KEY_UPSTREAM, storedUpstreamIfIndex, true);
                        } else {
                            Log.d(
                                    TAG,
                                    "Dual-homed browse ok: anyEventAge="
                                            + anyEventAgeMs
                                            + "ms ifIndex="
                                            + storedUpstreamIfIndex);
                        }
                        scheduleHotspotWatchdogTick();
                        return;
                    }

                    long resolveAgeMs =
                            lastHotspotResolveAtMs == 0
                                    ? Long.MAX_VALUE
                                    : now - lastHotspotResolveAtMs;
                    long eventAgeMs =
                            lastHotspotBrowseEventAtMs == 0
                                    ? Long.MAX_VALUE
                                    : now - lastHotspotBrowseEventAtMs;

                    if (resolveAgeMs >= HOTSPOT_STALE_MS && eventAgeMs >= HOTSPOT_STALE_MS) {
                        Log.w(
                                TAG,
                                "Hotspot watchdog stale: resolveAge="
                                        + resolveAgeMs
                                        + "ms eventAge="
                                        + eventAgeMs
                                        + "ms ifIndex="
                                        + hotspotWatchdogIfIndex
                                        + " — forcing re-browse");
                        startBrowse(BROWSE_KEY_HOTSPOT, hotspotWatchdogIfIndex, true);
                    } else {
                        Log.d(
                                TAG,
                                "Hotspot watchdog ok: resolveAge="
                                        + resolveAgeMs
                                        + "ms eventAge="
                                        + eventAgeMs
                                        + "ms ifIndex="
                                        + hotspotWatchdogIfIndex);
                    }
                    scheduleHotspotWatchdogTick();
                };
        scheduleHotspotWatchdogTick();
    }

    private void scheduleHotspotWatchdogTick_DUP_REMOVE() {
        if (hotspotWatchdogRunnable == null) return;
        mainHandler.removeCallbacks(hotspotWatchdogRunnable);
        mainHandler.postDelayed(hotspotWatchdogRunnable, HOTSPOT_WATCHDOG_INTERVAL_MS);
    }

    private void stopHotspotWatchdog() {
        if (hotspotWatchdogRunnable != null) {
            mainHandler.removeCallbacks(hotspotWatchdogRunnable);
            hotspotWatchdogRunnable = null;
        }
        hotspotWatchdogIfIndex = -1;
    }

    private void stopBrowse(String browseKey) {
        cancelPendingBrowseStart(browseKey);
        if (BROWSE_KEY_HOTSPOT.equals(browseKey)
                || (BROWSE_KEY_UPSTREAM.equals(browseKey) && dualHomedSingleBrowse)) {
            if (pendingHotspotProbe != null) {
                mainHandler.removeCallbacks(pendingHotspotProbe);
                pendingHotspotProbe = null;
            }
            stopHotspotWatchdog();
        }
        Disposable disposable = browseDisposables.remove(browseKey);
        if (disposable != null && !disposable.isDisposed()) {
            disposable.dispose();
        }
        activeBrowseIfIndexes.remove(browseKey);
    }

    private void stopAllBrowses() {
        for (String key : new ArrayList<>(browseDisposables.keySet())) {
            stopBrowse(key);
        }
    }

    private void acquireMulticastLock() {
        if (multicastLock != null) return;
        @SuppressLint("WifiManagerLeak")
        WifiManager wifi =
                (WifiManager) reactApplicationContext.getSystemService(Context.WIFI_SERVICE);
        multicastLock = wifi.createMulticastLock("DnssdImpl");
        multicastLock.setReferenceCounted(true);
        multicastLock.acquire();
    }

    private void releaseMulticastLock() {
        if (multicastLock == null) return;
        try {
            multicastLock.release();
        } catch (Exception ignored) {
        }
        multicastLock = null;
    }

    private String getServiceType(String type, String protocol) {
        return String.format("_%s._%s", type, protocol);
    }

    private static List<String> collectIpv4(BonjourService service) {
        List<String> ipv4 = new ArrayList<>();
        for (InetAddress address : service.getInetAddresses()) {
            if (address instanceof Inet4Address) {
                ipv4.add(address.getHostAddress());
            }
        }
        return ipv4;
    }

    private String resolveBrowseKey(BonjourService service, String browseKey) {
        if (!dualHomedSingleBrowse) {
            return browseKey;
        }
        List<String> ipv4 = collectIpv4(service);
        String hotspotCidr = networkDiscoveryManager.getHotspotCidr();
        if (hotspotCidr != null) {
            for (String ip : ipv4) {
                if (Ipv4Subnet.contains(hotspotCidr, ip)) {
                    return BROWSE_KEY_HOTSPOT;
                }
            }
        }
        return BROWSE_KEY_UPSTREAM;
    }

    /**
     * @return null when service matches browse leg subnet; otherwise human-readable reason.
     */
    @Nullable
    private String subnetMismatchReason(
            BonjourService service, String browseKey, String effectiveBrowseKey) {
        List<String> ipv4 = collectIpv4(service);
        String hotspotCidr = networkDiscoveryManager.getHotspotCidr();
        String upstreamCidr = networkDiscoveryManager.getUpstreamCidr();

        if (dualHomedSingleBrowse) {
            if (ipv4.isEmpty()) {
                return BROWSE_KEY_UPSTREAM.equals(effectiveBrowseKey)
                        ? null
                        : "no IPv4 addresses for hotspot segment (hostname="
                                + service.getHostname()
                                + ")";
            }
            for (String ip : ipv4) {
                if (hotspotCidr != null && Ipv4Subnet.contains(hotspotCidr, ip)) return null;
                if (upstreamCidr != null && Ipv4Subnet.contains(upstreamCidr, ip)) return null;
            }
            return "ipv4="
                    + ipv4
                    + " not in dual-homed subnets (hotspot="
                    + hotspotCidr
                    + " upstream="
                    + upstreamCidr
                    + ")";
        }

        if (ipv4.isEmpty()) {
            if (BROWSE_KEY_UPSTREAM.equals(browseKey)) return null;
            return "no IPv4 addresses (hostname="
                    + service.getHostname()
                    + ", expected hotspotCidr="
                    + hotspotCidr
                    + ")";
        }

        if (BROWSE_KEY_HOTSPOT.equals(browseKey)) {
            if (hotspotCidr == null) {
                return "hotspotCidr unknown, ipv4=" + ipv4;
            }
            for (String ip : ipv4) {
                if (Ipv4Subnet.contains(hotspotCidr, ip)) return null;
            }
            return "ipv4="
                    + ipv4
                    + " not in hotspotCidr="
                    + hotspotCidr
                    + " (hostname="
                    + service.getHostname()
                    + ")";
        }

        if (hotspotCidr != null) {
            for (String ip : ipv4) {
                if (!Ipv4Subnet.contains(hotspotCidr, ip)) return null;
            }
            return "ipv4="
                    + ipv4
                    + " only on hotspotCidr="
                    + hotspotCidr
                    + " (hostname="
                    + service.getHostname()
                    + ")";
        }

        if (upstreamCidr != null) {
            for (String ip : ipv4) {
                if (Ipv4Subnet.contains(upstreamCidr, ip)) return null;
            }
            return "ipv4="
                    + ipv4
                    + " not in upstreamCidr="
                    + upstreamCidr
                    + " (hostname="
                    + service.getHostname()
                    + ")";
        }
        return null;
    }

    private void logSubnetMismatch(
            BonjourService service, String browseKey, String reason) {
        Log.d(
                TAG,
                "Skipping key="
                        + browseKey
                        + " name="
                        + service.getServiceName()
                        + " port="
                        + service.getPort()
                        + " hostname="
                        + service.getHostname()
                        + " ipv4="
                        + collectIpv4(service)
                        + " hotspotCidr="
                        + networkDiscoveryManager.getHotspotCidr()
                        + " upstreamCidr="
                        + networkDiscoveryManager.getUpstreamCidr()
                        + " — "
                        + reason);
    }

    private WritableMap serviceInfoToMap(BonjourService serviceInfo, String browseKey) {
        WritableMap service = new WritableNativeMap();
        service.putString(ZeroconfModule.KEY_SERVICE_NAME, serviceInfo.getServiceName());
        service.putString(ZeroconfModule.KEY_SERVICE_HOST, serviceInfo.getServiceName());
        service.putString(KEY_BROWSE_KEY, browseKey);

        WritableArray addresses = new WritableNativeArray();
        List<InetAddress> hostList = serviceInfo.getInetAddresses();
        for (InetAddress host : hostList) {
            addresses.pushString(host.getHostAddress());
        }

        service.putArray(ZeroconfModule.KEY_SERVICE_ADDRESSES, addresses);
        service.putString(
                ZeroconfModule.KEY_SERVICE_FULL_NAME, serviceInfo.getServiceName());
        service.putInt(ZeroconfModule.KEY_SERVICE_PORT, serviceInfo.getPort());

        WritableMap txtRecords = new WritableNativeMap();
        Map<String, String> attributes = serviceInfo.getTxtRecords();
        for (String key : attributes.keySet()) {
            String recordValue = attributes.get(key);
            txtRecords.putString(
                    String.format(Locale.getDefault(), "%s", key),
                    String.format(
                            Locale.getDefault(), "%s", recordValue != null ? recordValue : ""));
        }

        service.putMap(ZeroconfModule.KEY_SERVICE_TXT, txtRecords);
        return service;
    }

    @Override
    public void unregisterService(String serviceName) {
        BonjourService bs = mPublishedServices.get(serviceName);
        if (bs != null) {
            zeroconfModule.sendEvent(
                    reactApplicationContext,
                    ZeroconfModule.EVENT_UNREGISTERED,
                    serviceInfoToMap(bs, BROWSE_KEY_UPSTREAM));
            mPublishedServices.remove(serviceName);
        }

        Disposable registerDisposable = mRegisteredDisposables.get(serviceName);
        if (registerDisposable != null && !registerDisposable.isDisposed()) {
            registerDisposable.dispose();
            mRegisteredDisposables.remove(serviceName);
        }
    }

    @Override
    public void registerService(
            String type, String protocol, String domain, String name, int port, ReadableMap txt) {
        BonjourService bs =
                new BonjourService.Builder(0, 0, name, getServiceType(type, protocol), null)
                        .port(port)
                        .dnsRecords(getTxtRecordMap(txt))
                        .build();

        Disposable registerDisposable =
                rxDnssd
                        .register(bs)
                        .subscribeOn(DNSSD_SCHEDULER)
                        .observeOn(AndroidSchedulers.mainThread())
                        .subscribe(
                                bonjourService -> {
                                    mPublishedServices.put(bs.getServiceName(), bs);
                                    zeroconfModule.sendEvent(
                                            reactApplicationContext,
                                            ZeroconfModule.EVENT_PUBLISHED,
                                            serviceInfoToMap(bonjourService, BROWSE_KEY_UPSTREAM));
                                },
                                throwable -> Log.e(TAG, "register error", throwable));

        mRegisteredDisposables.put(name, registerDisposable);
    }

    private Map<String, String> getTxtRecordMap(ReadableMap txt) {
        Map<String, String> txtMap = new HashMap<>();
        ReadableMapKeySetIterator iterator = txt.keySetIterator();
        while (iterator.hasNextKey()) {
            String key = iterator.nextKey();
            txtMap.put(key, txt.getString(key));
        }
        return txtMap;
    }
}
