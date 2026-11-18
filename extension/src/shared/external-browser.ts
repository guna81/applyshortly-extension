// Host assistants supply decisions; this controller never calls an AI endpoint.
import { TabDriver } from "../page-control/cdp.js";
import { executing, observeTab } from "../page-control/loop.js";
import { CommandRunner } from "../page-control/commands.js";

// After this long without a command the application tab is let go (the debugger banner goes
// away); the browser stays connected and takes the tab back when the next command arrives.
const IDLE_RELEASE_MS = 120_000;
const RECONNECT_MAX_MS = 30_000;
const IDLE_POLL_MS = 3000; // nothing is running: look for work this often
const HOT_WINDOW_MS = 120_000; // after a command (or while a batch is active) ask for the next one at once
const MIN_HOT_GAP_MS = 250;
const POLL_HOLD_S = 3; // how long the server may hold a poll open waiting for a command

export function validateApplicationForm(): string | false {
  const F = (globalThis as any).JobHuntFill;
  const fields = F.collectFields(document);
  const button = F.findSubmitButton(document, fields, { includeDisabled: true });
  if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") return false;
  if (document.querySelector('input[type="password"]')) return false;
  const complete =
    fields.every((field: any) => {
      if (F.isInvalid(field)) return false;
      if (!field.required) return true;
      if (field.kind === "checkbox") {
        const checked = (el: any) => el.checked === true || el.getAttribute?.("aria-checked") === "true";
        return field.options?.length ? field.options.some((option: any) => checked(option.el)) : checked(field.el);
      }
      return !F.isEmpty(field);
    }) &&
    (!button.form || button.form.checkValidity());
  if (!complete) return false;
  return JSON.stringify(fields.map((field: any) => [field.label, field.el.value, field.el.checked]));
}

