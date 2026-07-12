# Load tests

[k6](https://k6.io) load-testing scripts for the CrowdPay API.

| Script | Scenario |
|---|---|
| `browse.js` | Anonymous browsing — homepage campaign list, campaign detail, contributions (ramps to 100 VUs) |
| `contribute.js` | Authenticated flow — login, view campaign, submit contribution (ramps to 50 VUs) |

## Running

```sh
k6 run load-tests/browse.js
```

Before running, edit the target host (`https://your-app.com`) and the placeholder
`campaignId` / credentials in each script to point at the environment under test.
