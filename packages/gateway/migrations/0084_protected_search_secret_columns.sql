-- Rebuild search configuration so protected-value columns are named for
-- their ciphertext-at-rest contract. Personal migration opens and reseals
-- values in memory through the checked-in protected migration plan; this SQL
-- only copies ciphertext between persistent tables.

CREATE TABLE search_config_protected (
  id                                      INTEGER PRIMARY KEY CHECK (id = 1),
  provider                                TEXT NOT NULL,
  protected_tavily_api_key                TEXT NOT NULL DEFAULT '',
  protected_microsoft_web_iq_api_key       TEXT NOT NULL DEFAULT '',
  protected_jina_api_key                  TEXT NOT NULL DEFAULT '',
  passthrough_openai_search               INTEGER NOT NULL DEFAULT 0 CHECK (passthrough_openai_search IN (0, 1)),
  alpha_search_upstream_id                TEXT NOT NULL DEFAULT '',
  alpha_search_model                      TEXT NOT NULL DEFAULT '',
  updated_at                              TEXT NOT NULL
);

INSERT INTO search_config_protected (
  id,
  provider,
  protected_tavily_api_key,
  protected_microsoft_web_iq_api_key,
  protected_jina_api_key,
  passthrough_openai_search,
  alpha_search_upstream_id,
  alpha_search_model,
  updated_at
)
SELECT
  id,
  provider,
  tavily_api_key,
  microsoft_web_iq_api_key,
  jina_api_key,
  passthrough_openai_search,
  alpha_search_upstream_id,
  alpha_search_model,
  updated_at
FROM search_config;

DROP TABLE search_config;
ALTER TABLE search_config_protected RENAME TO search_config;