export async function waitForApplicationTab(tabId: number, tabs = chrome.tabs): Promise<chrome.tabs.Tab> {
  const deadline = Date.now() + 15_000;
  let last: chrome.tabs.Tab | null = null;
  while (Date.now() < deadline) {
    const tab = await tabs.get(tabId);
    last = tab;
    if (/^https?:\/\//.test(tab.url || "") && tab.status === "complete") return tab;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  // Pages heavy on ads and trackers can stay "loading" long after their form is usable. The next
  // command reads the page again, so a tab that has a real address is good enough to carry on with.
  if (last && /^https?:\/\//.test(last.url || "") && last.status === "loading") return last;
  throw new Error("Application page did not finish opening. Check the tab before retrying.");
}

const KEEP = "externalBrowser"; // { wanted, device, autoApprove } kept across service-worker restarts

export interface KeyValueStore {
  get: (key: string) => Promise<Record<string, any>>;
  set: (value: Record<string, any>) => Promise<void>;
}

export interface ExternalBrowserOptions {
  settings: () => Promise<{ baseUrl: string; token: string; [key: string]: any }>;
  sources: () => Promise<string[]>;
  resume: () => Promise<any>;
  report: (appId: number, event: string, url?: string) => Promise<any>;
  enabled?: boolean;
  makeDriver?: (tabId: number, code: string[]) => TabDriver;
  store?: KeyValueStore;
  hasAccess?: (origins: string[]) => Promise<boolean>;
  http?: (url: string, init?: RequestInit) => Promise<Response>;
  timers?: {
    setTimeout: (fn: () => void, ms: number) => any;
    clearTimeout: (id: any) => void;
  };
}

export function externalBrowser({
  settings,
  sources,
  resume,
  report,
  enabled = true,
  makeDriver = (tabId, code) => new TabDriver(tabId, code as any),
  store = { get: async (_key) => ({}), set: async (_value) => {} },
  hasAccess = async (_origins) => false,
  http = (url, init) => globalThis.fetch(url, init),
  timers = {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id),
  },
}: ExternalBrowserOptions) {
  let device: string | null = null;
  let driver: TabDriver | null = null;
  let application: number | null = null;
  let timer: any = null;
  let generation = 0; // bumped whenever polling stops, so a loop already in flight does not reschedule
  let polling = false;
  let lastCommand = 0;
  let released: { tabId: number; application: number | null } | null = null; // { tabId, application } of a tab let go after sitting idle
  let busy = false; // a command is running
  let userPaused = false; // the user is editing the form by hand: no command touches the page
  let wanted = false; // the user connected this browser and has not stopped it
  let reconnectTimer: any = null;
  let attempts = 0;
  let standing = false;

  const standingUrl = async () => {
    const { baseUrl, token } = await settings();
    return {
      url: `${baseUrl}/api/extension/browser/standing-approval`,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    };
  };

  const loadStanding = async () => {
    try {
      const { url, headers } = await standingUrl();
      const response = await http(url, { headers });
      if (response.ok) standing = ((await response.json()) as any).enabled === true;
    } catch {
      /* keep the last known value */
    }
  };

  let autoApprove = false; // the user trusts their assistant to start fill-only batches on sites already allowed
  const remember = async (patch: Record<string, any>) => {
    try {
      await store.set({ [KEEP]: { ...(((await store.get(KEEP))[KEEP] as Record<string, any>) ?? {}), ...patch } });
    } catch {
      /* best effort */
    }
  };

  const seen = new Set<string>();
  let batches: any[] = [];
  let pendingReview: { batchId: string; answers: Array<[string, unknown]> } | null = null;
  let submissionState: string | null = null;
  let pendingNavigation: string | null = null;
  const trustedOrigins = new Set<string>();
  const activity: Array<{ id: string; at: number; text: string; state: string }> = [];
  const knownBatches = new Set<string>();
  const notes: Array<{ id: string; text: string; afterPoll: number; read: boolean }> = [];
  const NOTE_CHARS = 500;
  let pollsStarted = 0;

  const note = (text: unknown, state = "done") => {
    const entry = { id: crypto.randomUUID(), at: Date.now(), text: String(text).slice(0, 140), state };
    activity.push(entry);
    if (activity.length > 120) activity.shift();
    return entry;
  };

  const hostOf = (url?: string) => {
    try {
      return new URL(url || "").hostname;
    } catch {
      return "the application";
    }
  };

  const describe = (command: any) => {
    const action = command.action;
    const job = command.jobs?.find((j: any) => j.application_id === command.application_id);
    const name = runner.observed?.refs.get(action.ref)?.name;
    const field = name ? `“${String(name).slice(0, 50)}”` : "a field";
    switch (action.type) {
      case "open":
        return `Opening ${hostOf(job?.url)}`;
      case "observe":
        return "Reading the page";
      case "type":
        return `Typing into ${field}`;
      case "select":
        return `Choosing an option in ${field}`;
      case "check":
        return `Setting checkbox ${field}`;
      case "click":
        return `Clicking ${field}`;
      case "scroll":
        return "Scrolling the page";
      case "options":
        return `Reading the options in ${field}`;
      case "review":
        return "Reviewing the form";
      case "fill_form": {
        let count = 0;
        try {
          count = JSON.parse(action.fields || "[]").length;
        } catch {
          /* reported when it runs */
        }
        return count ? `Filling ${count} field${count === 1 ? "" : "s"}` : "Filling several fields";
      }
      case "upload":
        return "Uploading your resume";
      case "switch_tab":
        return "Switching to the application's new tab";
      case "submit":
        return "Submitting: checking the form";
      case "stop":
      case "pause":
        return "Stopping browser control";
      default:
        return `Running ${String(action.type).slice(0, 20)}`;
    }
  };

  const changedAnswers = new Map<string, unknown>();
  const approvedAnswers = new Map<string, unknown>();

  const runner: any = new CommandRunner({
    policy: {
      blockers: true,
      captchaFillable: true,
      around: (frames: any, runFn: any) => executing(runner.driver, frames, runFn),
      allowHref: (href: string, origin: string) => {
        if (trustedOrigins.has(origin)) return true;
        pendingNavigation = origin;
        note(`Waiting for you to approve ${hostOf(href)}`, "warn");
        return false;
      },
      onCommitted: (name: string, committed: unknown) => {
        changedAnswers.set(name, committed);
      },
      note: (text: string, state: string) => note(text, state),
      isPaused: () => userPaused,
      files: (kind: string) => (kind === "resume" ? resume() : null),
    },
  });

  const setDriver = (next: TabDriver | null) => {
    driver = next;
    runner.driver = next;
  };

  let socket: WebSocket | null = null;
  const requests = new Map<string, { resolve: (val: any) => void; reject: (err: any) => void; timeout: any }>();

  const request = (path: string, body: any = undefined): Promise<any> =>
    new Promise((resolve, reject) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        reject(new Error("Browser relay disconnected."));
        return;
      }
      const id = crypto.randomUUID();
      const timeout = setTimeout(() => {
        requests.delete(id);
        reject(new Error("Browser relay timed out."));
      }, 15_000);
      requests.set(id, { resolve, reject, timeout });
      socket.send(JSON.stringify({ id, path, body }));
    });

  const stop = async () => {
    generation++;
    timers.clearTimeout(timer);
    timer = null;
    if (driver) note("Released the application tab");
    await driver?.detach();
    setDriver(null);
    runner.reset();
    application = null;
    released = null;
  };

  const release = async () => {
    if (!driver) return;
    released = { tabId: driver.tabId, application };
    note("Released the application tab (idle). It re-attaches on the next command");
    await driver.detach();
    setDriver(null);
    runner.reset();
  };

  async function run(command: any): Promise<any> {
    let lastAction = null;
    if (seen.has(command.id)) throw new Error("Duplicate command refused. Observe the page again.");
    seen.add(command.id);
    const action = command.action;
    const job = command.jobs.find((j: any) => j.application_id === command.application_id);
    if (!job) throw new Error("Application was not approved.");
    if (action.type === "stop" || action.type === "pause") {
      await stop();
      return { paused: true };
    }
    if (userPaused)
      throw new Error(
        "The user paused browser control to edit the form by hand. Wait for them to continue, then observe the page again before changing anything.",
      );
    if (action.type === "open") {
      submissionState = null;
      if (driver) throw new Error("An application tab is already active.");
      trustedOrigins.clear();
      trustedOrigins.add(new URL(job.url).origin);
      const applicationUrl = new URL(job.url);
      if (/jobhunt-(?:autofill|auto)=/.test(applicationUrl.hash)) applicationUrl.hash = "";
      const tab = await chrome.tabs.create({ url: applicationUrl.href, active: true });
      if (tab.id === undefined) throw new Error("Failed to create tab.");
      await waitForApplicationTab(tab.id);
      setDriver(makeDriver(tab.id, await sources()));
      application = job.application_id;
      driver!.onDetached = () => {
        void stop();
      };
      await driver!.attach();
    }
    if (!driver && released && released.application === job.application_id) {
      // The tab was let go while idle: take it back without reloading the page.
      const tab = await chrome.tabs.get(released.tabId).catch(() => null);
      if (tab && tab.id !== undefined) {
        setDriver(makeDriver(tab.id, await sources()));
        application = released.application;
        driver!.onDetached = () => {
          void stop();
        };
        await driver!.attach();
        released = null;
        note("Re-attached the application tab");
        if (action.type !== "observe") {
          // Take a snapshot straight away: the caller's observation_id stays good for this page.
          const previous = runner.lastObservationId;
          await runner.observe();
          runner.observed.alias = previous;
        }
      } else released = null;
    }
    if (!driver || application !== job.application_id) throw new Error("Open this application first.");
    if (action.type === "switch_tab") {
      const candidates = await driver.applicationTabs();
      const candidate = candidates.find((item: any) => String(item.id) === action.tab_id);
      if (!candidate) throw new Error("Only a tab opened by this application may be selected.");
      if (!trustedOrigins.has(new URL(candidate.url).origin)) {
        pendingNavigation = new URL(candidate.url).origin;
        note(`Waiting for you to approve ${hostOf(candidate.url)}`, "warn");
        throw new Error("Approve the new application domain in the extension.");
      }
      await driver.switchTab(candidate.id);
      runner.reset();
    }
    const tab = await chrome.tabs.get(driver.tabId);
    if (!trustedOrigins.has(new URL(tab.url || "").origin)) {
      pendingNavigation = new URL(tab.url || "").origin;
      runner.reset();
      note(`Waiting for you to approve ${hostOf(tab.url)}`, "warn");
      throw new Error("Approve the new application domain in the extension.");
    }
    if (action.type === "submit") {
      const fresh = await observeTab(driver, { extended: true });
      if (fresh.observation.blockers?.includes("captcha"))
        throw new Error(
          "The page shows a CAPTCHA. Ask the user to complete it and click the site's own Submit; never solve it or submit around it.",
        );
      if (fresh.observation.blockers?.length || (fresh.observation as any).errors?.length)
        throw new Error("Resolve page blockers and errors before submission.");
      if (
        /your application (?:has been |was )?(?:successfully )?(?:submitted|received)|thank you for applying/i.test(
          fresh.observation.text || "",
        )
      )
        throw new Error("A confirmation is already present; verify the application first.");
      if (standing) for (const [key, value] of changedAnswers) approvedAnswers.set(key, value);
      const unreviewed = [...changedAnswers].filter(([key, value]) => approvedAnswers.get(key) !== value);
      if (unreviewed.length) {
        pendingReview = { batchId: command.batch_id, answers: unreviewed };
        note("Waiting for you to review new answers", "warn");
        return {
          state: "needs_answer_review",
          message: "Review the answers in the extension, then request submission again.",
        };
      }
      const validate = async () => {
        const injections = await chrome.scripting.executeScript({
          target: { tabId: driver!.tabId },
          func: validateApplicationForm,
        });
        return injections[0]?.result;
      };
      const fingerprint = await validate();
      if (!fingerprint) throw new Error("Required fields or uploads need review. Submit manually if the form is unsupported.");
      if (!standing) note("Countdown started: cancel it in the page if anything looks wrong", "warn");
      else note("Submitting under your standing approval");
      const countdownInjections = await chrome.scripting.executeScript({
        target: { tabId: driver.tabId },
        args: [standing],
        func: async (skipCountdown) => {
          if (skipCountdown) return true;
          const box = document.createElement("div");
          box.style.cssText =
            "position:fixed;z-index:2147483647;top:16px;right:16px;padding:20px;background:white;color:black;border:2px solid black";
          const text = document.createElement("p");
          const cancel = document.createElement("button");
          cancel.textContent = "Cancel submission";
          let cancelled = false;
          cancel.onclick = () => {
            cancelled = true;
            box.remove();
          };
          box.append(text, cancel);
          document.documentElement.append(box);
          for (let seconds = 3; seconds > 0; seconds--) {
            text.textContent = `ApplyShortly will submit in ${seconds} seconds`;
            await new Promise((resolve) => setTimeout(resolve, 1000));
            if (cancelled) return false;
          }
          box.remove();
          return true;
        },
      });
      const proceed = countdownInjections[0]?.result;
      if (!proceed || (await validate()) !== fingerprint) throw new Error("Submission cancelled or form changed.");
      await request(`/devices/${device}/batches/${command.batch_id}/attempt`, {
        application_id: application,
        new_answers: Object.fromEntries(changedAnswers),
      });
      note("Clicked Submit; waiting for the employer's confirmation");
      await report(application!, "submission_attempted", tab.url);
      const clickInjections = await chrome.scripting.executeScript({
        target: { tabId: driver.tabId },
        func: () => {
          const F = (globalThis as any).JobHuntFill;
          const button = F.findSubmitButton(document, F.collectFields(document));
          if (!button || button.disabled || (button.form && !button.form.checkValidity())) return false;
          button.click();
          return true;
        },
      });
      const clicked = clickInjections[0]?.result;
      let confirmed = false;
      for (let index = 0; clicked && index < 10; index++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const checkInjections = await chrome.scripting.executeScript({
          target: { tabId: driver.tabId },
          func: () =>
            /your application (?:has been |was )?(?:successfully )?(?:submitted|received)|thank you for applying|we (?:have )?received your application/i.test(
              document.body.innerText,
            ),
        });
        if (checkInjections[0]?.result) {
          confirmed = true;
          break;
        }
      }
      await request(`/devices/${device}/batches/${command.batch_id}/confirmation`, {
        application_id: application,
        confirmed,
      });
      note(
        confirmed ? "Employer confirmation seen" : "No confirmation seen. Verify the application before retrying",
        confirmed ? "done" : "error",
      );
      submissionState = confirmed ? "submitted" : "needs_verification";
      if (confirmed) {
        await report(application!, "submitted", tab.url);
        await driver.detach();
        setDriver(null);
        runner.reset();
        application = null;
        changedAnswers.clear();
        approvedAnswers.clear();
      }
      return { state: confirmed ? "submitted" : "needs_verification" };
    }
    if (["fill_form", "options", "review"].includes(action.type)) {
      lastAction = await runner.compound(action.type, action, {
        observationId: action.observation_id,
        commandId: command.id,
      });
    } else if (!["open", "observe", "switch_tab"].includes(action.type)) {
      lastAction = await runner.mutate(action, command.id);
    }
    return runner.reply({ delta: action.delta === "true", lastAction });
  }

  async function autoApproves(batch: any): Promise<boolean> {
    if (!autoApprove || batch.auto_submit) return false;
    try {
      const origins = [...new Set(batch.jobs.map((job: any) => `${new URL(job.url).origin}/*`))];
      return origins.length > 0 && (await hasAccess(origins as string[])) === true;
    } catch {
      return false;
    }
  }

  function markRead(unread: any, asked: number) {
    if (!Array.isArray(unread)) return;
    for (const item of notes) {
      if (!item.read && item.afterPoll < asked && !unread.includes(item.id)) {
        item.read = true;
        note("Your assistant read your message");
      }
    }
  }

  const noteBatch = () => {
    const live = batches.filter((b) => ["active", "paused"].includes(b.state));
    const current = application ?? released?.application;
    return live.find((b) => b.policy.application_ids[b.policy.index] === current) ?? live[0];
  };

  async function poll(wait = 0) {
    if (polling) return;
    polling = true;
    try {
      if (driver && Date.now() - lastCommand >= IDLE_RELEASE_MS) await release();
      const asked = ++pollsStarted;
      const data = await request(`/devices/${device}/poll`, wait ? { wait } : undefined);
      batches = data.batches;
      markRead(data.notes, asked);
      for (const batch of batches) {
        if (batch.state === "pending" && !knownBatches.has(batch.id)) {
          knownBatches.add(batch.id);
          const count = `${batch.jobs.length} application${batch.jobs.length === 1 ? "" : "s"}`;
          if (await autoApproves(batch)) {
            note(`${batch.assistant} asked to fill ${count}. Approved automatically (fill only, sites you already allowed)`);
            try {
              await request(`/devices/${device}/batches/${batch.id}/decision`, { approve: true });
              continue;
            } catch {
              /* fall back to asking */
            }
          }
          note(`${batch.assistant} asked to fill ${count}. Waiting for your approval`, "warn");
        }
      }
      if (
        driver &&
        !batches.some((batch) => batch.state === "active" && batch.policy.application_ids[batch.policy.index] === application)
      ) {
        if (
          batches.some(
            (batch) => batch.state === "paused" && batch.policy.application_ids[batch.policy.index] === application,
          )
        )
          await release();
        else {
          await driver.detach();
          setDriver(null);
          runner.reset();
          application = null;
          released = null;
        }
      }
      for (const command of data.commands) {
        lastCommand = Date.now();
        let result: any;
        const step = note(describe(command), "running");
        busy = true;
        try {
          result = { ok: true, result: await run(command) };
          step.state = "done";
        } catch (error: any) {
          result = { ok: false, result: { error: error.message } };
          step.state = "error";
          step.text = `${step.text}: ${String(error.message).slice(0, 80)}`;
        } finally {
          busy = false;
        }
        await request(`/devices/${device}/commands/${command.id}/result`, result);
        if (userPaused && driver) await release();
      }
    } catch {
      if (!socket || socket.readyState !== WebSocket.OPEN) await stop();
    } finally {
      polling = false;
    }
  }

  function schedulePoll(delay: number) {
    const mine = generation;
    timers.clearTimeout(timer);
    timer = timers.setTimeout(async () => {
      const started = Date.now();
      const hot = busyRecently();
      await poll(hot ? POLL_HOLD_S : 0);
      if (generation !== mine || timer === null) return;
      const took = Date.now() - started;
      schedulePoll(busyRecently() ? Math.max(0, MIN_HOT_GAP_MS - took) : IDLE_POLL_MS);
    }, delay);
  }

  const busyRecently = () => busy || Date.now() - lastCommand < HOT_WINDOW_MS || batches.some((b) => b.state === "active");

  async function open() {
    await stop();
    const s = await settings();
    const url = new URL(`${s.baseUrl}/api/extension/browser/relay`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    socket?.close();
    const mine = new WebSocket(url.href);
    socket = mine;
    mine.onmessage = (event) => {
      const packet = JSON.parse(event.data);
      const pending = requests.get(packet.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      requests.delete(packet.id);
      if (packet.error) pending.reject(new Error(packet.error));
      else pending.resolve(packet.data);
    };
    mine.onclose = () => {
      if (socket !== mine) return;
      for (const pending of requests.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("Browser relay disconnected."));
      }
      requests.clear();
      void stop();
      scheduleReconnect();
    };
    await new Promise<void>((resolve, reject) => {
      mine.onopen = () => resolve();
      mine.onerror = () => reject(new Error("Cannot connect to the browser relay. Check whether the server enabled this pilot."));
    });
    mine.send(JSON.stringify({ token: s.token }));
    device = (await request("/devices", { name: "Chrome", ...(device ? { resume_device_id: device } : {}) })).device_id;
    lastCommand = Date.now();
    void remember({ device });
    note("Browser connected. Waiting for your assistant");
    schedulePoll(0);
    await poll();
    return { device_id: device };
  }

  function scheduleReconnect() {
    if (!wanted || reconnectTimer) return;
    const delay = Math.min(RECONNECT_MAX_MS, 1000 * 2 ** attempts++);
    note("Connection lost. Reconnecting", "warn");
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      try {
        await open();
        attempts = 0;
      } catch {
        scheduleReconnect();
      }
    }, delay);
  }

  async function connect() {
    if (!enabled) throw new Error("External assistant control is currently disabled.");
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    attempts = 0;
    const result = await open();
    wanted = true;
    void remember({ wanted: true });
    void loadStanding();
    return result;
  }

  async function resumeIfWanted() {
    if (!enabled || wanted || socket) return false;
    const kept = ((await store.get(KEEP))[KEEP] as Record<string, any>) ?? {};
    autoApprove = kept.autoApprove === true;
    if (!kept.wanted || !(await settings()).token) return false;
    if (kept.device) device = kept.device;
    wanted = true;
    await loadStanding();
    try {
      await open();
    } catch {
      scheduleReconnect();
    }
    return true;
  }

  return {
    connect,
    resumeIfWanted,
    async setStanding(on: boolean) {
      const { url, headers } = await standingUrl();
      const response = await http(url, { method: "PUT", headers, body: JSON.stringify({ enabled: on === true }) });
      if (!response.ok) throw new Error("Could not change the standing approval. Try again.");
      standing = ((await response.json()) as any).enabled === true;
      note(standing ? "Standing approval on: your assistant's batches start approved" : "Standing approval off: each batch needs your approval");
      return standing;
    },
    async setAutoApprove(on: boolean) {
      autoApprove = on === true;
      await remember({ autoApprove });
      note(autoApprove ? "Automatic filling on: applications on approved sites start without asking" : "Automatic filling off: each selection needs approval");
      return autoApprove;
    },
    ownsTab: (tabId: number) =>
      Boolean((driver && (driver.tabId === tabId || driver.candidateTabs.has(tabId))) || released?.tabId === tabId),
    workingTab: () => driver?.tabId ?? released?.tabId ?? null,
    status: () => ({
      enabled,
      device_id: device,
      autoApprove,
      standing,
      wanted,
      batches,
      submissionState,
      pendingReview,
      pendingNavigation,
      connected: timer !== null,
      paused: userPaused,
      activity: activity.slice(-60),
    }),
    async pauseForUser() {
      if (userPaused) return true;
      userPaused = true;
      note("You paused the assistant. Edit the form freely", "warn");
      if (!busy) await release();
      return true;
    },
    continueAfterUser() {
      if (!userPaused) return true;
      userPaused = false;
      note("You continued. The assistant will re-read the page first");
      return true;
    },
    async sendNote(text: string) {
      const clean = String(text ?? "").trim().slice(0, NOTE_CHARS);
      if (!clean) throw new Error("Write a message first.");
      const batch = noteBatch();
      if (!batch) throw new Error("Your assistant has no approved application open right now.");
      const sent = await request(`/devices/${device}/batches/${batch.id}/note`, { text: clean });
      notes.push({ id: sent.id, text: clean, afterPoll: pollsStarted, read: false });
      if (notes.length > 20) notes.shift();
      note("You sent your assistant a message");
      return true;
    },
    notes: () => notes.map(({ id, text, read }) => ({ id, text, read })),
    async decision(batchId: string, approve: boolean) {
      note(approve ? "You approved the selected applications" : "You rejected the selected applications");
      return request(`/devices/${device}/batches/${batchId}/decision`, { approve });
    },
    approveNavigation() {
      if (!pendingNavigation) throw new Error("No navigation awaiting approval.");
      note(`You approved ${hostOf(pendingNavigation)}`);
      trustedOrigins.add(pendingNavigation);
      pendingNavigation = null;
      runner.reset();
      return true;
    },
    reviewAnswers() {
      if (!pendingReview) throw new Error("No answers awaiting review.");
      for (const [key, value] of pendingReview.answers) approvedAnswers.set(key, value);
      note("You approved the new answers");
      pendingReview = null;
      return true;
    },
    async stop() {
      wanted = false;
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      userPaused = false;
      void remember({ wanted: false });
      note("You stopped browser control", "warn");
      if (standing) {
        standing = false;
        try {
          const { url, headers } = await standingUrl();
          await http(url, { method: "PUT", headers, body: JSON.stringify({ enabled: false }) });
        } catch {
          /* best effort */
        }
      }
      try {
        for (const batch of batches.filter((item) => ["pending", "active", "paused"].includes(item.state))) {
          await request(`/devices/${device}/batches/${batch.id}/decision`, { approve: false });
        }
      } finally {
        await stop();
        socket?.close();
        socket = null;
      }
    },
  };
}
