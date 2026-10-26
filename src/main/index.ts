/**
 * index.ts — the Electron main process: one window, one IPC channel.
 *
 * Everything that is not Electron lives in `compose.ts` and the modules it
 * builds, so it can be tested without a window.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  protocol,
  safeStorage,
  session,
  shell,
  systemPreferences,
  Tray,
} from "electron";
import { TRAY_ICON_PNG_BASE64 } from "./tray-icon.ts";
import { EVENT_CHANNEL, INVOKE_CHANNEL } from "../shared/wire.ts";
import { compose } from "./compose.ts";
import { createDispatcher } from "./ipc/index.ts";

// The main bundle is an ES module, which has no `__dirname`.
const here = dirname(fileURLToPath(import.meta.url));

/**
 * One instance per machine user, enforced rather than remembered.
 *
 * Two processes on one data directory share its team logs, and each keeps its
 * own idea of the next sequence number. 2.x damaged two logs that way before
 * it had a lock. A second launch focuses the window that is already open.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

/**
 * `squad-media:///<encoded absolute path>` — how the window shows a picture
 * from a team's folder. Registered before `ready`, as Electron requires;
 * answered by `composed.readMedia`, which refuses anything that is not an
 * image inside some team's project folder.
 */
protocol.registerSchemesAsPrivileged([
  { scheme: "squad-media", privileges: { standard: false, supportFetchAPI: true } },
]);

let window: BrowserWindow | undefined;
/**
 * How large the window draws everything, from Settings → 外观 (1 = normal).
 * Applied as the page's zoom, so every text grows together — the discussion,
 * the titles, the sidebar, the buttons — and the layout with it.
 */
let fontScale = 1;
/** Held for the life of the app: a tray icon that is garbage-collected disappears. */
let tray: Tray | undefined;

