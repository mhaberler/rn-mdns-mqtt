export type BrokerSource = 'preconfigured' | 'discovered' | 'manual';

export type DiscoverySegment = 'upstream' | 'hotspot';

export type ServiceEntry = {
  name: string;
  type: string;
  host: string;
  port: number;
  domain?: string;
  discovered?: boolean;
  resolved?: boolean;
  txtRecord?: Record<string, string>;
  ipv4Addresses?: string[];
  ipv6Addresses?: string[];
  source?: BrokerSource;
  discoverySegment?: DiscoverySegment;
  username?: string;
  password?: string;
  rejectUnauthorized?: boolean;
  tested?: boolean;
};

export type ConnectionState = 'disconnected' | 'trying' | 'connected';

export type MessageItem = {
  id: string;
  topic: string;
  payload: string;
  timestamp: string;
};
