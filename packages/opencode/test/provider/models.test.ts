import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ProviderModels } from "@/provider/models"

describe("provider models discovery", () => {
  test("reads the OpenAI model list shape and defaults the name to the id", async () => {
    using server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ object: "list", data: [{ id: "alpha" }, { id: "beta", name: "Beta" }] }),
    })

    const models = await Effect.runPromise(ProviderModels.discover({ baseURL: server.url.toString() }))

    expect(models).toEqual([
      { id: "alpha", name: "alpha" },
      { id: "beta", name: "Beta" },
    ])
  })

  test("accepts bare arrays and model envelopes while dropping unusable entries", async () => {
    using server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ models: ["alpha", "alpha", { id: "" }, { name: "no-id" }] }),
    })

    const models = await Effect.runPromise(ProviderModels.discover({ baseURL: server.url.origin }))

    expect(models).toEqual([{ id: "alpha", name: "alpha" }])
  })

  test("sends the bearer token and configured headers", async () => {
    const seen: Array<Record<string, string | null>> = []
    using server = Bun.serve({
      port: 0,
      fetch: (request) => {
        seen.push({
          path: new URL(request.url).pathname,
          authorization: request.headers.get("authorization"),
          custom: request.headers.get("x-api-key"),
        })
        return Response.json({ data: [{ id: "alpha" }] })
      },
    })

    await Effect.runPromise(
      ProviderModels.discover({ baseURL: server.url.origin, apiKey: "secret", headers: { "x-api-key": "custom" } }),
    )

    expect(seen).toEqual([{ path: "/models", authorization: "Bearer secret", custom: "custom" }])
  })

  test("retries with /v1 when the configured base URL has no version segment", async () => {
    const paths: string[] = []
    using server = Bun.serve({
      port: 0,
      fetch: (request) => {
        const path = new URL(request.url).pathname
        paths.push(path)
        if (path === "/models") return new Response("not found", { status: 404 })
        return Response.json({ data: [{ id: "alpha" }] })
      },
    })

    const models = await Effect.runPromise(ProviderModels.discover({ baseURL: server.url.origin }))

    expect(models).toEqual([{ id: "alpha", name: "alpha" }])
    expect(paths).toEqual(["/models", "/v1/models"])
  })

  test("does not append /v1 when the base URL already ends in a version", async () => {
    const paths: string[] = []
    using server = Bun.serve({
      port: 0,
      fetch: (request) => {
        paths.push(new URL(request.url).pathname)
        return Response.json({ data: [{ id: "alpha" }] })
      },
    })

    await Effect.runPromise(ProviderModels.discover({ baseURL: `${server.url.origin}/v1` }))

    expect(paths).toEqual(["/v1/models"])
  })

  test("reports the provider status when discovery fails", async () => {
    using server = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 401 }) })

    const error = await Effect.runPromise(Effect.flip(ProviderModels.discover({ baseURL: server.url.origin })))

    expect(error.status).toBe(401)
    expect(error.message).toContain("401")
  })
})
