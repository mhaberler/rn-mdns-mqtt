import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Colors } from '@/constants/colors';
import { useAppState } from '@/hooks/use-app-state';
import { useMqttConnection } from '@/hooks/use-mqtt-connection';
import { useMqttDiscovery } from '@/hooks/use-mqtt-discovery';
import { isBrokerConnectReady, pickConnectHost } from '@/lib/broker-host';
import { canSoftRefreshDiscovery } from '@/lib/zeroconf-adapter';
import { hasDevClientNativeModules, isExpoGo } from '@/lib/native-modules';
import {
  brokerKey,
  friendlyType,
  isWssType,
  sourceOf,
} from '@/lib/service-type';
import type { ServiceEntry } from '@/types/broker';
import { isHotspotSegment, isUpstreamSegment } from '@/lib/discovered-broker-key';
import { useScreenInsets } from '@/hooks/use-screen-insets';

const NOT_FOUND_GRACE_MS = 12000;
const PRIVACY_POLICY_URL =
  'https://github.com/mhaberler/rn-mdns-mqtt/blob/main/PRIVACY.md';
const SUPPORT_URL = 'https://github.com/mhaberler/rn-mdns-mqtt';

function isDiscoveredBroker(b: ServiceEntry): boolean {
  return b.source ? b.source === 'discovered' : !!b.discovered;
}

function defaultPreconfigured(): Record<string, ServiceEntry> {
  const services: Record<string, ServiceEntry> = {
    'test-mosquitto-wss': {
      name: 'test.mosquitto.org (WSS)',
      type: '_mqtt-wss._tcp.',
      host: 'test.mosquitto.org',
      port: 8081,
      discovered: false,
      resolved: true,
      source: 'preconfigured',
    },
  };

  if (Platform.OS === 'android') {
    services['test-mosquitto-ws'] = {
      name: 'test.mosquitto.org (WS)',
      type: '_mqtt-ws._tcp.',
      host: 'test.mosquitto.org',
      port: 8080,
      discovered: false,
      resolved: true,
      source: 'preconfigured',
    };
  }

  return services;
}

