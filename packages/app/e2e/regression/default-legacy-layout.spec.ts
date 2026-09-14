import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"

const draftID = "draft_default_legacy_layout"
const directory = "C:/OpenCode/DefaultLegacyLayout"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

test("defaults to the legacy layout when no preference is stored", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: "proj_default_legacy_layout",
      worktree: directory,
      vcs: "git",
      name: "default-legacy-layout",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: { all: [], connected: [], default: {} },
    sessions: [],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(
    ({ directory, draftID, server }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: {} }))
      localStorage.setItem("app-version.v1", JSON.stringify({ version: "1.17.20" }))
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([{ type: "draft", draftID, server, directory }]),
      )
    },
    { directory, draftID, server },
  )

  await page.goto(`/new-session?draftId=${draftID}`)

  await expect(page).toHaveURL(`/${base64Encode(directory)}/session`)
  await expect(page.locator("header[data-tauri-drag-region]")).toBeVisible()
  await expect(page.locator('[data-component="prompt-input"]')).toBeVisible()
})
