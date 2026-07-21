-- Migração inicial: o documento de review inteiro (JSON) vive em UMA linha,
-- byte-idêntico ao blob do KV. kv_key preserva a chave EXATA do KV
-- ('review:<id>') para espelhamento 1:1 sem qualquer ambiguidade.
CREATE TABLE IF NOT EXISTS reviews (
  kv_key     TEXT PRIMARY KEY,
  doc        TEXT NOT NULL,
  updated_at TEXT,
  source     TEXT NOT NULL,
  written_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reviews_updated_at ON reviews(updated_at);
