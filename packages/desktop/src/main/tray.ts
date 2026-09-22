import { app, Menu, nativeImage, Tray } from "electron"
import { createMainWindow, iconPath, setAppQuitting, showMainWindows, smallIconPath } from "./windows"
import { nativeT } from "./native-translations"
import { write as writeLog } from "./logging"

let tray: Tray | undefined

export function createTray() {
  if (tray) return tray
  const small = nativeImage.createFromPath(smallIconPath())
  tray = new Tray(small.isEmpty() ? iconPath() : small)
  tray.setToolTip("OpenCode")
  tray.setContextMenu(buildMenu())
  // Left-click shows the window; on Windows the context menu opens on
  // right-click and the click event does not fire, so these do not collide.
  tray.on("click", () => showMainWindows())
  writeLog("tray", "created tray icon")
  return tray
}

export function destroyTray() {
  if (!tray) return
  tray.destroy()
  tray = undefined
  writeLog("tray", "destroyed tray icon")
}

function buildMenu() {
  return Menu.buildFromTemplate([
    { label: nativeT("desktop.tray.show"), click: () => showMainWindows() },
    { label: nativeT("desktop.tray.newWindow"), click: () => void createMainWindow() },
    { type: "separator" },
    {
      label: nativeT("desktop.tray.quit"),
      click: () => {
        setAppQuitting()
        app.quit()
      },
    },
  ])
}
