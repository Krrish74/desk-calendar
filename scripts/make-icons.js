// make-icons.js: renders src/assets/icon.svg into the PNG and ICO files the app needs.
// Run with:  npm run icons     (uses Electron's own Chromium to rasterize the SVG)
//
// Outputs:
//   src/assets/icon-16.png, icon-32.png, icon-64.png, icon-256.png   (tray + window icon)
//   build/icon.ico   (multi-size icon electron-builder puts on the .exe and installer)

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SVG = fs.readFileSync(path.join(ROOT, 'src/assets/icon.svg'), 'utf8');
const PNG_SIZES = [16, 32, 64, 256];
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 256];

app.disableHardwareAcceleration();

// Render the SVG once at 256 px; smaller sizes are high-quality downscales of it.
async function renderMaster() {
  const S = 256;
  const win = new BrowserWindow({ width: S, height: S, show: false, frame: false, transparent: true,
    useContentSize: true, webPreferences: { offscreen: true } });
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden">
    <img src="data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}" width="${S}" height="${S}"></body></html>`;
  await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: S, height: S });
  win.destroy();
  return img.resize({ width: S, height: S });
}

let master;
const render = (size) => master.resize({ width: size, height: size, quality: 'best' }).toPNG();

// An .ico is a small header + directory, followed by the images. Modern Windows
// accepts PNG-compressed images inside, so we just embed the PNG bytes.
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach(({ size, png }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);      // width (0 means 256)
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);  // height
    dir.writeUInt16LE(1, o + 4);                    // color planes
    dir.writeUInt16LE(32, o + 6);                   // bits per pixel
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...images.map((x) => x.png)]);
}

app.whenReady().then(async () => {
  fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true });
  master = await renderMaster();
  for (const size of PNG_SIZES) {
    fs.writeFileSync(path.join(ROOT, `src/assets/icon-${size}.png`), render(size));
  }
  const images = ICO_SIZES.map((size) => ({ size, png: render(size) }));
  fs.writeFileSync(path.join(ROOT, 'build/icon.ico'), buildIco(images));
  console.log('Icons written.');
  app.quit();
});
