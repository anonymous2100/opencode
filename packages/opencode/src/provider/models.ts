import { Effect, Schema } from "effect"
import { isRecord } from "@/util/record"

const TIMEOUT = 10_000

export const DiscoverInput = Schema.Struct({
  baseURL: Schema.String,
  apiKey: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})
export type DiscoverInput = Schema.Schema.Type<typeof DiscoverInput>

export const DiscoveredModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
})
export type DiscoveredModel = Schema.Schema.Type<typeof DiscoveredModel>

export const DiscoveredModels = Schema.Array(DiscoveredModel)

export class DiscoverFailed extends Schema.TaggedErrorClass<DiscoverFailed>()("ProviderModelsDiscoverFailed", {
  message: Schema.String,
  status: Schema.optional(Schema.Number),
}) {}

export function discover(input: DiscoverInput): Effect.Effect<DiscoveredModel[], DiscoverFailed> {
  return Effect.tryPromise({
    try: () => request(input),
    catch: (error) =>
      new DiscoverFailed({
        message: error instanceof Error ? error.message : String(error),
        status: error instanceof RequestFailed ? error.status : undefined,
      }),
  })
}

class RequestFailed extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

// OpenAI-compatible gateways expose `GET {baseURL}/models`. Some deployments
// already include the version segment in the configured base URL while others
// expect us to add it, so the literal path is tried before `/v1/models`.
async function request(input: DiscoverInput): Promise<DiscoveredModel[]> {
  const base = input.baseURL.trim().replace(/\/+$/, "")
  const headers: Record<string, string> = { accept: "application/json", ...input.headers }
  const key = input.apiKey?.trim()
  if (key) headers.authorization = `Bearer ${key}`

  const urls = /\/v\d+$/.test(base) ? [`${base}/models`] : [`${base}/models`, `${base}/v1/models`]
  let failure: RequestFailed | undefined

  for (const url of urls) {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT) }).catch((error: unknown) => {
      failure = new RequestFailed(`Could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    })
    if (!response) break

    if (!response.ok) {
      failure = new RequestFailed(`${url} returned ${response.status}`, response.status)
      if (response.status === 404 || response.status === 405) continue
      break
    }

    const models = parse(await response.json().catch(() => undefined))
    if (models.length > 0) return models
    failure = new RequestFailed(`${url} did not return any models`)
    break
  }

  throw failure ?? new RequestFailed("No model endpoint responded")
}

function parse(payload: unknown): DiscoveredModel[] {
  const seen = new Set<string>()
  return rows(payload).flatMap((item) => {
    const model = normalize(item)
    if (!model || seen.has(model.id)) return []
    seen.add(model.id)
    return [model]
  })
}

function rows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (!isRecord(payload)) return []
  if (Array.isArray(payload.data)) return payload.data
  if (Array.isArray(payload.models)) return payload.models
  return []
}

function normalize(item: unknown): DiscoveredModel | undefined {
  if (typeof item === "string") {
    const id = item.trim()
    return id ? { id, name: id } : undefined
  }
  if (!isRecord(item) || typeof item.id !== "string") return undefined
  const id = item.id.trim()
  if (!id) return undefined
  const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : id
  return { id, name }
}

export * as ProviderModels from "./models"
