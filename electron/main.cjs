// Tale of Tiles Studio als desktop-app (eigen venster, geen browser).
// Start de lokale studio-server en toont 'm in een Electron-venster.
//
// STABILITEIT (28 okt): de app werd soms helemaal WIT tijdens gebruik en bleef zo hangen. Dat
// gebeurt als (a) het weergave-proces crasht, (b) het venster vastloopt bij een zware render, of
// (c) de server achter het venster wegvalt. De oude code ving alleen een MISLUKTE EERSTE lading
// op (did-fail-load). Nu vangen we alle drie op en herstelt de app zichzelf i.p.v. wit te blijven:
//   - render-process-gone / unresponsive  -> venster herladen
//   - server weg / antwoordt niet          -> server herstarten, dan herladen
//   - did-fail-load                        -> opnieuw proberen tot de server antwoordt
const { app, BrowserWindow, shell } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const URL = "http://localhost:4600";
let server, win;
let serverStarting = false;   // voorkomt dat we de server dubbel opstarten
// Herstart-rem: als de server telkens meteen crasht (bv. kapotte code), niet eindeloos herstarten.
// Max 5 herstarts binnen 60s; daarna stoppen we met herstarten (het venster toont dan de laatste
// staat i.p.v. een CPU-vretende herstart-lus).
let restarts = [], RESTART_MAX = 5, RESTART_WINDOW = 60000;
function mayRestart() { const now = Date.now(); restarts = restarts.filter((t) => now - t < RESTART_WINDOW); if (restarts.length >= RESTART_MAX) return false; restarts.push(now); return true; }

function startServer() {
  if (serverStarting) return;
  serverStarting = true;
  // Draai de studio-server als los Node-proces (STUDIO_NO_OPEN: Electron toont het venster).
  server = spawn(process.platform === "win32" ? "node.exe" : "node", [path.join(ROOT, "src", "engine.mjs")], {
    cwd: ROOT,
    env: { ...process.env, STUDIO_NO_OPEN: "1" },
    stdio: "inherit",
  });
  server.on("error", (e) => { console.error("server start faalde:", e.message); serverStarting = false; });
  // Valt de server tijdens gebruik om (crash/geheugen), dan herstarten we 'm automatisch en
  // herladen het venster zodra hij weer antwoordt. Zo blijft het venster nooit wit hangen.
  server.on("exit", (code) => {
    serverStarting = false;
    if (code === 0) return;             // nette stop (bv. bij afsluiten) -> niks doen
    if (!mayRestart()) { console.error("server crasht herhaaldelijk -> herstart gestopt (los de fout op en start npm run app opnieuw)"); return; }
    console.error("server stopte onverwacht (code " + code + ") -> herstarten");
    startServer();
    waitForServer(() => reloadWindow());
  });
}

// Wacht tot de server op :4600 antwoordt (hij luistert pas NÁ init: sfeer-/mockup-beelden + esbuild).
// ~90s ruim genoeg voor een koude start; daarna toch de callback zodat we niet eindeloos wachten.
function waitForServer(cb, tries = 300) {
  const req = http.get(URL, () => { req.destroy(); cb(); });
  req.on("error", () => { if (tries > 0) setTimeout(() => waitForServer(cb, tries - 1), 300); else cb(); });
  req.setTimeout(2000, () => { req.destroy(); });
}

// Venster (opnieuw) laden, maar alleen als de server echt antwoordt -> nooit een wit vlak.
let reloading = false;
function reloadWindow() {
  if (reloading || !win || win.isDestroyed()) return;
  reloading = true;
  waitForServer(() => {
    reloading = false;
    if (win && !win.isDestroyed()) win.loadURL(URL);
  });
}

function createWindow() {
  // App-icoon = de zellige-rozet uit het Tale of Tiles-logo (.ico op Windows, .png elders).
  const iconFile = process.platform === "win32" ? "icon.ico" : "icon.png";
  const iconPath = path.join(ROOT, "assets", "brand", iconFile);
  win = new BrowserWindow({
    width: 1240, height: 860, minWidth: 980, minHeight: 700,
    title: "Tale of Tiles Studio", backgroundColor: "#1a1327",
    icon: iconPath,
    autoHideMenuBar: true,
  });
  win.loadURL(URL);
  // (a) MISLUKTE LADING (server net nog niet klaar, of even weg): opnieuw proberen tot 'ie antwoordt.
  win.webContents.on("did-fail-load", () => { setTimeout(() => reloadWindow(), 700); });
  // (b) WEERGAVE-PROCES GECRASHT: het venster wordt wit. Herladen i.p.v. wit laten hangen.
  win.webContents.on("render-process-gone", (_e, details) => {
    console.error("weergave-proces weg (" + (details && details.reason) + ") -> herladen");
    setTimeout(() => reloadWindow(), 500);
  });
  // (c) VENSTER VASTGELOPEN (bv. zware render blokkeert de pagina): forceer een herlaad.
  win.on("unresponsive", () => {
    console.error("venster reageert niet -> herladen");
    reloadWindow();
  });
  // de pagina-<title> niet het venster laten overschrijven -> blijft "Tale of Tiles Studio"
  win.on("page-title-updated", (e) => e.preventDefault());
  // externe links in de standaardbrowser openen, niet in het app-venster
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
}

app.whenReady().then(() => {
  // zorgt dat Windows het venster-icoon ook in de taakbalk toont (en apart groepeert)
  if (process.platform === "win32" && app.setAppUserModelId) app.setAppUserModelId("com.taleoftiles.studio");
  startServer(); waitForServer(createWindow);
});
app.on("window-all-closed", () => { if (server) server.kill(); app.quit(); });
app.on("before-quit", () => { if (server) server.kill(); });
