// make-icons.js: renders src/assets/icon.svg into the PNG and ICO files the app needs.
// Run with:  npm run icons     (uses Electron's own Chromium to rasterize the SVG)
//
// Outputs:
//   src/assets/icon-16.png, icon-32.png, icon-64.png, icon-256.png   (tray + window icon)
//   src/assets/icon-512.png   (Mac Dock icon while running from source)
//   src/assets/trayTemplate.png, trayTemplate@2x.png   (Mac menu bar icon: black + transparent,
//       drawn from the Fluent calendar icon; macOS recolours it for light / dark menu bars)
//   build/icon.ico   (multi-size icon electron-builder puts on the .exe and installer)
//   build/icon.png   (1024 px; electron-builder turns it into the Mac app's .icns)

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SVG = fs.readFileSync(path.join(ROOT, 'src/assets/icon.svg'), 'utf8');
const TRAY_SVG = fs.readFileSync(path.join(ROOT, 'src/assets/icons/calendar_ltr_20_regular.svg'), 'utf8');
const PNG_SIZES = [16, 32, 64, 256, 512];
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 256];

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {}); // keep running between renders; app.quit() at the end

// Render an SVG at S px. The app icon is rendered once at 1024 px; smaller sizes are
// high-quality downscales of it.
async function renderSvg(svg, S) {
  const win = new BrowserWindow({ width: S, height: S, show: false, frame: false, transparent: true,
    useContentSize: true, webPreferences: { offscreen: true } });
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden">
    <img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${S}" height="${S}"></body></html>`;
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
  master = await renderSvg(SVG, 1024);
  for (const size of PNG_SIZES) {
    fs.writeFileSync(path.join(ROOT, `src/assets/icon-${size}.png`), render(size));
  }
  fs.writeFileSync(path.join(ROOT, 'build/icon.png'), master.toPNG());
  // Menu bar template: 16 pt, plus 32 px for Retina (downscaled from a 256 px render).
  const tray = await renderSvg(TRAY_SVG, 256);
  for (const [name, size] of [['trayTemplate.png', 16], ['trayTemplate@2x.png', 32]]) {
    fs.writeFileSync(path.join(ROOT, 'src/assets', name), tray.resize({ width: size, height: size, quality: 'best' }).toPNG());
  }
  const images = ICO_SIZES.map((size) => ({ size, png: render(size) }));
  fs.writeFileSync(path.join(ROOT, 'build/icon.ico'), buildIco(images));
  console.log('Icons written.');
  app.quit();
});
