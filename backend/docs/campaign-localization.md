# Localized campaign content

Campaign translations are stored in `campaign_translations`; existing campaign rows remain the source of default-language content. This feature does not require a schema migration. The table's `(campaign_id, language)` unique constraint makes saves atomic: saving an existing language replaces its content, including when two requests arrive at once.

## API behavior

- `GET /api/campaigns/:id?locale=<tag>` returns translated title and description when available.
- `GET /api/campaigns/:id/milestones?locale=<tag>` applies translated milestone titles by position when available.
- `GET /api/campaigns/:id/translations` lists available translations; `GET /api/campaigns/:id/translations/:locale` reads one.
- `POST /api/campaigns/:id/translations` creates or replaces a translation. The campaign creator or an administrator must be authenticated. `locale` is preferred; legacy `language` remains accepted. If both are supplied, they must resolve to the same language.
- `DELETE /api/campaigns/:id/translations/:locale` removes a translation and requires the same authorization as saving.

Supported language codes are `en`, `es`, `fr`, `de`, `it`, `pt`, `ru`, `ja`, `ko`, `zh`, `ar`, `hi`, `bn`, `pa`, `tr`, `nl`, `pl`, `sv`, `da`, and `fi`. Regional tags and underscore-separated tags resolve to their base language (`fr-CA` and `fr_CA` resolve to `fr`). Unsupported explicit locales return HTTP 400. When no translation exists for the resolved language, campaign and milestone reads retain the original campaign content. Translation lookup failures are logged with campaign ID, locale, and the error message; request content is not logged.

Translation titles are limited to 255 characters. Descriptions use the existing campaign text contract. `milestone_titles` accepts an array or object with at most 100 string values, each limited to 255 characters. Existing translation rows continue to work through the `locale` to `language` fallback.

## User flow

Creators can add, edit, and delete translations from the campaign page. The public campaign page chooses a matching browser language when one is available, otherwise uses the campaign's current language. Visitors can switch among saved translations. If translation loading fails, campaign content remains visible in its default language with a status message.
