import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Colors } from '@/constants/colors';
import { useMqttConnection } from '@/hooks/use-mqtt-connection';
import { useScreenInsets } from '@/hooks/use-screen-insets';

export default function ClientScreen() {
  const mqttConn = useMqttConnection();
  const screenInsets = useScreenInsets();
  const [publishTopic, setPublishTopic] = useState('test/topic');
  const [publishMessage, setPublishMessage] = useState('Hello, MQTT!');

  const broker = mqttConn.connectedBroker;

  useEffect(() => {
    if (!broker) return;
    mqttConn.clearMessages();
    mqttConn.addMessage('system', `Configured for ${broker.name}`);
    if (
      mqttConn.connectionState === 'disconnected' &&
      !mqttConn.isTrying &&
      !mqttConn.isTestInFlight
    ) {
      mqttConn.connect(broker);
    }
  }, [broker?.name, broker?.host, broker?.port, broker?.type]);

  if (!broker) {
    return (
      <View style={[styles.safe, styles.emptyWrap, { paddingTop: screenInsets.paddingTop, paddingHorizontal: screenInsets.paddingRight }]}>
        <Text style={styles.emptyTitle}>No broker selected</Text>
        <Text style={styles.emptyHint}>Pick a broker on the Scanner tab to connect.</Text>
      </View>
    );
  }

  const publishMessageToTopic = async () => {
    if (!mqttConn.isConnected || !publishTopic || !publishMessage) return;
    try {
      await mqttConn.publish(publishTopic, publishMessage);
    } catch {
      /* error set in hook */
    }
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
          <View style={styles.titleRow}>
            <View
              style={[
                styles.statusDot,
                mqttConn.isTrying && styles.statusTrying,
                mqttConn.isConnected && styles.statusConnected,
                !mqttConn.isConnected && !mqttConn.isTrying && styles.statusDisconnected,
              ]}
            />
            <Text style={styles.title} numberOfLines={1}>
              {broker.name}
            </Text>
          </View>
          <Pressable
            style={[
              styles.btn,
              mqttConn.isConnected ? styles.btnDanger : styles.btnPrimary,
              mqttConn.isTrying && styles.btnDisabled,
            ]}
            onPress={() =>
              mqttConn.isConnected ? mqttConn.disconnect() : mqttConn.connect(broker)
            }
            disabled={mqttConn.isTrying}>
            <Text style={styles.btnText}>
              {mqttConn.isConnected
                ? 'Disconnect'
                : mqttConn.isTrying
                  ? 'Connecting…'
                  : 'Connect'}
            </Text>
          </Pressable>
        </View>

        <Text style={styles.url}>{mqttConn.brokerUrl}</Text>

        {mqttConn.error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{mqttConn.error}</Text>
            <Pressable onPress={() => mqttConn.setError(null)}>
              <Text style={styles.dismiss}>×</Text>
            </Pressable>
          </View>
        ) : null}

        {mqttConn.isTrying ? (
          <View style={styles.connectingBox}>
            <ActivityIndicator color={Colors.primary} />
            <Text style={styles.connectingText}>Connecting…</Text>
          </View>
        ) : null}

        {mqttConn.isConnected ? (
          <View style={styles.publishBox}>
            <Text style={styles.sectionHeading}>Publish</Text>
            <TextInput
              style={styles.input}
              placeholder="Topic"
              value={publishTopic}
              onChangeText={setPublishTopic}
              autoCapitalize="none"
            />
            <TextInput
              style={[styles.input, styles.textArea]}
              placeholder="Payload"
              value={publishMessage}
              onChangeText={setPublishMessage}
              multiline
              numberOfLines={2}
            />
            <Pressable style={[styles.btn, styles.btnSuccess]} onPress={publishMessageToTopic}>
              <Text style={styles.btnText}>Publish →</Text>
            </Pressable>
          </View>
        ) : null}

        <View style={styles.messagesBox}>
          <View style={styles.messagesHeader}>
            <Text style={styles.sectionHeading}>
              Messages <Text style={styles.count}>({mqttConn.messages.length})</Text>
            </Text>
            <Pressable onPress={mqttConn.clearMessages}>
              <Text style={styles.clearBtn}>Clear</Text>
            </Pressable>
          </View>

          {mqttConn.messages.length === 0 ? (
            <Text style={styles.waitHint}>
              {mqttConn.isConnected ? 'Waiting for messages…' : 'Connect to start receiving'}
            </Text>
          ) : (
            mqttConn.messages.map((message) => (
              <View
                key={message.id}
                style={[styles.message, message.topic === 'system' && styles.systemMessage]}>
                <View style={styles.messageMeta}>
                  <Text style={message.topic === 'system' ? styles.sysLabel : styles.topicLabel}>
                    {message.topic === 'system' ? 'SYS' : message.topic}
                  </Text>
                  <Text style={styles.timestamp}>{message.timestamp}</Text>
                </View>
                <Text style={styles.payload}>{message.payload}</Text>
              </View>
            ))
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  scroll: { gap: 10 },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: Colors.text },
  emptyHint: { marginTop: 8, fontSize: 14, color: Colors.textMuted, textAlign: 'center' },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  titleRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  statusConnected: { backgroundColor: Colors.success },
  statusTrying: { backgroundColor: Colors.warning },
  statusDisconnected: { backgroundColor: Colors.error },
  title: { fontSize: 18, fontWeight: '700', color: Colors.text, flex: 1 },
  url: { fontSize: 10, color: Colors.textLight, fontFamily: 'monospace' },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#FEE2E2',
    borderWidth: 1,
    borderColor: '#FECACA',
    borderRadius: 8,
    padding: 8,
  },
  errorText: { flex: 1, color: Colors.error, fontSize: 12 },
  dismiss: { color: Colors.error, fontSize: 20, paddingHorizontal: 8 },
  connectingBox: {
    alignItems: 'center',
    padding: 16,
    backgroundColor: Colors.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.border,
    gap: 8,
  },
  connectingText: { color: Colors.textMuted, fontSize: 14 },
  publishBox: {
    backgroundColor: Colors.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 12,
    gap: 8,
  },
  sectionHeading: { fontSize: 14, fontWeight: '700', color: Colors.text },
  input: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 12,
    fontFamily: 'monospace',
  },
  textArea: { minHeight: 56, textAlignVertical: 'top' },
  messagesBox: {
    backgroundColor: Colors.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 8,
    minHeight: 280,
    gap: 6,
  },
  messagesHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  count: { color: Colors.primary, fontFamily: 'monospace' },
  clearBtn: { fontSize: 10, fontWeight: '700', color: Colors.textLight, textTransform: 'uppercase' },
  waitHint: { textAlign: 'center', color: Colors.textLight, fontSize: 12, paddingVertical: 24 },
  message: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 6,
    padding: 8,
    backgroundColor: Colors.surface,
  },
  systemMessage: { backgroundColor: '#F9FAFB', borderLeftWidth: 3, borderLeftColor: '#9CA3AF' },
  messageMeta: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  topicLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: Colors.primary,
    backgroundColor: '#EFF6FF',
    paddingHorizontal: 6,
    borderRadius: 4,
    overflow: 'hidden',
  },
  sysLabel: { fontSize: 10, fontWeight: '700', color: Colors.textLight, textTransform: 'uppercase' },
  timestamp: { fontSize: 10, color: '#D1D5DB', fontFamily: 'monospace' },
  payload: {
    fontSize: 11,
    fontFamily: 'monospace',
    color: Colors.text,
    backgroundColor: '#F9FAFB',
    padding: 6,
    borderRadius: 4,
  },
  btn: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, alignItems: 'center' },
  btnPrimary: { backgroundColor: Colors.primary },
  btnDanger: { backgroundColor: Colors.error },
  btnSuccess: { backgroundColor: Colors.success, alignSelf: 'flex-end' },
  btnDisabled: { backgroundColor: '#E5E7EB' },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 12 },
});
