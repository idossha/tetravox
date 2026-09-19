export interface TiSceneRequest {
  protocol: 1;
  id: string;
  nonce: string;
  action: 'open-scene' | 'save-scene';
  scenePath: string;
  destination?: string;
}
export interface TiSceneSnapshot {
  scenePath: string;
  text?: string;
}
export interface TiSceneReceipt {
  protocol: 1;
  id: string;
  nonce: string;
  ok: boolean;
  path?: string;
  error?: string;
}
