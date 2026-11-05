import type { FlowBridge } from "../preload/bridge.js";

declare global {
  interface Window {
    readonly flow: FlowBridge;
  }
}
