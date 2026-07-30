# Mock Fixture Template

This directory is a **generic template** for e2e-device mock fixtures.
Skill code contains NO business data — all fixture content belongs to the host repo.

## How to use

1. Copy this directory into your host repo: `<host-root>/e2e-device/fixtures/<your-domain>/`
2. Replace placeholder values with your actual API responses
3. Edit `states.json` to map matrix keywords to mock profiles
4. Run `bash scripts/list-preconfig.sh --project <host-root>` to refresh the manifest

## Files

| File | Purpose |
|------|---------|
| `states.json` | Maps mock profiles to fixture route sets; drives `E2E_MOCK_PROFILE` |
| `example.ok.json` | Generic API response envelope (`code` / `message` / `data`) |

## states.json schema

```json
{
  "gateParam": "<query-param-name-for-deep-link-gate>",
  "matrixKeywords": {
    "<matrix-expected-keyword>": "<profile-id>"
  },
  "states": [
    {
      "id": "<profile-id>",
      "profile": "<profile-name>",
      "routes": ["<fixture-route-id-1>", "<fixture-route-id-2>"],
      "source": "matrix"
    }
  ]
}
```

- `gateParam`: the deep-link query parameter used to select a mock state at launch time
- `matrixKeywords`: maps验收矩阵 expected keywords to profile IDs (heuristic)
- `states[].routes`: fixture file names (without `.json`) whose API responses should be mocked for this profile

## Fixture JSON convention

Each fixture file should follow your project's API response envelope.
A generic `code/message/data` envelope is shown in `example.ok.json`.

## Mock boundaries

Inject mock (`web-request-mock.js`) intercepts **WebView JS fetch/XHR only**.
If your app uses native HTTP (OkHttp/Retrofit), configure a proxy or native mock layer instead.
See [mock-strategies.md](../../../references/mock-strategies.md) for details.
