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

public class DnssdImpl implements Zeroconf {
    public static final String BROWSE_KEY_UPSTREAM = "upstream";
    public static final String BROWSE_KEY_HOTSPOT = "hotspot";
    public static final String KEY_BROWSE_KEY = "browseKey";

    private static final String TAG = "DnssdImpl";
    private static final String DEFAULT_SERVICE_TYPE = "_mqtt-ws._tcp";
    private static final int RESTART_SETTLE_MS = 400;
    private static final int HOTSPOT_PROBE_DELAY_MS = 800;

    private final Rx2Dnssd rxDnssd;
    private final ZeroconfModule zeroconfModule;
    private final ReactApplicationContext reactApplicationContext;
    private final NetworkDiscoveryManager networkDiscoveryManager;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private final Map<String, BonjourService> mPublishedServices = new HashMap<>();
    private final Map<String, Disposable> mRegisteredDisposables = new HashMap<>();
    private final Map<String, Disposable> browseDisposables = new HashMap<>();
    private final Map<String, Integer> activeBrowseIfIndexes = new HashMap<>();

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
        mainHandler.removeCallbacks(restartAfterSettle);
        mainHandler.postDelayed(restartAfterSettle, RESTART_SETTLE_MS);
    }

    private final Runnable restartAfterSettle =
            () -> {
                if (!discoveryWatching) return;
                networkDiscoveryManager.refresh();
            };

    public void startDiscoveryWatching() {
        if (discoveryWatching) return;
        discoveryWatching = true;
        networkDiscoveryManager.startWatching();
        zeroconfModule.sendEvent(reactApplicationContext, ZeroconfModule.EVENT_START, null);
    }

    public void stopDiscoveryWatching() {
        if (!discoveryWatching) return;
        discoveryWatching = false;
        stopAllBrowses();
        networkDiscoveryManager.stopWatching();
        releaseMulticastLock();
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
            case NetworkDiscoveryManager.MODE_HOTSPOT_ONLY:
                stopBrowse(BROWSE_KEY_UPSTREAM);
                if (hotspotIfIndex > 0) {
                    startBrowse(BROWSE_KEY_HOTSPOT, hotspotIfIndex);
                } else {
                    stopBrowse(BROWSE_KEY_HOTSPOT);
                }
                break;
            case NetworkDiscoveryManager.MODE_DUAL_HOMED:
                if (upstreamIfIndex > 0) {
                    startBrowse(BROWSE_KEY_UPSTREAM, upstreamIfIndex);
                } else {
                    startBrowse(BROWSE_KEY_UPSTREAM, DNSSD.ALL_INTERFACES);
                }
                scheduleHotspotBrowse(hotspotIfIndex);
                break;
            case NetworkDiscoveryManager.MODE_NONE:
            default:
                stopBrowse(BROWSE_KEY_HOTSPOT);
                zeroconfModule.sendEvent(
                        reactApplicationContext, ZeroconfModule.EVENT_HOTSPOT_PURGED, null);
                startBrowse(BROWSE_KEY_UPSTREAM, DNSSD.ALL_INTERFACES);
                break;
        }
    }

    private void scheduleHotspotBrowse(int hotspotIfIndex) {
        mainHandler.post(() -> {
            if (!discoveryWatching) return;
            if (hotspotIfIndex > 0) {
                startBrowse(BROWSE_KEY_HOTSPOT, hotspotIfIndex);
            } else {
                stopBrowse(BROWSE_KEY_HOTSPOT);
            }
        });
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
        stopBrowse(browseKey);
        acquireMulticastLock();

        Log.d(
                TAG,
                "Starting browse key="
                        + browseKey
                        + " ifIndex="
                        + ifIndex
                        + " type="
                        + pendingScanType
                        + (force ? " (forced)" : ""));

        Disposable disposable =
                rxDnssd
                        .browseOnInterface(pendingScanType, pendingScanDomain, ifIndex)
                        .compose(rxDnssd.resolve())
                        .compose(rxDnssd.queryRecords())
                        .subscribeOn(Schedulers.io())
                        .observeOn(AndroidSchedulers.mainThread())
                        .subscribe(
                                bonjourService -> {
                                    if (!matchesBrowseSubnet(bonjourService, browseKey)) {
                                        Log.d(
                                                TAG,
                                                "Skipping key="
                                                        + browseKey
                                                        + " name="
                                                        + bonjourService.getServiceName()
                                                        + " (subnet mismatch)");
                                        return;
                                    }
                                    WritableMap service = serviceInfoToMap(bonjourService, browseKey);
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
            scheduleHotspotProbe(ifIndex);
        }
    }

    private void scheduleHotspotProbe(int ifIndex) {
        mainHandler.postDelayed(
                () -> {
                    if (!discoveryWatching) return;
                    Integer activeIf = activeBrowseIfIndexes.get(BROWSE_KEY_HOTSPOT);
                    if (activeIf == null || activeIf != ifIndex) return;
                    Log.d(TAG, "Hotspot browse probe ifIndex=" + ifIndex);
                    startBrowse(BROWSE_KEY_HOTSPOT, ifIndex, true);
                },
                HOTSPOT_PROBE_DELAY_MS);
    }

    private void stopBrowse(String browseKey) {
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

    private boolean matchesBrowseSubnet(BonjourService service, String browseKey) {
        List<String> ipv4 = new ArrayList<>();
        for (InetAddress address : service.getInetAddresses()) {
            if (address instanceof Inet4Address) {
                ipv4.add(address.getHostAddress());
            }
        }

        if (ipv4.isEmpty()) {
            return BROWSE_KEY_UPSTREAM.equals(browseKey);
        }

        String hotspotCidr = networkDiscoveryManager.getHotspotCidr();
        if (BROWSE_KEY_HOTSPOT.equals(browseKey)) {
            if (hotspotCidr == null) return false;
            for (String ip : ipv4) {
                if (Ipv4Subnet.contains(hotspotCidr, ip)) return true;
            }
            return false;
        }

        if (hotspotCidr != null) {
            for (String ip : ipv4) {
                if (!Ipv4Subnet.contains(hotspotCidr, ip)) return true;
            }
            return false;
        }

        String upstreamCidr = networkDiscoveryManager.getUpstreamCidr();
        if (upstreamCidr != null) {
            for (String ip : ipv4) {
                if (Ipv4Subnet.contains(upstreamCidr, ip)) return true;
            }
        }
        return true;
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
                        .subscribeOn(Schedulers.io())
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
