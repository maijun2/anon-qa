-- 回答スレッド化: answers を講師専用から参加者も投稿できるスレッドに拡張する。
-- 既存行は DEFAULT により講師回答として扱われる。
ALTER TABLE answers ADD COLUMN author_role TEXT NOT NULL DEFAULT 'instructor'
  CHECK (author_role IN ('instructor', 'participant'));
-- 参加者返信の本人判定用(匿名トークンの SHA-256 ハッシュのみ)。講師回答は NULL
ALTER TABLE answers ADD COLUMN token_hash TEXT;
-- 既存行は NULL(created_at 扱い)
ALTER TABLE answers ADD COLUMN updated_at INTEGER;
