-- 返信(スレッド回答)にも画像を添付できるようにする。
-- 参加者返信・講師回答の両方で使用。既存行は NULL(画像なし)扱い。
ALTER TABLE answers ADD COLUMN image_key TEXT;