/** Bring the window up, creating it again if it was closed (macOS keeps the app). */
function showWindow(): void {
  if (window === undefined || window.isDestroyed()) {
    window = createWindow();
    return;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

const TRAY_LABELS = {
  zh: {
    open: "打开主窗口",
    stop: "叫停所有正在跑的席位",
    data: "打开数据目录",
    quit: "退出",
    stopped: "已叫停：{teams}",
    idle: "没有正在跑的席位。",
  },
  en: {
    open: "Open Squad",
    stop: "Stop every running seat",
    data: "Open the data folder",
    quit: "Quit",
    stopped: "Stopped: {teams}",
    idle: "No seat is running.",
  },
} as const;

/**
 * The tray: the window, the one emergency control, the data folder, quit.
 * 「叫停」 stops each team the way its own button does — recorded as a stop,
 * an agenda handed over — and says what it stopped.
 */
function createTray(
  composed: { stopEveryTeam: () => readonly string[]; language: () => "zh" | "en" | undefined },
  dataDir: string,
): void {
  const language = composed.language() ?? (app.getLocale().toLowerCase().startsWith("zh") ? "zh" : "en");
  const words = TRAY_LABELS[language];
  tray = new Tray(nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_PNG_BASE64}`));
  tray.setToolTip("Squad");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: words.open, click: showWindow },
      {
        label: words.stop,
        click: () => {
          const stopped = composed.stopEveryTeam();
          if (!Notification.isSupported()) return;
          new Notification({
            title: "Squad",
            body: stopped.length === 0 ? words.idle : words.stopped.replace("{teams}", stopped.join("、")),
          }).show();
        },
      },
      { label: words.data, click: () => void shell.openPath(dataDir) },
      { type: "separator" },
      { label: words.quit, click: () => app.quit() },
    ]),
  );
  // Windows and Linux open a tray app's window on a plain click; the menu is the right click.
  tray.on("click", showWindow);
}

function createWindow(): BrowserWindow {
  const created = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: "Squad",
    // Electron's stock English menu bar says nothing Squad needs; Alt still
    // brings it up, and its edit shortcuts (copy, paste, undo) keep working.
    autoHideMenuBar: true,
    // The page's own background while it loads, so a dark theme does not flash white.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#100e0b" : "#f7f6f3",
    show: false,
    webPreferences: {
      preload: join(here, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  created.once("ready-to-show", () => created.show());
  // Every load, not once: a reload or a dev-server refresh resets the zoom.
  created.webContents.on("did-finish-load", () => created.webContents.setZoomFactor(fontScale));
  // A link in a reply opens in the system browser. The window itself never
  // navigates: a reply is written by a model, and following its link inside
  // the app would replace the team with whatever page it pointed at.
  created.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  created.webContents.on("will-navigate", (event, url) => {
    if (url === created.webContents.getURL()) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl !== undefined) void created.loadURL(devUrl);
  else void created.loadFile(join(here, "../renderer/index.html"));
  return created;
}

app.on("second-instance", () => {
  if (window === undefined) return;
  if (window.isMinimized()) window.restore();
  window.focus();
});

/**
 * The microphone, for dictation — and nothing else. Electron grants every
 * permission a page asks for unless told otherwise; this window shows text a
 * model wrote, so it gets exactly the one capability a feature here uses:
 * audio capture, for our own page. Camera, screen, location, notifications
 * from the page: refused.
 */
function allowMicrophoneOnly(): void {
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  const ours = (url: string): boolean =>
    url.startsWith("file://") || (devUrl !== undefined && devUrl !== "" && url.startsWith(devUrl));
  session.defaultSession.setPermissionRequestHandler((contents, permission, decide, details) => {
    const audioOnly =
      permission === "media" &&
      "mediaTypes" in details &&
      (details.mediaTypes ?? []).length > 0 &&
      (details.mediaTypes ?? []).every((kind) => kind === "audio");
    if (!audioOnly || !ours(contents.getURL())) {
      decide(false);
      return;
    }
    // macOS asks the person once, at the system level; without it the stream
    // opens and records silence.
    if (process.platform === "darwin") {
      void systemPreferences.askForMediaAccess("microphone").then(decide, () => decide(false));
      return;
    }
    decide(true);
  });
  session.defaultSession.setPermissionCheckHandler(
    (contents, permission) => permission === "media" && contents !== null && ours(contents.getURL()),
  );
}

void app.whenReady().then(() => {
  allowMicrophoneOnly();
  // Windows shows a toast only for an app it can name. Installed, that is the
  // installer's id (phase 6); run from source, the executable's own path.
  if (process.platform === "win32") app.setAppUserModelId(app.isPackaged ? "com.squad.desktop" : process.execPath);
  const composed = compose({
    name: app.getName(),
    version: app.getVersion(),
    dataDir: app.getPath("userData"),
    // DPAPI on Windows, Keychain on macOS. Where neither is there, the vault
    // refuses to store a key rather than writing it in the clear.
    cipher: {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plain) => safeStorage.encryptString(plain),
      decrypt: (sealed) => safeStorage.decryptString(sealed),
    },
    pickFolder: async () => {
      const options = { properties: ["openDirectory" as const], title: "选择团队的项目文件夹" };
      const picked =
        window === undefined ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(window, options);
      return picked.canceled ? null : (picked.filePaths[0] ?? null);
    },
    pickFiles: async () => {
      const options = {
        properties: ["openFile" as const, "multiSelections" as const],
        title: "选择要给团队看的资料",
        filters: [
          {
            name: "资料",
            extensions: ["pdf", "docx", "md", "txt", "csv", "json", "png", "jpg", "jpeg", "gif", "webp"],
          },
          { name: "所有文件", extensions: ["*"] },
        ],
      };
      const picked =
        window === undefined ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(window, options);
      return picked.canceled ? [] : picked.filePaths;
    },
    // Electron's own notifier: the same on Windows, macOS and Linux (2.x had
    // only osascript and notify-send, so Windows got nothing). Clicking one
    // brings the window up on the team it is about.
    notify: (banner, teamId) => {
      if (!Notification.isSupported()) return;
      const shown = new Notification({ title: banner.title, body: banner.body, silent: false });
      shown.on("click", () => {
        if (window === undefined || window.isDestroyed()) return;
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
        window.webContents.send(EVENT_CHANNEL, "team.open", { teamId });
      });
      // Said in the log when the system refuses it: there is nowhere else a
      // failed notification can be reported, and nothing at all is worse.
      shown.on("failed", (_event, error) => console.warn(`系统通知没能弹出：${error}`));
      shown.show();
    },
    isFocused: () => {
      // Minimised or hidden is not in front, whatever isFocused says: Electron
      // was seen reporting a minimised window as focused, and no banner came.
      const focused =
        window !== undefined &&
        !window.isDestroyed() &&
        window.isVisible() &&
        !window.isMinimized() &&
        window.isFocused();
      return focused;
    },
    push: (event, data) => {
      if (window !== undefined && !window.isDestroyed()) window.webContents.send(EVENT_CHANNEL, event, data);
    },
    // The title bar, menus and the page's `prefers-color-scheme` all follow
    // this, so a dark page never sits under a white frame.
    applyTheme: (theme) => {
      nativeTheme.themeSource = theme;
    },
    applyFontScale: (scale) => {
      fontScale = scale;
      if (window !== undefined && !window.isDestroyed()) window.webContents.setZoomFactor(scale);
    },
  });
  nativeTheme.themeSource = composed.theme();
  fontScale = composed.fontScale();
  protocol.handle("squad-media", async (request) => {
    const path = decodeURIComponent(new URL(request.url).pathname.replace(/^\/+/, ""));
    try {
      const media = await composed.readMedia(path);
      return new Response(new Uint8Array(media.bytes), { headers: { "content-type": media.contentType } });
    } catch (error) {
      return new Response(error instanceof Error ? error.message : String(error), { status: 404 });
    }
  });
  const dispatch = createDispatcher(composed.handlers);
  ipcMain.handle(INVOKE_CHANNEL, (_event, method: unknown, payload: unknown) => dispatch(method, payload));

  /**
   * Quitting stops every seat first. A seat is a CLI agent running tools in
   * the project folder; leaving it running after the window is gone means a
   * build or a test suite still writing files that nobody can see or stop.
   */
  let stopping = false;
  app.on("before-quit", (event) => {
    if (stopping) return;
    stopping = true;
    event.preventDefault();
    void composed.table.stopAll().finally(() => app.quit());
  });

  window = createWindow();
  createTray(composed, app.getPath("userData"));
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) window = createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
