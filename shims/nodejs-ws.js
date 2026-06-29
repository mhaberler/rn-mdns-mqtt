/** Stub for mqtt's Node `ws` import — RN uses browserStreamBuilder (global WebSocket). */
function unavailable() {
  throw new Error('Node ws transport is not available in React Native');
}

class WebSocketStub {
  constructor() {
    unavailable();
  }
}

WebSocketStub.createWebSocketStream = unavailable;

module.exports = WebSocketStub;
module.exports.default = WebSocketStub;
