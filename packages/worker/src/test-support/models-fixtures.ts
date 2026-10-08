// An array-form local example (the verbatim object form is pinned in
// models-config-schema.test.ts). Local-first,
// zero paid tokens — the CI-safe provider.
export const LOCAL_MODELS_EXAMPLE = {
  providers: [
    {
      id: 'local',
      name: 'Local (Ollama-style)',
      baseUrl: 'http://localhost:11434/v1',
      api: 'openai-completions',
      models: [
        {
          id: 'llama3',
          name: 'Llama 3 (local)',
          contextWindow: 8192,
          maxTokens: 2048,
          inputCost: 0,
          outputCost: 0,
        },
      ],
    },
  ],
} as const;
