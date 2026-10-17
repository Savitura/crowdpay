# Embeddable campaign progress widget

The progress widget renders a campaign's live funding progress on any third
party site — a blog, a partner page, a creator's own site. It shows the amount
raised against the goal, backer count, days remaining, milestone progress and a
short list of recent backers.

Two hosts serve the same widget contract:

| Host | Entry point | Behaviour |
| --- | --- | --- |
| CrowdPay SPA | `/embed-widget.js` (`data-*` script tag) | Injects a sandboxed iframe pointing at `/embed/campaigns/:id`. |
| Static iframe | `/api/embed/widget.html` / `/widget.html` | Standalone HTML widget (milestone progress bar, `#596`). |

## Embedding

```html
<script
  src="https://app.crowdpay.com/embed-widget.js"
  data-campaign="00000000-0000-0000-0000-000000000000"
  data-theme="light"
  data-size="large"
  async
></script>
```

| Attribute | Values | Default | Meaning |
| --- | --- | --- | --- |
| `data-campaign` | campaign UUID | — | Required. Without it the script is a no-op. |
| `data-theme` | `light`, `dark` | `light` | Colour scheme. |
| `data-size` | `small`, `medium`, `large` | `medium` | `small` hides description/milestones; `large` adds milestones and recent backers. |

A raw iframe is also supported:

```html
<iframe
  src="https://app.crowdpay.com/embed/campaigns/<campaign-id>?theme=dark&size=large"
  width="480"
  height="280"
  title="CrowdPay campaign embed"
></iframe>
```

### PostMessage protocol

* The widget posts `{ type: 'resize', height }` to the embedding page (targeted
  at the `origin` query parameter, or `document.referrer`'s origin, falling back
  to `*`). The host script resizes the iframe; it never needs to know the
  content height in advance.
* The host script re-emits contribution events as a `crowdpay:contribution`
  `CustomEvent` so pages can react without polling.
* A host page can open the contribution flow by dispatching a
  `crowdpay:open` event with `{ detail: { campaignId } }`.

## Data contract

The widget calls `GET /api/campaigns/:id/widget`:

```json
{
  "id": "…",
  "title": "Solar grid",
  "description": "Community owned solar",
  "raised_amount": 5000,
  "target_amount": 10000,
  "asset_type": "USDC",
  "status": "active",
  "contributor_count": 25,
  "days_remaining": 10,
  "progress_percentage": 50,
  "contribution_url": "https://app.crowdpay.com/campaigns/…",
  "milestones": [],
  "milestone_summary": { "total": 0, "released": 0, "approved": 0, "submitted": 0, "pending": 0 },
  "recent_backers": [{ "name": "Alice", "amount": 250 }]
}
```

The widget polls this endpoint every 30 seconds and the response carries
`Cache-Control: public, max-age=30`, so a browser or CDN cache absorbs the poll
on heavily embedded campaign pages.

## User-facing states

| State | Rendering |
| --- | --- |
| Loading | `Loading campaign progress…` (`role="status"`). |
| Success | Title, status badge, description, progress bar, backer count, days left, milestones (large), recent backers (large) and the contribute link. |
| Empty | `Be the first to back this campaign.` when the campaign has no contributions yet. |
| Failure | The error message (`Campaign not found` for a 404) plus a `Try again` button, announced with `role="alert"`. |

## Privacy and limits

* Only public summary fields are served. There is no creator/contributor id,
  wallet address, email or transaction hash in the payload.
* Soft-deleted and hidden campaigns return `404`, which the widget renders as a
  failure state rather than an empty widget.
* `recent_backers` applies the same two privacy gates as the in-app backer list:
  the campaign's `show_backer_amounts` flag and each contributor's
  `contributor_privacy` preference. Anonymous contributors are omitted entirely;
  `amount_only` contributors appear without a name; hidden amounts are `null`
  and the widget renders no amount cell.
* `recent_backers` is capped at the three most recent contributions.
* `description` is truncated to 200 characters server-side.
* Requests are rate limited by `embedStatsLimiter`.

## Legacy

`GET /api/embed/:campaignId/stats` is retained for backwards compatibility but
is no longer used by the widget: it returned a `{ campaign, recentContributors }`
envelope that did not match the fields the widget renders, which is why the
embedded progress view appeared empty. `GET /api/campaigns/:id/widget` is the
single supported contract.
