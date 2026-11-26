# Campaign Data Room with Role-Based Access Control

## Overview

CrowdPay's **Campaign Data Room** is a secure, role-governed document repository built to support comprehensive due diligence, investor transparency, financial disclosures, and governance tracking for fundraising campaigns.

Campaign creators, managers, and collaborators often need to share sensitive documents—such as cap tables, audited balance sheets, software architecture diagrams, legal incorporation filings, and pitch decks—with different classes of stakeholders. The Data Room enforces granular **Role-Based Access Control (RBAC)** across the entire document lifecycle and maintains a tamper-evident audit log of all access events.

---

## Role & Permission Hierarchy

Every user visiting a campaign's data room is resolved to an effective campaign role with hierarchical clearance:

```
┌───────────────────────────────────────────────┐
│              Platform Admin                   │  (Full access across all campaigns)
├───────────────────────────────────────────────┤
│            Campaign Owner / Creator           │  (Upload, manage, delete all, view audit logs)
├───────────────────────────────────────────────┤
│             Campaign Manager                  │  (Upload, manage <= manager, view audit logs)
├───────────────────────────────────────────────┤
│              Campaign Editor                  │  (Upload <= editor, manage own uploads)
├───────────────────────────────────────────────┤
│              Campaign Viewer                  │  (Read-only <= viewer documents)
├───────────────────────────────────────────────┤
│          Verified Backer / Contributor        │  (Read-only backer + public documents)
├───────────────────────────────────────────────┤
│         Public Visitor (Unauthenticated)      │  (Read-only public documents)
└───────────────────────────────────────────────┘
```

### Hierarchy Numeric Levels

| Role / Access Level | Numeric Level | Description |
|---|---|---|
| `public` | 0 | Anyone, including unauthenticated guests. |
| `backer` | 1 | Authenticated users who have completed a confirmed contribution to the campaign. |
| `viewer` | 2 | Team members invited with `viewer` role. |
| `editor` | 3 | Team members invited with `editor` role (can upload up to editor level). |
| `manager` | 4 | Team members with `manager` role (can upload/manage and view audit logs). |
| `owner` | 5 | Campaign creator or team members with `owner` role, plus platform admins. |

### Access Rules Summary

1. **Read & Download**:
   - A caller can view and download any active document whose `access_level` numeric level is less than or equal to the caller's resolved role level (`userLevel >= fileLevel`).
   - If an unauthenticated caller requests a document with `access_level != 'public'`, the server returns `401 Unauthorized`.
   - If an authenticated user lacks the required level, the server returns `403 Forbidden`.

2. **Upload & Ingestion**:
   - Uploading requires at least `editor` role (or `manager`, `owner`, `admin`).
   - A user cannot set a target `access_level` higher than their own role (e.g. an `editor` cannot upload an `owner`-only document).

3. **Modification & Deletion**:
   - `owner` and `admin` can modify metadata or delete any document in the data room.
   - `manager` can modify metadata or delete any document with `access_level <= 'manager'`.
   - `editor` can only modify or delete documents that they personally uploaded (`uploaded_by === userId`).
   - All deletions are soft-deletes (`status = 'deleted'`) to maintain audit integrity.

4. **Audit Access Trail**:
   - Only `manager`, `owner`, and `admin` can view the data room access logs.
   - Every file `view`, `download`, `upload`, `update`, and `delete` action is logged with actor identification, timestamp, IP address, and client user-agent.

---

## Document Categories

Documents in the data room can be organized into standardized categories:

- `pitch_deck`: Presentations, summary teasers, and fundraising decks.
- `financials`: Pro-forma projections, historical balance sheets, cash flow models, audit letters.
- `legal`: Articles of incorporation, SAFEs, bylaws, intellectual property assignments, terms.
- `technical`: Architecture specifications, whitepapers, security audits, benchmark reports.
- `diligence`: Founder background checks, customer references, market analyses.
- `governance`: Board resolutions, advisory agreements, tokenomics schedules.
- `other`: Supplementary attachments and announcements.

---

## Storage & Upload Processing

1. **Direct Binary Uploads**:
   - Processed via `multipart/form-data`.
   - Validated against size limits (`DATA_ROOM_MAX_FILE_SIZE = 25 MB`).
   - Validated against allowed MIME types (PDF, Office Word/Excel/PowerPoint, plaintext, CSV, Markdown, images, and ZIP archives).
   - Content-addressed SHA-256 checksum generated at upload time.
   - Streamed to S3-compatible object storage when configured (`STORAGE_ENDPOINT` and `STORAGE_BUCKET`), or served from local storage fallback.

2. **External Link Registration**:
   - Document metadata can also be registered as an external URL (e.g. DocuSign, Carta, virtual data rooms, Google Drive) with full role-based access control.

---

## Security, Privacy & Compliance Considerations

- **Tamper-Evident Hashing**: Uploaded files have their SHA-256 hash calculated and stored at upload time.
- **Access Isolation**: Confidential documents are never publicly listed or accessible without backend authentication and role authorization checks.
- **Audit Logging**: Every access attempt (download or view) creates an append-only log entry in `campaign_data_room_access_logs`, ensuring full visibility into who has reviewed sensitive due diligence materials.
- **Cascading Retention**: Deleting a campaign automatically purges its data room files and access logs via foreign key `ON DELETE CASCADE`.

---

## API Quick Reference

| Method | Endpoint | Access Requirement | Description |
|---|---|---|---|
| `GET` | `/api/campaigns/:id/data-room/files` | Optional Auth (Public/Role-filtered) | List accessible documents and category counts |
| `POST` | `/api/campaigns/:id/data-room/files` | Editor+ (Requires Auth) | Upload or register a new document |
| `GET` | `/api/campaigns/:id/data-room/files/:fileId` | Role-filtered | Get single document metadata (logs 'view') |
| `GET` | `/api/campaigns/:id/data-room/files/:fileId/download` | Role-filtered | Download document file (logs 'download') |
| `PATCH` | `/api/campaigns/:id/data-room/files/:fileId` | Uploader (Editor+) or Manager+ | Update document title, category, or access level |
| `DELETE` | `/api/campaigns/:id/data-room/files/:fileId` | Uploader (Editor+) or Manager+ | Soft-delete document |
| `GET` | `/api/campaigns/:id/data-room/access-logs` | Manager+ (Requires Auth) | View access audit trail |
