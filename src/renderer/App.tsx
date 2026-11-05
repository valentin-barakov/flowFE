import { useEffect, useReducer, useRef, useState } from "react";
import type { Answers, FlowEvent, Theme } from "../shared/ipc.js";
import { Chat } from "./Chat.js";
import { Instructions } from "./Instructions.js";
import { Setup } from "./Setup.js";
import { bannerFor, initialState, reducer, screenOf, type Banner } from "./state.js";

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [pending, setPending] = useState(false);
  const [modelEpoch, setModelEpoch] = useState(0);
  const hold = useRef(true);
  const pendingEvents = useRef<FlowEvent[]>([]);
  const viewToken = useRef(0);
  const screen = screenOf(state);

  useEffect(() => {
    const theme = state.settings?.theme ?? "system";
    document.documentElement.style.colorScheme = theme === "system" ? "light dark" : theme;
    document.documentElement.dataset.theme = theme;
  }, [state.settings?.theme]);

  useEffect(() => {
    let cancelled = false;
    const onEvent = (event: FlowEvent) => {
      if (cancelled) return;
      if (hold.current) pendingEvents.current.push(event);
      else dispatchEvent(event);
    };
    const unsubscribe = window.flow.onEvent(onEvent);
    void (async () => {
      const [settings, history, chat] = await Promise.all([
        window.flow.invoke("flow:settings.get", {}),
        window.flow.invoke("flow:chat.history", {}),
        window.flow.invoke("flow:chat.state", {}),
      ]);
      if (cancelled) return;
      if (!settings.ok || !history.ok || !chat.ok) {
        dispatch({
          type: "loaded",
          settings: settings.ok
            ? settings.value
            : { folder: null, model: null, theme: "system", keySet: false, folderMissing: false, setupComplete: false },
          messages: history.ok ? history.value.messages : [],
          chatState: chat.ok ? chat.value.state : "needsSetup",
          ...(chat.ok && chat.value.runId ? { runId: chat.value.runId } : {}),
          instructionsPending: chat.ok ? chat.value.instructionsPending : false,
          ...(chat.ok && chat.value.pendingQuestion ? { pendingQuestion: chat.value.pendingQuestion } : {}),
        });
        hold.current = false;
        return;
      }
      const queued = pendingEvents.current.splice(0);
      hold.current = false;
      dispatch({
        type: "loaded",
        settings: settings.value,
        messages: history.value.messages,
        chatState: chat.value.state,
        ...(chat.value.runId ? { runId: chat.value.runId } : {}),
        instructionsPending: chat.value.instructionsPending,
        ...(chat.value.pendingQuestion ? { pendingQuestion: chat.value.pendingQuestion } : {}),
      });
      for (const event of queued) dispatchEvent(event);
    })();
    return () => {
      cancelled = true;
      unsubscribe();
      hold.current = true;
      pendingEvents.current = [];
    };
  }, []);

  useEffect(() => {
    if (!state.settings?.keySet || (screen !== "setup" && screen !== "chat")) return;
    let cancelled = false;
    void window.flow.invoke("flow:models.list", {}).then((result) => {
      if (cancelled) return;
      if (result.ok) dispatch({ type: "models", models: result.value.models });
      else dispatch({ type: "models-error", message: result.error.message, code: result.error.code });
    });
    return () => {
      cancelled = true;
    };
  }, [state.settings?.keySet, screen, modelEpoch]);

  function dispatchEvent(event: FlowEvent): void {
    dispatch({ type: "event", event });
    if (event.type === "chat.done" || event.type === "chat.error") {
      const token = viewToken.current;
      void reloadHistory(token);
    }
  }

  async function reloadHistory(token: number): Promise<void> {
    const history = await window.flow.invoke("flow:chat.history", {});
    if (token !== viewToken.current) return;
    if (history.ok) dispatch({ type: "history", messages: history.value.messages });
  }

  async function saveSettings(partial: { folder?: string; model?: string; theme?: Theme }): Promise<boolean> {
    setPending(true);
    const result = await window.flow.invoke("flow:settings.save", partial);
    setPending(false);
    if (!result.ok) {
      dispatch({ type: "models-error", message: result.error.message, code: result.error.code });
      dispatch({ type: "banner", banner: bannerFrom(result.error) });
      return false;
    }
    dispatch({ type: "settings", settings: result.value });
    return true;
  }

  async function saveKey(key: string): Promise<boolean> {
    setPending(true);
    const result = await window.flow.invoke("flow:key.set", { key });
    setPending(false);
    if (!result.ok) {
      dispatch({ type: "models-error", message: result.error.message, code: result.error.code });
      dispatch({ type: "banner", banner: bannerFrom(result.error) });
      return false;
    }
    const settings = await window.flow.invoke("flow:settings.get", {});
    if (settings.ok) dispatch({ type: "settings", settings: settings.value });
    setModelEpoch((epoch) => epoch + 1);
    return true;
  }

  async function clearKey(): Promise<void> {
    setPending(true);
    const result = await window.flow.invoke("flow:key.clear", {});
    setPending(false);
    if (!result.ok) {
      dispatch({ type: "models-error", message: result.error.message, code: result.error.code });
      dispatch({ type: "banner", banner: bannerFrom(result.error) });
      return;
    }
    dispatch({ type: "models", models: [] });
    const settings = await window.flow.invoke("flow:settings.get", {});
    if (settings.ok) dispatch({ type: "settings", settings: settings.value });
  }

  async function pickFolder(): Promise<void> {
    viewToken.current += 1;
    setPending(true);
    const picked = await window.flow.invoke("flow:folder.pick", {});
    if (!picked.ok) {
      setPending(false);
      dispatch({ type: "models-error", message: picked.error.message, code: picked.error.code });
      dispatch({ type: "banner", banner: bannerFrom(picked.error) });
      return;
    }
    if (picked.value.folder === null) {
      setPending(false);
      return;
    }
    const saved = await window.flow.invoke("flow:settings.save", { folder: picked.value.folder });
    setPending(false);
    if (!saved.ok) {
      dispatch({ type: "models-error", message: saved.error.message, code: saved.error.code });
      dispatch({ type: "banner", banner: bannerFrom(saved.error) });
      return;
    }
    dispatch({ type: "settings", settings: saved.value });
    const history = await window.flow.invoke("flow:chat.history", {});
    const chat = await window.flow.invoke("flow:chat.state", {});
    if (history.ok) dispatch({ type: "history", messages: history.value.messages });
    if (chat.ok) {
      dispatch({ type: "event", event: { type: "chat.state", runId: chat.value.runId ?? "session", state: chat.value.state } });
      dispatch({ type: "instructions-pending", pending: chat.value.instructionsPending });
    }
  }

  async function send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed === "") return;
    hold.current = true;
    dispatch({ type: "sending", text: trimmed });
    setPending(true);
    const result = await window.flow.invoke("flow:chat.send", { text: trimmed });
    if (!result.ok) {
      const [history, chat] = await Promise.all([
        window.flow.invoke("flow:chat.history", {}),
        window.flow.invoke("flow:chat.state", {}),
      ]);
      const queued = pendingEvents.current.splice(0);
      hold.current = false;
      setPending(false);
      const messages = history.ok ? history.value.messages : [];
      const kept = messages.some((message) => message.role === "user" && message.text === trimmed);
      dispatch({
        type: "send-failed",
        messages,
        chatState: chat.ok ? chat.value.state : "ready",
        banner: bannerFrom(result.error),
      });
      if (!kept) dispatch({ type: "draft", draft: trimmed });
      if (chat.ok) dispatch({ type: "instructions-pending", pending: chat.value.instructionsPending });
      for (const event of queued) dispatchEvent(event);
      return;
    }
    const queued = pendingEvents.current.splice(0);
    hold.current = false;
    setPending(false);
    dispatch({
      type: "run-started",
      runId: result.value.runId,
      userMessageId: result.value.userMessageId,
      agentMessageId: result.value.agentMessageId,
      text: trimmed,
      restored: result.value.restored,
    });
    for (const event of queued) dispatchEvent(event);
  }

  async function refreshInstructions(): Promise<boolean> {
    const chat = await window.flow.invoke("flow:chat.state", {});
    if (!chat.ok) return false;
    dispatch({ type: "instructions-pending", pending: chat.value.instructionsPending });
    return chat.value.instructionsPending;
  }

  async function answer(questionId: string, answers: Answers): Promise<string | null> {
    const result = await window.flow.invoke("flow:question.answer", { questionId, answers });
    if (!result.ok) return result.error.message;
    dispatch({ type: "question-settled", questionId, answers, skipped: false });
    return null;
  }

  async function skip(questionId: string): Promise<string | null> {
    const result = await window.flow.invoke("flow:question.skip", { questionId });
    if (!result.ok) return result.error.message;
    dispatch({ type: "question-settled", questionId, answers: null, skipped: true });
    return null;
  }

  async function newChat(): Promise<void> {
    viewToken.current += 1;
    setPending(true);
    const result = await window.flow.invoke("flow:chat.reset", {});
    setPending(false);
    if (!result.ok) {
      dispatch({ type: "banner", banner: bannerFrom(result.error) });
      return;
    }
    dispatch({ type: "reset-chat" });
  }

  async function stop(): Promise<void> {
    setPending(true);
    const result = await window.flow.invoke("flow:chat.stop", {});
    setPending(false);
    if (!result.ok) dispatch({ type: "banner", banner: bannerFrom(result.error) });
  }

  const settings = state.settings;
  return (
    <div className="app">
      <div className="stripe" />
      {screen === "loading" || settings === null ? (
        <p className="loading">Opening…</p>
      ) : screen === "setup" ? (
        <>
          {state.banner ? <BannerView banner={state.banner} onDismiss={() => dispatch({ type: "dismiss-banner" })} /> : null}
          <Setup
            settings={settings}
            models={state.models}
            modelsError={state.modelsError}
            pending={pending}
            onSaveKey={saveKey}
            onClearKey={clearKey}
            onPickFolder={pickFolder}
            onModel={(model) => saveSettings({ model })}
            onTheme={(theme) => void saveSettings({ theme })}
            onBack={settings.setupComplete ? () => dispatch({ type: "close-setup" }) : null}
          />
        </>
      ) : (
        screen === "instructions" ? (
        <Instructions
          banner={state.banner}
          canRetry={state.banner?.retryable === true && state.lastUserText !== null && (state.chatState === "ready" || state.chatState === "needsSetup")}
          onBack={() => dispatch({ type: "close-instructions" })}
          onChanged={refreshInstructions}
          onDismiss={() => dispatch({ type: "dismiss-banner" })}
          onRetry={() => {
            if (state.lastUserText) void send(state.lastUserText);
          }}
          onSetup={() => dispatch({ type: "edit-setup" })}
        />
      ) : (
        <Chat
          folder={settings.folder ?? ""}
          model={settings.model ?? ""}
          models={state.models}
          theme={settings.theme}
          items={state.items}
          chatState={state.chatState}
          draft={state.draft}
          notice={state.notice}
          banner={state.banner}
          pending={pending}
          onDraft={(draft) => dispatch({ type: "draft", draft })}
          onSend={() => void send(state.draft)}
          onStop={() => void stop()}
          onTheme={(theme) => void saveSettings({ theme })}
          onModel={(model) => saveSettings({ model })}
          onReset={() => void newChat()}
          canRetry={state.banner?.retryable === true && state.lastUserText !== null && (state.chatState === "ready" || state.chatState === "needsSetup")}
          instructionsPending={state.instructionsPending}
          onSetup={() => dispatch({ type: "edit-setup" })}
          onInstructions={() => dispatch({ type: "open-instructions" })}
          onDismiss={() => dispatch({ type: "dismiss-banner" })}
          onRetry={() => {
            if (state.lastUserText) void send(state.lastUserText);
          }}
          onBannerSetup={() => dispatch({ type: "edit-setup" })}
          onAnswer={answer}
          onSkip={skip}
        />
        )
      )}
    </div>
  );
}

function BannerView({ banner, onDismiss }: { banner: Banner; onDismiss: () => void }) {
  return (
    <div className="banners">
      <div className="banner" role="status">
        <strong>{banner.title}</strong>
        {banner.body}
        <span className="actions">
          <button type="button" className="btn" onClick={onDismiss}>
            Dismiss
          </button>
        </span>
      </div>
    </div>
  );
}

function bannerFrom(error: { code: string; message: string; retryable: boolean }): Banner {
  return bannerFor(error.code, error.message, error.retryable);
}
