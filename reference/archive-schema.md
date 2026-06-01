# archive.json 契约 v1

```json
{
  "runId": "run-<timestamp>",
  "startedAt": "ISO-8601",
  "finishedAt": "ISO-8601",
  "status": "running|passed|failed|partial",
  "sections": {
    "plan": {},
    "execution": {},
    "resilience": {},
    "issues": [
      {
        "id": "string",
        "severity": "low|medium|high",
        "title": "string",
        "repro": "string",
        "cause": "string",
        "autoFixAttempted": true,
        "autoFixResult": "optional",
        "resolved": false
      }
    ],
    "artifacts": ["relative/paths"],
    "hybridEvidence": {}
  }
}
```

由 orchestration `write-archive` 写入；WebdriverIO 结束后由 `issue-ledger` 同步。
