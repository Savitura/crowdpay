# Team fundraising pages (#952)

A campaign can act as a **team parent** that groups other campaigns
(**team members**) under one fundraising page. Members keep their own
wallets, contributions, milestones, and withdrawals — the parent page only
aggregates and links. Nothing about solo campaigns changes.

## Data model

`team_campaign_members` (see `backend/db/migrations/20260929_team_fundraising_pages.sql`):

| column              | notes                                        |
| ------------------- | -------------------------------------------- |
| parent_campaign_id  | the grouping campaign page                   |
| member_campaign_id  | UNIQUE — one team membership per campaign    |
| role                | `owner` (lead) or `member`                   |
| display_order       | ordering on the parent page                  |
| invited_by          | user who attached the member                 |

Integrity rules enforced in the schema and service:

- A campaign cannot be a member of itself.
- A campaign can be a parent **or** a member, never both — this also makes
  cycles unrepresentable (joining a cycle would require being both an
  ancestor and a descendant of the same campaign).
- Membership is the single source of truth: a campaign "is a parent" when it
  has member rows.

## API

Mounted under `/api/campaigns` (`backend/src/routes/teamCampaigns.js`):

| method   | path                            | auth                | behavior                                                              |
| -------- | ------------------------------- | ------------------- | --------------------------------------------------------------------- |
| `GET`    | `/:id/team`                     | public              | aggregated team page; 404 when the campaign is unknown                 |
| `POST`   | `/:id/team/members`             | owner or admin      | adds a member; 403 non-owner, 404 unknown ids, 422 integrity rejections |
| `DELETE` | `/:id/team/members/:memberId`   | owner or admin      | removes a member; 404 for unknown membership                           |

Re-adds are idempotent: the `member_campaign_id` UNIQUE constraint plus an
upsert means a duplicate or concurrent add resolves to the same membership
row instead of erroring or duplicating.

## Operational notes

- The aggregated payload is computed on read (no cache invalidation needed);
  the query is two indexed lookups plus an in-process rollup.
- Member deletions cascade: removing a parent campaign deletes its membership
  rows; deleting a member campaign removes it from the team.
- No secrets are handled by this feature; nothing new is logged beyond the
  parent/member ids on add.
