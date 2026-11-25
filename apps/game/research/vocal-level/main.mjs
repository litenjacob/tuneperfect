import { resolve } from "node:path";

import { BrowserWindow, app, protocol } from "electron";

import { fileResponse } from "../../electron/protocols/file-response";
import { registerSchemes } from "../../electron/protocols/schemes";

const [directory, audioPath, mode] = process.argv.slice(2);
if (!directory || !audioPath) throw new Error("Pass the demo directory and a four-channel FLAC path");

const songFile = resolve(audioPath);
const checking = mode === "--check" || mode === "--check-song";
const appOrigin = "app://vocal-level";
const assets = new Map([
  ["/", resolve(directory, "index.html")],
  ["/renderer.js", resolve(directory, "renderer.js")],
  ["/measure.js", resolve(directory, "measure.js")],
]);
let ranges = 0;

app.setName("TunePerfect Vocal Level");
app.setPath("userData", resolve(app.getPath("temp"), "tuneperfect-vocal-level"));
registerSchemes();
if (checking) app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
async function run() {
  await app.whenReady();
  protocol.handle("app", (request) => {
    const file = assets.get(new URL(request.url).pathname);
    if (!file) return new Response(null, { status: 404 });
    // The game file handler recognizes media types. The harness also serves its own scripts and page.
    return fileResponse(request, file, {
      "Content-Security-Policy": "default-src 'self'; media-src media:; style-src 'unsafe-inline'",
    }).then((response) => {
      response.headers.set("Content-Type", file.endsWith(".html") ? "text/html" : "text/javascript");
      return response;
    });
  });
  protocol.handle("media", (request) => {
    const { host, pathname } = new URL(request.url);
    if (host !== "vocal-level" || pathname !== "/song.flac") return new Response(null, { status: 404 });
    if (request.headers.has("range")) ranges++;
    return fileResponse(request, songFile, { "Access-Control-Allow-Origin": appOrigin });
  });

  const window = new BrowserWindow({
    title: "TunePerfect Vocal Level",
    width: 540,
    height: 340,
    show: !checking,
    webPreferences: { backgroundThrottling: false },
  });
  await window.loadURL(`${appOrigin}/`);
  if (checking) {
    const timeout = setTimeout(() => {
      console.error("Audio check timed out");
      app.exit(1);
    }, 20_000);
    try {
      const results = await window.webContents.executeJavaScript(`checkPlayback(${mode === "--check"})`);
      if (ranges < 1) throw new Error("Expected a byte-range media request");
      console.log(
        JSON.stringify(
          { electron: process.versions.electron, chromium: process.versions.chrome, ranges, ...results },
          null,
          2,
        ),
      );
      app.exit(0);
    } catch (error) {
      console.error(error);
      app.exit(1);
    } finally {
      clearTimeout(timeout);
    }
  }
  app.on("window-all-closed", () => app.quit());
}

void run().catch((error) => {
  console.error(error);
  app.exit(1);
});
