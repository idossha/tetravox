export interface SceneRequest {
  protocol: 1;
  id: string;
  action: 'open-scene' | 'save-scene';
  path: string;
  expectedScenePath?: string;
  overwrite?: boolean;
}
export interface SceneSnapshot {
  scenePath?: string;
  text?: string;
}
export interface SceneReceipt {
  protocol: 1;
  id: string;
  ok: boolean;
  path?: string;
  error?: string;
}
