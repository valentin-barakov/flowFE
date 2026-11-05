import type { CommandChannel, FlowEvent, InputOf, OutputOf, Result } from "../shared/ipc.js";

/** The only object the preload puts on window. */
export type FlowBridge = {
  invoke: <C extends CommandChannel>(channel: C, input: InputOf<C>) => Promise<Result<OutputOf<C>>>;
  onEvent: (listener: (event: FlowEvent) => void) => () => void;
};
