import { useEffect, useReducer, useRef, useState } from "react";
import { BUSY_CAP_MESSAGE, MAX_BUSY_REPOS, busyRepoMessage, type AgentMode, type Answers, type ChatStateName, type FlowEvent, type Settings, type Theme } from "../shared/ipc.js";
import { parseMention } from "../shared/mention.js";
import { Chat } from "./Chat.js";
import { Instructions } from "./Instructions.js";
import { NewChat } from "./NewChat.js";
import { RepoSidebar } from "./RepoSidebar.js";
import { Setup } from "./Setup.js";
import { anyBusy, bannerFor, busyRepoNames, canRetry, emptySlice, initialState, isBusyState, reducer, screenOf, shouldLeaveAfterReset, sidebarRows, type Banner } from "./state.js";

type HeldEvents = { hold: boolean; events: FlowEvent[] };

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [pending, setPending] = useState(false);
  const [modelEpoch, setModelEpoch] = useState(0);
  const bootHold = useRef<HeldEvents>({ hold: true, events: [] });
  const holds = useRef<Map<string, HeldEvents>>(new Map());
  const loadTokens = useRef<Map<string, number>>(new Map());
  const stateRef = useRef(state);
  stateRef.current = state;
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
      if (bootHold.current.hold) {
        bootHold.current.events.push(event);
        return;
      }
      const box = holds.current.get(event.repo);
      if (box?.hold) {
        box.events.push(event);
        return;
      }
      dispatchEvent(event);
    };
    const unsubscribe = window.flow.onEvent(onEvent);
    void (async () => {
      const [settings, listed] = await Promise.all([
        window.flow.invoke("flow:settings.get", {}),
        window.flow.invoke("flow:repos.list", {}),
      ]);
      if (cancelled) return;
      if (!settings.ok) {
        dispatch({
          type: "boot-failed",
          settings: {
            folder: null,
            model: null,
            mode: "agent",
            theme: "system",
            keySet: false,
            folderMissing: false,
            setupComplete: false,
          },
        });
        drainHold(bootHold.current);
        return;
      }
      const repos = listed.ok ? listed.value.repos : [];
      if (repos.length === 1 && repos[0] !== undefined) {
        const repo = repos[0].name;
        const [history, chat] = await Promise.all([
          window.flow.invoke("flow:chat.history", { repo }),
          window.flow.invoke("flow:chat.state", { repo }),
        ]);
        if (cancelled) return;
        dispatch({
          type: "boot",
          settings: settings.value,
          repos,
          view: { kind: "repo", repo },
          repo,
          messages: history.ok ? history.value.messages : [],
          chatState: chat.ok ? chat.value.state : "needsSetup",
          ...(chat.ok && chat.value.runId ? { runId: chat.value.runId } : {}),
          instructionsPending: chat.ok ? chat.value.instructionsPending : false,
          ...(chat.ok && chat.value.pendingQuestion ? { pendingQuestion: chat.value.pendingQuestion } : {}),
        });
      } else {
        dispatch({
          type: "boot",
          settings: settings.value,
          repos,
          view: { kind: "home" },
        });
      }
      if (cancelled) return;
      flushHold(bootHold.current);
    })();
    return () => {
      cancelled = true;
      unsubscribe();
      bootHold.current.hold = true;
      bootHold.current.events.splice(0);
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

  useEffect(() => {
    if (screen !== "home") return;
    let cancelled = false;
    void refreshRepos(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [screen]);

  function bucket(repo: string): HeldEvents {
    const current = holds.current.get(repo);
    if (current !== undefined) return current;
    const created: HeldEvents = { hold: false, events: [] };
    holds.current.set(repo, created);
    return created;
  }

  function dispatchEvent(event: FlowEvent): void {
    dispatch({ type: "event", event });
    if (event.type !== "chat.done" && event.type !== "chat.error") return;
    const token = loadTokens.current.get(event.repo);
    void reloadHistory(event.repo, token);
  }

  function drainHold(box: HeldEvents): FlowEvent[] {
    const queued = box.events.splice(0);
    box.hold = false;
    return queued;
  }

  function replayHold(events: readonly FlowEvent[]): void {
    for (const event of events) dispatchEvent(event);
  }

  function flushHold(box: HeldEvents): void {
    replayHold(drainHold(box));
  }

  async function reloadHistory(repo: string, token: number | undefined): Promise<void> {
    const history = await window.flow.invoke("flow:chat.history", { repo });
    if (loadTokens.current.get(repo) !== token) return;
    if (history.ok) dispatch({ type: "history", repo, messages: history.value.messages });
  }

  function currentRepo(): string | null {
    return stateRef.current.view.kind === "repo" ? stateRef.current.view.repo : null;
  }

  function reportBanner(banner: Banner): void {
    const repo = currentRepo();
    if (repo === null) return;
    dispatch({ type: "banner", repo, banner });
  }

  function releaseHold(drop: boolean): void {
    if (drop) {
      drainHold(bootHold.current);
      return;
    }
    flushHold(bootHold.current);
  }

  function invalidateRepoLoads(): void {
    const names = new Set<string>([
      ...stateRef.current.repos.map((row) => row.name),
      ...Object.keys(stateRef.current.chats),
      ...loadTokens.current.keys(),
    ]);
    for (const name of names) {
      loadTokens.current.set(name, (loadTokens.current.get(name) ?? 0) + 1);
    }
    holds.current.clear();
  }

  async function loadRepo(repo: string): Promise<ChatStateName | null> {
    const token = (loadTokens.current.get(repo) ?? 0) + 1;
    loadTokens.current.set(repo, token);
    const box = bucket(repo);
    box.hold = true;
    const [history, chat] = await Promise.all([
      window.flow.invoke("flow:chat.history", { repo }),
      window.flow.invoke("flow:chat.state", { repo }),
    ]);
    if (loadTokens.current.get(repo) !== token) return null;
    const queued = drainHold(box);
    if (!history.ok || !chat.ok) {
      replayHold(queued);
      return null;
    }
    dispatch({
      type: "repo-loaded",
      repo,
      messages: history.value.messages,
      chatState: chat.value.state,
      ...(chat.value.runId ? { runId: chat.value.runId } : {}),
      instructionsPending: chat.value.instructionsPending,
      ...(chat.value.pendingQuestion ? { pendingQuestion: chat.value.pendingQuestion } : {}),
    });
    replayHold(queued);
    return chat.value.state;
  }

  async function sendRepo(repo: string, text: string): Promise<void> {
    const box = bucket(repo);
    box.hold = true;
    dispatch({ type: "sending", repo, text });
    setPending(true);
    const result = await window.flow.invoke("flow:chat.send", { repo, text });
    if (!result.ok) {
      const [history, chat] = await Promise.all([
        window.flow.invoke("flow:chat.history", { repo }),
        window.flow.invoke("flow:chat.state", { repo }),
      ]);
      const queued = drainHold(box);
      setPending(false);
      const messages = history.ok ? history.value.messages : [];
      dispatch({
        type: "send-failed",
        repo,
        messages,
        chatState: chat.ok ? chat.value.state : "ready",
        banner: bannerFrom(result.error),
      });
      if (result.error.code === "not_found") void refreshRepos();
      if (!messages.some((message) => message.role === "user" && message.text === text)) {
        dispatch({ type: "draft", repo, draft: text });
      }
      replayHold(queued);
      return;
    }
    const queued = drainHold(box);
    setPending(false);
    dispatch({
      type: "run-started",
      repo,
      runId: result.value.runId,
      userMessageId: result.value.userMessageId,
      agentMessageId: result.value.agentMessageId,
      text,
      restored: result.value.restored,
    });
    replayHold(queued);
  }

  async function refreshRepos(cancelled?: () => boolean): Promise<void> {
    const listed = await window.flow.invoke("flow:repos.list", {});
    if (cancelled?.() || !listed.ok) return;
    dispatch({ type: "repos", repos: listed.value.repos });
  }

  async function sendHome(): Promise<void> {
    setPending(true);
    let handedOff = false;
    try {
      const text = stateRef.current.homeDraft;
      const names = stateRef.current.repos.map((row) => row.name);
      const parsed = parseMention(text, names);
      if (!parsed.ok) {
        dispatch({ type: "home-notice", notice: parsed.reason === "many" ? "One repo per message." : "Pick a repo with @." });
        return;
      }
      if (parsed.text === "") {
        dispatch({ type: "home-notice", notice: "Write a message after the repo name." });
        return;
      }
      const running = busyRepoNames(stateRef.current);
      const blocked = busyRepoMessage(parsed.repo);
      if (running.includes(parsed.repo)) {
        dispatch({ type: "home-notice", notice: blocked });
        return;
      }
      if (running.length >= MAX_BUSY_REPOS) {
        dispatch({ type: "home-notice", notice: BUSY_CAP_MESSAGE });
        return;
      }
      const slice = stateRef.current.chats[parsed.repo];
      if (slice?.loaded !== true) {
        const loaded = await loadRepo(parsed.repo);
        if (loaded !== null && isBusyState(loaded)) {
          dispatch({ type: "home-notice", notice: blocked });
          return;
        }
      }
      dispatch({ type: "home-draft", draft: "" });
      dispatch({ type: "open-repo", repo: parsed.repo });
      handedOff = true;
      await sendRepo(parsed.repo, parsed.text);
    } finally {
      if (!handedOff) setPending(false);
    }
  }

  async function openChat(repo: string): Promise<void> {
    if (stateRef.current.chats[repo]?.loaded !== true) await loadRepo(repo);
    dispatch({ type: "open-repo", repo });
  }

  async function saveSettings(partial: { folder?: string; model?: string; mode?: AgentMode; theme?: Theme }): Promise<boolean> {
    setPending(true);
    const result = await window.flow.invoke("flow:settings.save", partial);
    setPending(false);
    if (!result.ok) {
      dispatch({ type: "models-error", message: result.error.message, code: result.error.code });
      reportBanner(bannerFrom(result.error));
      return false;
    }
    dispatch({ type: "settings", settings: result.value, repos: stateRef.current.repos });
    return true;
  }

  async function saveKey(key: string): Promise<boolean> {
    setPending(true);
    const result = await window.flow.invoke("flow:key.set", { key });
    setPending(false);
    if (!result.ok) {
      dispatch({ type: "models-error", message: result.error.message, code: result.error.code });
      reportBanner(bannerFrom(result.error));
      return false;
    }
    const settings = await window.flow.invoke("flow:settings.get", {});
    if (settings.ok) dispatch({ type: "settings", settings: settings.value, repos: stateRef.current.repos });
    setModelEpoch((epoch) => epoch + 1);
    return true;
  }

  async function clearKey(): Promise<void> {
    setPending(true);
    const result = await window.flow.invoke("flow:key.clear", {});
    setPending(false);
    if (!result.ok) {
      dispatch({ type: "models-error", message: result.error.message, code: result.error.code });
      reportBanner(bannerFrom(result.error));
      return;
    }
    dispatch({ type: "models", models: [] });
    const settings = await window.flow.invoke("flow:settings.get", {});
    if (settings.ok) dispatch({ type: "settings", settings: settings.value, repos: stateRef.current.repos });
  }

  async function pickFolder(): Promise<void> {
    bootHold.current.hold = true;
    setPending(true);
    const picked = await window.flow.invoke("flow:folder.pick", {});
    if (!picked.ok) {
      setPending(false);
      releaseHold(false);
      dispatch({ type: "models-error", message: picked.error.message, code: picked.error.code });
      reportBanner(bannerFrom(picked.error));
      return;
    }
    if (picked.value.folder === null) {
      setPending(false);
      releaseHold(false);
      return;
    }
    const saved = await window.flow.invoke("flow:settings.save", { folder: picked.value.folder });
    if (!saved.ok) {
      setPending(false);
      releaseHold(false);
      dispatch({ type: "models-error", message: saved.error.message, code: saved.error.code });
      reportBanner(bannerFrom(saved.error));
      return;
    }
    const listed = await window.flow.invoke("flow:repos.list", {});
    const repos = listed.ok ? listed.value.repos : [];
    invalidateRepoLoads();
    dispatch({ type: "settings", settings: saved.value, repos });
    setPending(false);
    releaseHold(true);
    const only = repos.length === 1 ? repos[0] : undefined;
    if (only !== undefined) await loadRepo(only.name);
  }

  async function refreshInstructions(): Promise<boolean> {
    const repo = currentRepo();
    if (repo === null) return false;
    const chat = await window.flow.invoke("flow:chat.state", { repo });
    if (!chat.ok) return false;
    dispatch({ type: "instructions-pending", repo, pending: chat.value.instructionsPending });
    return chat.value.instructionsPending;
  }

  async function answer(questionId: string, answers: Answers): Promise<string | null> {
    const repo = currentRepo();
    if (repo === null) return null;
    const result = await window.flow.invoke("flow:question.answer", { repo, questionId, answers });
    if (!result.ok) return result.error.message;
    dispatch({ type: "question-settled", repo, questionId, answers, skipped: false });
    return null;
  }

  async function skip(questionId: string): Promise<string | null> {
    const repo = currentRepo();
    if (repo === null) return null;
    const result = await window.flow.invoke("flow:question.skip", { repo, questionId });
    if (!result.ok) return result.error.message;
    dispatch({ type: "question-settled", repo, questionId, answers: null, skipped: true });
    return null;
  }

  async function resetChat(repo: string): Promise<void> {
    const box = holds.current.get(repo);
    if (box !== undefined) {
      box.hold = false;
      box.events.splice(0);
    }
    loadTokens.current.set(repo, (loadTokens.current.get(repo) ?? 0) + 1);
    setPending(true);
    const result = await window.flow.invoke("flow:chat.reset", { repo });
    setPending(false);
    if (!result.ok) {
      dispatch({ type: "banner", repo, banner: bannerFrom(result.error) });
      return;
    }
    const leave = shouldLeaveAfterReset(stateRef.current, repo);
    dispatch({ type: "reset-chat", repo });
    if (leave) dispatch({ type: "open-home" });
  }

  async function stop(): Promise<void> {
    const repo = currentRepo();
    if (repo === null) return;
    setPending(true);
    const result = await window.flow.invoke("flow:chat.stop", { repo });
    setPending(false);
    if (!result.ok) dispatch({ type: "banner", repo, banner: bannerFrom(result.error) });
  }

  function retryFor(repo: string): void {
    const slice = state.chats[repo] ?? emptySlice();
    if (slice.lastUserText !== null) void sendRepo(repo, slice.lastUserText);
  }

  function chatPane(repoName: string, current: Settings) {
    const slice = state.chats[repoName] ?? emptySlice();
    return (
      <Chat
        repoName={repoName}
        workspaceBusy={anyBusy(state)}
        folder={current.folder ?? ""}
        model={current.model ?? ""}
        mode={current.mode}
        models={state.models}
        theme={current.theme}
        items={slice.items}
        chatState={slice.chatState}
        draft={slice.draft}
        notice={slice.notice}
        banner={slice.banner}
        pending={pending}
        canRetry={canRetry(slice)}
        instructionsPending={slice.instructionsPending}
        onDraft={(draft) => dispatch({ type: "draft", repo: repoName, draft })}
        onSend={() => {
          const text = slice.draft.trim();
          if (text === "") return;
          void sendRepo(repoName, text);
        }}
        onStop={() => void stop()}
        onTheme={(theme) => void saveSettings({ theme })}
        onMode={(mode) => void saveSettings({ mode })}
        onModel={(model) => saveSettings({ model })}
        onReset={() => void resetChat(repoName)}
        onSetup={() => dispatch({ type: "edit-setup" })}
        onInstructions={() => dispatch({ type: "open-instructions" })}
        onDismiss={() => dispatch({ type: "dismiss-banner", repo: repoName })}
        onRetry={() => retryFor(repoName)}
        onBannerSetup={() => dispatch({ type: "edit-setup" })}
        onAnswer={answer}
        onSkip={skip}
      />
    );
  }

  function instructionsPane(repoName: string) {
    const slice = state.chats[repoName] ?? emptySlice();
    return (
      <Instructions
        repo={repoName}
        banner={slice.banner}
        canRetry={canRetry(slice)}
        onBack={() => dispatch({ type: "close-instructions" })}
        onChanged={refreshInstructions}
        onDismiss={() => dispatch({ type: "dismiss-banner", repo: repoName })}
        onRetry={() => retryFor(repoName)}
        onSetup={() => dispatch({ type: "edit-setup" })}
      />
    );
  }

  const settings = state.settings;
  const repo = state.view.kind === "repo" ? state.view.repo : state.repos.length === 1 ? (state.repos[0]?.name ?? null) : null;
  const home = (
    <NewChat
      repos={state.repos.map((row) => row.name)}
      draft={state.homeDraft}
      notice={state.homeNotice}
      pending={pending}
      onDraft={(draft) => dispatch({ type: "home-draft", draft })}
      onSend={() => void sendHome()}
    />
  );

  return (
    <div className="app">
      <div className="stripe" />
      {screen === "loading" || settings === null ? (
        <p className="loading">Opening…</p>
      ) : screen === "setup" ? (
        <>
          {state.banner ? (
            <BannerView
              banner={state.banner}
              onDismiss={() => {
                if (state.view.kind !== "repo") return;
                dispatch({ type: "dismiss-banner", repo: state.view.repo });
              }}
            />
          ) : null}
          <Setup
            settings={settings}
            models={state.models}
            modelsError={state.modelsError}
            pending={pending}
            repos={state.repos}
            locked={anyBusy(state)}
            onSaveKey={saveKey}
            onClearKey={clearKey}
            onPickFolder={pickFolder}
            onModel={(model) => saveSettings({ model })}
            onTheme={(theme) => void saveSettings({ theme })}
            onMode={(mode) => void saveSettings({ mode })}
            onBack={settings.setupComplete ? () => dispatch({ type: "close-setup" }) : null}
          />
        </>
      ) : state.repos.length > 1 ? (
        <div className="shell">
          <RepoSidebar
            rows={sidebarRows(state)}
            pending={pending}
            onOpen={(name) => void openChat(name)}
            onNew={() => dispatch({ type: "open-home" })}
            onRemove={(name) => void resetChat(name)}
          />
          {screen === "home" ? home : screen === "instructions" && repo !== null ? instructionsPane(repo) : repo !== null ? chatPane(repo, settings) : null}
        </div>
      ) : screen === "instructions" && repo !== null ? (
        instructionsPane(repo)
      ) : repo !== null ? (
        chatPane(repo, settings)
      ) : (
        home
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
