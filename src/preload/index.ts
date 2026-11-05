import { contextBridge, ipcRenderer } from "electron";
import { EVENT_CHANNEL, EventSchema, failure, isCommandChannel, type OutputOf, type Result } from "../shared/ipc.js";
import type { FlowBridge } from "./bridge.js";

const bridge: FlowBridge = {
  invoke(channel, input) {
    if (!isCommandChannel(channel)) return Promise.resolve(failure("not_allowed", "Unknown command", false));
    return ipcRenderer.invoke(channel, input) as Promise<Result<OutputOf<typeof channel>>>;
  },
  onEvent(listener) {
    const wrapped = (_event: unknown, payload: unknown) => {
      const parsed = EventSchema.safeParse(payload);
      if (parsed.success) listener(parsed.data);
    };
    ipcRenderer.on(EVENT_CHANNEL, wrapped);
    return () => {
      ipcRenderer.removeListener(EVENT_CHANNEL, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld("flow", bridge);
