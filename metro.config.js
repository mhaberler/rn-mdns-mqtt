const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// mqtt's react-native export resolves to dist/mqtt.esm.js (browser-only transports).
// Patched CJS build in build/ registers native mqtt/mqtts over react-native-tcp-socket.
const mqttBuildEntry = path.resolve(__dirname, 'node_modules/mqtt/build/index.js');
const nodeWsStub = path.resolve(__dirname, 'shims/nodejs-ws.js');

config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  stream: require.resolve('readable-stream'),
};

const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'mqtt') {
    return {
      filePath: mqttBuildEntry,
      type: 'sourceFile',
    };
  }
  if (moduleName === 'ws') {
    return {
      filePath: nodeWsStub,
      type: 'sourceFile',
    };
  }
  if (defaultResolveRequest) {
    return defaultResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
