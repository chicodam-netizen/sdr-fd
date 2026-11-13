-- Cadência mista (e-mail + LinkedIn). Somente colunas novas, sem DROP.
-- Passos de LinkedIn são tarefas manuais: a IA escreve o texto, uma pessoa envia pelo LinkedIn e marca como feito.

-- Canal de cada passo da cadência.
ALTER TABLE cadence_steps
  ADD COLUMN channel text NOT NULL DEFAULT 'email'
  CHECK (channel IN ('email', 'linkedin_connect', 'linkedin_message'));

-- Canal de cada mensagem (enviada ou recebida).
ALTER TABLE messages
  ADD COLUMN channel text NOT NULL DEFAULT 'email'
  CHECK (channel IN ('email', 'linkedin'));

CREATE INDEX messages_linkedin_tasks_idx ON messages (organization_id, created_at) WHERE channel = 'linkedin' AND status = 'draft';
