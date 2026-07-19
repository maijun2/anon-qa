-- 匿名性ルール:
--   * IP アドレス・User-Agent のカラムは一切作成しない
--   * ブラウザトークンは SHA-256 ハッシュ(token_hash)のみ保存する

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  course_name TEXT NOT NULL,
  held_on TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  created_at INTEGER NOT NULL
);

CREATE TABLE questions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  image_key TEXT,
  token_hash TEXT NOT NULL,
  is_answered INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_questions_session ON questions(session_id);

CREATE TABLE answers (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_answers_question ON answers(question_id);

CREATE TABLE votes (
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (question_id, token_hash)
);

CREATE TABLE materials (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  module TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  url TEXT,
  body TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_materials_session ON materials(session_id);

CREATE TABLE surveys (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  is_multi INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'closed')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_surveys_session ON surveys(session_id);

CREATE TABLE survey_options (
  id TEXT PRIMARY KEY,
  survey_id TEXT NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_survey_options_survey ON survey_options(survey_id);

CREATE TABLE survey_responses (
  survey_id TEXT NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  option_id TEXT NOT NULL REFERENCES survey_options(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (survey_id, option_id, token_hash)
);

CREATE TABLE templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE template_materials (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  module TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  url TEXT,
  body TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_template_materials ON template_materials(template_id);

CREATE TABLE template_surveys (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  is_multi INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_template_surveys ON template_surveys(template_id);

CREATE TABLE template_survey_options (
  id TEXT PRIMARY KEY,
  template_survey_id TEXT NOT NULL REFERENCES template_surveys(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_template_survey_options ON template_survey_options(template_survey_id);
