// Tale of Tiles Studio als desktop-app (eigen venster, geen browser).
// Start de lokale studio-server en toont 'm in een Electron-venster.
const { app, BrowserWindow, shell } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const URL = "http://localhost:4599";
let server, win;

function startServer() {
  // Draai de studio-server als los Node-proces (STUDIO_NO_OPEN: Electron toont het venster).
  server = spawn(process.platform === "win32" ? "node.exe" : "node", [path.join(ROOT, "src", "studio.mjs")], {
    cwd: ROOT,
    env: { ...process.env, STUDIO_NO_OPEN: "1" },
    stdio: "inherit",
  });
  server.on("error", (e) => console.error("server start faalde:", e.message));
}

function waitForServer(cb, tries = 50) {
  const req = http.get(URL, () => { req.destroy(); cb(); });
  req.on("error", () => { if (tries > 0) setTimeout(() => waitForServer(cb, tries - 1), 300); else cb(); });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 860, minWidth: 980, minHeight: 700,
    title: "Tale of Tiles Studio", backgroundColor: "#1a1327",
    autoHideMenuBar: true,
  });
  win.loadURL(URL);
  // externe links in de standaardbrowser openen, niet in het app-venster
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
}

app.whenReady().then(() => { startServer(); waitForServer(createWindow); });
app.on("window-all-closed", () => { if (server) server.kill(); app.quit(); });
app.on("before-quit", () => { if (server) server.kill(); });
