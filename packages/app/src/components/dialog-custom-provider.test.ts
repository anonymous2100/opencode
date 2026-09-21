import { describe, expect, test } from "bun:test"
import { mergeModels, validateCustomProvider } from "./dialog-custom-provider-form"

const t = (key: string) => key

describe("validateCustomProvider", () => {
  test("builds trimmed config payload", () => {
    const result = validateCustomProvider({
      form: {
        providerID: "custom-provider",
        name: " Custom Provider ",
        baseURL: "https://api.example.com ",
        apiKey: " {env: CUSTOM_PROVIDER_KEY} ",
        models: [{ row: "m0", id: " model-a ", name: " Model A ", err: {} }],
        headers: [
          { row: "h0", key: " X-Test ", value: " enabled ", err: {} },
          { row: "h1", key: "", value: "", err: {} },
        ],
        err: {},
      },
      t,
      disabledProviders: [],
      existingProviderIDs: new Set(),
    })

    expect(result.result).toEqual({
      providerID: "custom-provider",
      name: "Custom Provider",
      key: undefined,
      config: {
        npm: "@ai-sdk/openai-compatible",
        name: "Custom Provider",
        env: ["CUSTOM_PROVIDER_KEY"],
        options: {
          baseURL: "https://api.example.com",
          headers: {
            "X-Test": "enabled",
          },
        },
        models: {
          "model-a": { name: "Model A" },
        },
      },
    })
  })

  test("flags duplicate rows and allows reconnecting disabled providers", () => {
    const result = validateCustomProvider({
      form: {
        providerID: "custom-provider",
        name: "Provider",
        baseURL: "https://api.example.com",
        apiKey: "secret",
        models: [
          { row: "m0", id: "model-a", name: "Model A", err: {} },
          { row: "m1", id: "model-a", name: "Model A 2", err: {} },
        ],
        headers: [
          { row: "h0", key: "Authorization", value: "one", err: {} },
          { row: "h1", key: "authorization", value: "two", err: {} },
        ],
        err: {},
      },
      t,
      disabledProviders: ["custom-provider"],
      existingProviderIDs: new Set(["custom-provider"]),
    })

    expect(result.result).toBeUndefined()
    expect(result.err.providerID).toBeUndefined()
    expect(result.models[1]).toEqual({
      id: "provider.custom.error.duplicate",
      name: undefined,
    })
    expect(result.headers[1]).toEqual({
      key: "provider.custom.error.duplicate",
      value: undefined,
    })
  })
})

describe("mergeModels", () => {
  test("keeps user rows and appends discovered models that are new", () => {
    const merged = mergeModels(
      [
        { row: "m0", id: "model-a", name: "My Model A", err: {} },
        { row: "m1", id: "", name: "", err: {} },
      ],
      [
        { id: "model-a", name: "Model A" },
        { id: " model-b ", name: "" },
        { id: "model-b", name: "Duplicate" },
      ],
    )

    expect(merged.map((row) => ({ id: row.id, name: row.name }))).toEqual([
      { id: "model-a", name: "My Model A" },
      { id: "model-b", name: "model-b" },
    ])
  })

  test("keeps duplicate user rows for validation to flag", () => {
    const merged = mergeModels(
      [
        { row: "m0", id: "model-a", name: "A", err: {} },
        { row: "m1", id: "model-a", name: "A duplicate", err: {} },
      ],
      [{ id: "model-a", name: "Model A" }],
    )

    expect(merged.map((row) => row.name)).toEqual(["A", "A duplicate"])
  })
})