export default function ScannerScreen() {
  const router = useRouter();
  const isNative = hasDevClientNativeModules();
  const screenInsets = useScreenInsets();

  const { preferredBroker, setPreferredBroker, manualBrokers, setManualBrokers } = useAppState();
  const mqttConn = useMqttConnection();
  const { discoveredBrokers, refresh, hotspotDiscoveryActive } = useMqttDiscovery();

  const [services] = useState(() => defaultPreconfigured());
  const [manualHost, setManualHost] = useState('');
  const [manualPort, setManualPort] = useState('8883');
  const [selectedType, setSelectedType] = useState<'_mqtt-ws._tcp.' | '_mqtt-wss._tcp.'>(
    '_mqtt-ws._tcp.',
  );
  const [manualRejectUnauthorized, setManualRejectUnauthorized] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<boolean | null>(null);
  const [testTimeRemaining, setTestTimeRemaining] = useState(0);
  const [preferredNotFound, setPreferredNotFound] = useState(false);

  const testTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const notFoundTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const preconfiguredList = useMemo(
    () =>
      Object.entries(services)
        .filter(([, s]) => s.source === 'preconfigured' || (!s.source && !s.discovered))
        .map(([key, service]) => ({ key, service })),
    [services],
  );

  const discoveredList = useMemo(
    () => Object.entries(discoveredBrokers).map(([key, service]) => ({ key, service })),
    [discoveredBrokers],
  );

  const upstreamDiscoveredList = useMemo(
    () => discoveredList.filter(({ service }) => isUpstreamSegment(service)),
    [discoveredList],
  );

  const hotspotDiscoveredList = useMemo(
    () => discoveredList.filter(({ service }) => isHotspotSegment(service)),
    [discoveredList],
  );

  const showDiscoveredSection =
    upstreamDiscoveredList.length > 0 || hotspotDiscoveryActive;

  const manualList = useMemo(
    () => manualBrokers.map((service) => ({ key: brokerKey(service), service })),
    [manualBrokers],
  );

  const isPreferred = useCallback(
    (service: ServiceEntry) =>
      preferredBroker?.name === service.name && preferredBroker?.port === service.port,
    [preferredBroker],
  );

  const preferredIsLive = useCallback(() => {
    if (!preferredBroker) return false;
    return Object.values(discoveredBrokers).some(
      (s) => s.name === preferredBroker.name && s.type === preferredBroker.type && s.resolved,
    );
  }, [discoveredBrokers, preferredBroker]);

  useEffect(() => {
    if (notFoundTimerRef.current) clearTimeout(notFoundTimerRef.current);
    setPreferredNotFound(false);

    if (preferredBroker && isDiscoveredBroker(preferredBroker) && isNative) {
      notFoundTimerRef.current = setTimeout(() => {
        if (!preferredIsLive()) setPreferredNotFound(true);
      }, NOT_FOUND_GRACE_MS);
    }

    return () => {
      if (notFoundTimerRef.current) clearTimeout(notFoundTimerRef.current);
    };
  }, [preferredBroker, isNative, preferredIsLive]);

  useEffect(() => {
    if (preferredNotFound && preferredIsLive()) {
      setPreferredNotFound(false);
    }
  }, [discoveredBrokers, preferredNotFound, preferredIsLive]);

  const refreshScan = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    const softRefresh = canSoftRefreshDiscovery();
    try {
      await refresh();
    } finally {
      setTimeout(() => setIsRefreshing(false), softRefresh ? 400 : 3000);
    }
  };

  const navigateToClient = (service: ServiceEntry) => {
    mqttConn.connect(service);
    router.push('/client');
  };

  const setPreferred = (service: ServiceEntry) => {
    setPreferredBroker({ ...service, tested: false });
    setTestResult(null);
  };

  const clearPreferredBroker = () => {
    setPreferredBroker(null);
    setTestResult(null);
  };

  const addManualService = () => {
    const port = parseInt(manualPort, 10);
    if (!manualHost || !port) return;

    const entry: ServiceEntry = {
      name: `${manualHost}:${port}`,
      type: selectedType,
      host: manualHost,
      port,
      discovered: false,
      resolved: true,
      source: 'manual',
      rejectUnauthorized: manualRejectUnauthorized,
    };

    const key = brokerKey(entry);
    const next = manualBrokers.filter((s) => brokerKey(s) !== key);
    next.push(entry);
    setManualBrokers(next);
    setPreferredBroker({ ...entry, tested: false });
    setTestResult(null);
    setManualHost('');
    setManualPort('8883');
  };

  const removeManualBroker = (entry: ServiceEntry) => {
    if (isPreferred(entry)) setPreferredBroker(null);
    setManualBrokers(manualBrokers.filter((s) => brokerKey(s) !== brokerKey(entry)));
  };

  const runInlineTest = async () => {
    if (!preferredBroker || isTesting) return;
    setIsTesting(true);
    setTestResult(null);
    setTestTimeRemaining(15);

    if (testTimerRef.current) clearInterval(testTimerRef.current);
    testTimerRef.current = setInterval(() => {
      setTestTimeRemaining((t) => {
        if (t <= 1 && testTimerRef.current) {
          clearInterval(testTimerRef.current);
          testTimerRef.current = null;
        }
        return Math.max(0, t - 1);
      });
    }, 1000);

    const success = await mqttConn.testConnect(preferredBroker);
    if (testTimerRef.current) {
      clearInterval(testTimerRef.current);
      testTimerRef.current = null;
    }
    setTestResult(success);
    setTestTimeRemaining(0);

    if (success) {
      setPreferredBroker({ ...preferredBroker, tested: true });
    }
    setIsTesting(false);
  };

  const updatePreferredField = <K extends keyof ServiceEntry>(key: K, value: ServiceEntry[K]) => {
    if (!preferredBroker) return;
    setPreferredBroker({ ...preferredBroker, [key]: value });
  };

  const showCredentials =
    preferredBroker &&
    (sourceOf(preferredBroker) === 'discovered' || sourceOf(preferredBroker) === 'manual');

  const sourceBadge = preferredBroker ? sourceOf(preferredBroker) : null;

  const isConnectedToPreferred =
    preferredBroker &&
    mqttConn.connectedBroker?.host === preferredBroker.host &&
    mqttConn.connectedBroker?.port === preferredBroker.port;

  const openLink = (url: string) => {
    void WebBrowser.openBrowserAsync(url);
  };

  return (
    <View style={styles.safe}>
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          {
            paddingTop: screenInsets.paddingTop,
            paddingBottom: screenInsets.paddingBottom,
            paddingLeft: screenInsets.paddingLeft,
            paddingRight: screenInsets.paddingRight,
          },
        ]}>
        <View style={styles.headerRow}>
          <Text style={styles.title}>Broker Configuration</Text>
          {isNative ? (
            <Pressable
              style={[styles.btn, styles.btnSuccess, isRefreshing && styles.btnDisabled]}
              onPress={refreshScan}
              disabled={isRefreshing}>
              <Text style={styles.btnText}>{isRefreshing ? 'Refreshing…' : 'Refresh'}</Text>
            </Pressable>
          ) : null}
        </View>
        {!isNative ? (
          <Text style={styles.expoGoBanner}>
            {isExpoGo()
              ? 'Expo Go: use dev build (bun run ios-device) for mDNS and persistence'
              : 'mDNS: native only'}
          </Text>
        ) : null}

        {preferredBroker ? (
          <View
            style={[
              styles.preferredCard,
              isConnectedToPreferred && mqttConn.isConnected && styles.preferredConnected,
              isConnectedToPreferred && mqttConn.isTrying && styles.preferredTrying,
            ]}>
            <View style={styles.preferredHeader}>
              <View
                style={[
                  styles.stateDot,
                  isConnectedToPreferred && mqttConn.isConnected && styles.stateDotConnected,
                  isConnectedToPreferred && mqttConn.isTrying && styles.stateDotTrying,
                ]}
              />
              <View style={styles.flex}>
                <View style={styles.badgeRow}>
                  <Text style={styles.preferredName}>{preferredBroker.name}</Text>
                  <Text
                    style={[
                      styles.sourceBadge,
                      sourceBadge === 'preconfigured' && styles.badgePrimary,
                      sourceBadge === 'discovered' && styles.badgeSuccess,
                      sourceBadge === 'manual' && styles.badgeWarning,
                    ]}>
                    {sourceBadge === 'preconfigured'
                      ? 'Pre-configured'
                      : sourceBadge === 'discovered'
                        ? 'Discovered'
                        : 'Manual'}
                  </Text>
                  {preferredBroker.tested ? (
                    <Text style={[styles.sourceBadge, styles.badgeSuccess]}>✓ Tested</Text>
                  ) : null}
                </View>
                <Text style={styles.monoMuted}>
                  {preferredBroker.host}:{preferredBroker.port}{' '}
                  <Text style={styles.typeChip}>{friendlyType(preferredBroker.type)}</Text>
                </Text>
                {preferredNotFound ? (
                  <Text style={styles.notFound}>Not found on this network</Text>
                ) : null}
                {showCredentials ? (
                  <View style={styles.credRow}>
                    <TextInput
                      style={styles.inputSmall}
                      placeholder="Username"
                      value={preferredBroker.username ?? ''}
                      onChangeText={(v) => updatePreferredField('username', v)}
                      autoCapitalize="none"
                    />
                    <TextInput
                      style={styles.inputSmall}
                      placeholder="Password"
                      value={preferredBroker.password ?? ''}
                      onChangeText={(v) => updatePreferredField('password', v)}
                      secureTextEntry
                      autoCapitalize="none"
                    />
                  </View>
                ) : null}
                {isWssType(preferredBroker.type) ? (
                  <View style={styles.tlsRow}>
                    <Switch
                      value={preferredBroker.rejectUnauthorized !== false}
                      onValueChange={(v) => updatePreferredField('rejectUnauthorized', v)}
                    />
                    <Text style={styles.tlsLabel}>Verify TLS certificate</Text>
                  </View>
                ) : null}
              </View>
            </View>
            <View style={styles.actionRow}>
              <Pressable
                style={[styles.btn, styles.btnWarning, styles.flex, isTesting && styles.btnDisabled]}
                onPress={runInlineTest}
                disabled={isTesting}>
                <Text style={styles.btnText}>
                  {isTesting ? `Testing (${testTimeRemaining}s)` : 'Test'}
                </Text>
              </Pressable>
              <Pressable
                style={[styles.btn, styles.btnPrimary, styles.flex]}
                onPress={() => navigateToClient(preferredBroker)}>
                <Text style={styles.btnText}>Open Client</Text>
              </Pressable>
              <Pressable style={[styles.btn, styles.btnClear]} onPress={clearPreferredBroker}>
                <Text style={styles.btnClearText}>Clear</Text>
              </Pressable>
            </View>
            {testResult !== null ? (
              <Text style={[styles.testResult, testResult ? styles.testPass : styles.testFail]}>
                {testResult
                  ? 'Test passed — broker is reachable'
                  : 'Test failed — check host, port, and credentials'}
              </Text>
            ) : null}
          </View>
        ) : null}

        <BrokerSection title="Pre-configured">
          {preconfiguredList.map(({ key, service }) => (
            <BrokerRow
              key={key}
              service={service}
              preferred={isPreferred(service)}
              onOpen={() => navigateToClient(service)}
              onPrefer={() => setPreferred(service)}
            />
          ))}
        </BrokerSection>

        {showDiscoveredSection ? (
          <BrokerSection title="Discovered">
            {upstreamDiscoveredList.length > 0 ? (
              <DiscoveredSubsection title="Upstream WiFi">
                {upstreamDiscoveredList.map(({ key, service }) => (
                  <BrokerRow
                    key={key}
                    service={service}
                    preferred={isPreferred(service)}
                    resolved={service.resolved}
                    connectReady={isBrokerConnectReady(service)}
                    onOpen={() => navigateToClient(service)}
                    onPrefer={() => setPreferred(service)}
                  />
                ))}
              </DiscoveredSubsection>
            ) : null}
            {hotspotDiscoveryActive ? (
              <DiscoveredSubsection title="Hotspot">
                {hotspotDiscoveredList.length > 0 ? (
                  hotspotDiscoveredList.map(({ key, service }) => (
                    <BrokerRow
                      key={key}
                      service={service}
                      preferred={isPreferred(service)}
                      resolved={service.resolved}
                      connectReady={isBrokerConnectReady(service)}
                      onOpen={() => navigateToClient(service)}
                      onPrefer={() => setPreferred(service)}
                    />
                  ))
                ) : (
                  <Text style={styles.discoveredEmptyHint}>Scanning hotspot…</Text>
                )}
              </DiscoveredSubsection>
            ) : null}
          </BrokerSection>
        ) : null}

        <BrokerSection title="Manual">
          {manualList.map(({ key, service }) => (
            <BrokerRow
              key={key}
              service={service}
              preferred={isPreferred(service)}
              onOpen={() => navigateToClient(service)}
              onPrefer={() => setPreferred(service)}
              onRemove={() => removeManualBroker(service)}
            />
          ))}
          <View style={styles.manualForm}>
            <TextInput
              style={styles.input}
              placeholder="Host / IP"
              value={manualHost}
              onChangeText={setManualHost}
              autoCapitalize="none"
            />
            <View style={styles.manualRow}>
              <TextInput
                style={[styles.input, styles.portInput]}
                placeholder="Port"
                value={manualPort}
                onChangeText={setManualPort}
                keyboardType="number-pad"
              />
              <View style={styles.typePicker}>
                <Pressable
                  style={[styles.typeOption, selectedType === '_mqtt-ws._tcp.' && styles.typeSelected]}
                  onPress={() => setSelectedType('_mqtt-ws._tcp.')}>
                  <Text>WS</Text>
                </Pressable>
                <Pressable
                  style={[styles.typeOption, selectedType === '_mqtt-wss._tcp.' && styles.typeSelected]}
                  onPress={() => setSelectedType('_mqtt-wss._tcp.')}>
                  <Text>WSS</Text>
                </Pressable>
              </View>
            </View>
            {selectedType === '_mqtt-wss._tcp.' ? (
              <View style={styles.tlsRow}>
                <Switch
                  value={manualRejectUnauthorized}
                  onValueChange={setManualRejectUnauthorized}
                />
                <Text style={styles.tlsLabel}>Verify TLS</Text>
              </View>
            ) : null}
            <Pressable style={[styles.btn, styles.btnPrimary]} onPress={addManualService}>
              <Text style={styles.btnText}>Add</Text>
            </Pressable>
          </View>
        </BrokerSection>

        {preconfiguredList.length === 0 &&
        !showDiscoveredSection &&
        manualList.length === 0 ? (
          <Text style={styles.empty}>No brokers available.</Text>
        ) : null}

        <View style={styles.footer}>
          <Pressable onPress={() => openLink(PRIVACY_POLICY_URL)}>
            <Text style={styles.footerLink}>Privacy Policy</Text>
          </Pressable>
          <Text style={styles.footerSep}> · </Text>
          <Pressable onPress={() => openLink(SUPPORT_URL)}>
            <Text style={styles.footerLink}>Support</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

function BrokerSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function DiscoveredSubsection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.discoveredSubsection}>
      <Text style={styles.discoveredSubsectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function BrokerRow({
  service,
  preferred,
  resolved,
  connectReady,
  onOpen,
  onPrefer,
  onRemove,
}: {
  service: ServiceEntry;
  preferred: boolean;
  resolved?: boolean;
  connectReady?: boolean;
  onOpen: () => void;
  onPrefer: () => void;
  onRemove?: () => void;
}) {
  const endpointHost = pickConnectHost(service);
  const canOpen = connectReady ?? isBrokerConnectReady(service);

  return (
    <View style={[styles.brokerRow, preferred && styles.brokerRowPreferred]}>
      <View style={styles.brokerInfo}>
        {resolved !== undefined ? (
          <View style={[styles.tinyDot, resolved ? styles.dotResolved : styles.dotPending]} />
        ) : null}
        <Text style={styles.brokerName} numberOfLines={1}>
          {service.name}
        </Text>
        <Text style={styles.monoSmall}>
          {endpointHost}:{service.port || '…'}
        </Text>
      </View>
      <View style={styles.rowActions}>
        <Pressable
          style={[styles.iconBtn, !canOpen && styles.iconBtnDisabled]}
          onPress={canOpen ? onOpen : undefined}
          disabled={!canOpen}>
          <Text style={styles.iconBtnText}>→</Text>
        </Pressable>
        {!preferred ? (
          <Pressable style={styles.iconBtn} onPress={onPrefer}>
            <Text style={styles.iconBtnText}>☆</Text>
          </Pressable>
        ) : (
          <Text style={styles.starFilled}>★</Text>
        )}
        {onRemove ? (
          <Pressable style={styles.iconBtn} onPress={onRemove}>
            <Text style={styles.removeText}>×</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  scroll: { gap: 8 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 18, fontWeight: '700', color: Colors.text, flex: 1 },
  expoGoBanner: {
    fontSize: 11,
    color: '#B45309',
    backgroundColor: '#FFFBEB',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#FDE68A',
    marginBottom: 4,
  },
  preferredCard: {
    borderWidth: 2,
    borderColor: '#BFDBFE',
    borderRadius: 12,
    padding: 12,
    backgroundColor: '#EFF6FF',
    gap: 8,
  },
  preferredConnected: { borderColor: Colors.success, backgroundColor: '#F0FDF4' },
  preferredTrying: { borderColor: Colors.warning, backgroundColor: '#FFFBEB' },
  preferredHeader: { flexDirection: 'row', gap: 10 },
  stateDot: { width: 14, height: 14, borderRadius: 7, backgroundColor: '#D1D5DB', marginTop: 4 },
  stateDotConnected: { backgroundColor: Colors.success },
  stateDotTrying: { backgroundColor: Colors.warning },
  flex: { flex: 1 },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
  preferredName: { fontSize: 14, fontWeight: '700', color: Colors.text },
  sourceBadge: {
    fontSize: 10,
    fontWeight: '600',
    color: '#fff',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    overflow: 'hidden',
  },
  badgePrimary: { backgroundColor: Colors.primary },
  badgeSuccess: { backgroundColor: Colors.success },
  badgeWarning: { backgroundColor: Colors.warning },
  monoMuted: { fontSize: 12, color: Colors.textMuted, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) },
  typeChip: { backgroundColor: '#F3F4F6', paddingHorizontal: 6, borderRadius: 4, fontSize: 10 },
  notFound: {
    marginTop: 4,
    fontSize: 10,
    fontWeight: '600',
    color: '#B45309',
    backgroundColor: '#FFFBEB',
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  credRow: { flexDirection: 'row', gap: 8, marginTop: 8 },
  inputSmall: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    fontSize: 12,
    backgroundColor: Colors.surface,
  },
  tlsRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  tlsLabel: { fontSize: 12, color: Colors.textMuted },
  actionRow: { flexDirection: 'row', gap: 8 },
  btn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnDisabled: { opacity: 0.6 },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 12 },
  btnPrimary: { backgroundColor: Colors.primary },
  btnSuccess: { backgroundColor: Colors.success },
  btnWarning: { backgroundColor: Colors.warning },
  btnClear: { backgroundColor: Colors.surface, borderWidth: 1, borderColor: '#FECACA' },
  btnClearText: { color: Colors.error, fontWeight: '600', fontSize: 12 },
  testResult: { fontSize: 12, fontWeight: '600', padding: 8, borderRadius: 6 },
  testPass: { backgroundColor: '#DCFCE7', color: Colors.success },
  testFail: { backgroundColor: '#FEE2E2', color: Colors.error },
  section: { gap: 4, marginTop: 4 },
  sectionTitle: {
    fontSize: 10,
    fontWeight: '700',
    color: Colors.textLight,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: 4,
  },
  discoveredSubsection: { gap: 4, marginTop: 6 },
  discoveredSubsectionTitle: {
    fontSize: 10,
    fontWeight: '600',
    color: Colors.textMuted,
    paddingHorizontal: 8,
    paddingTop: 2,
  },
  discoveredEmptyHint: {
    fontSize: 13,
    color: Colors.textMuted,
    fontStyle: 'italic',
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  brokerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Colors.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  brokerRowPreferred: { borderColor: Colors.preferredBorder, borderWidth: 2 },
  brokerInfo: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 },
  tinyDot: { width: 6, height: 6, borderRadius: 3 },
  dotResolved: { backgroundColor: Colors.success },
  dotPending: { backgroundColor: Colors.warning },
  brokerName: { fontSize: 14, fontWeight: '600', color: Colors.text, flexShrink: 1 },
  monoSmall: {
    fontSize: 10,
    color: Colors.textLight,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
  },
  rowActions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  iconBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F9FAFB',
  },
  iconBtnDisabled: { opacity: 0.35 },
  iconBtnText: { color: Colors.primary, fontSize: 16, fontWeight: '700' },
  starFilled: { color: Colors.warning, fontSize: 16, width: 32, textAlign: 'center' },
  removeText: { color: Colors.error, fontSize: 18, fontWeight: '700' },
  manualForm: {
    backgroundColor: Colors.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 8,
    gap: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    backgroundColor: Colors.surface,
  },
  manualRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  portInput: { width: 80 },
  typePicker: { flexDirection: 'row', gap: 4, flex: 1 },
  typeOption: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 6,
  },
  typeSelected: { borderColor: Colors.primary, backgroundColor: '#EFF6FF' },
  empty: { textAlign: 'center', color: Colors.textLight, fontSize: 14, paddingVertical: 32 },
  footer: { flexDirection: 'row', justifyContent: 'center', marginTop: 24 },
  footerLink: { fontSize: 10, color: Colors.textLight, textDecorationLine: 'underline' },
  footerSep: { fontSize: 10, color: Colors.textLight },
});
