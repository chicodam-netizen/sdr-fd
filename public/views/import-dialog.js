// Importação de leads via CSV: escolher arquivo -> mapear colunas -> importar -> resultado.
import { api, errorMessage, escapeHtml, toast } from "../client.js";
import { openDialog, options } from "../ui.js";
import { readCsvFile, normalizeHeader } from "../csv.js";

// Campos do sistema e nomes de coluna reconhecidos automaticamente.
const FIELDS = [
  { key: "company.name", label: "Empresa *", aliases: ["empresa", "razaosocial", "nomefantasia", "company", "nomedaempresa", "nome"] },
  { key: "company.cnpj", label: "CNPJ", aliases: ["cnpj"] },
  { key: "company.sector", label: "Segmento", aliases: ["segmento", "setor", "divisao", "divisaocnae"] },
  { key: "company.segment", label: "Atividade (CNAE)", aliases: ["atividade", "ramo", "cnae", "industry", "atividadeprincipal"] },
  { key: "company.city", label: "Cidade", aliases: ["cidade", "municipio", "city"] },
  { key: "company.uf", label: "UF", aliases: ["uf", "estado", "state"] },
  { key: "company.website", label: "Site", aliases: ["site", "website", "url", "dominio"] },
  { key: "company.phone", label: "Telefone da empresa", aliases: ["telefoneempresa", "telefonedaempresa", "fone"] },
  { key: "company.linkedinUrl", label: "LinkedIn da empresa", aliases: ["linkedinempresa", "linkedindaempresa", "companylinkedin"] },
  { key: "contact.name", label: "Nome do contato", aliases: ["contato", "nomecontato", "nomedocontato", "responsavel", "firstname", "nomecompleto"] },
  { key: "contact.jobTitle", label: "Cargo", aliases: ["cargo", "funcao", "title", "jobtitle"] },
  { key: "contact.email", label: "E-mail do contato", aliases: ["email", "emaildocontato", "emailcontato"] },
  { key: "contact.phone", label: "Telefone do contato", aliases: ["telefone", "celular", "whatsapp", "telefonecontato", "phone"] },
  { key: "contact.linkedinUrl", label: "LinkedIn do contato", aliases: ["linkedin", "linkedincontato", "perfillinkedin"] },
  { key: "value", label: "Valor estimado", aliases: ["valor", "valorestimado", "value"] },
  { key: "company.notes", label: "Observações", aliases: ["observacoes", "observacao", "obs", "notas", "notes"] },
];

const MAX_ROWS = 2000;

function guessMapping(header) {
  const normalized = header.map(normalizeHeader);
  const used = new Set();
  const mapping = {};
  for (const f of FIELDS) {
    const idx = normalized.findIndex((h, i) => !used.has(i) && f.aliases.includes(h));
    if (idx >= 0) {
      mapping[f.key] = idx;
      used.add(idx);
    }
  }
  return mapping;
}

function buildRows(rows, mapping) {
  return rows.map((r) => {
    const out = { company: {}, contact: {} };
    for (const [key, idx] of Object.entries(mapping)) {
      if (idx === "" || idx === undefined) continue;
      const v = (r[idx] ?? "").trim();
      const [a, b] = key.split(".");
      if (b) out[a][b] = v;
      else out[a] = v;
    }
    return out;
  });
}

export function openImport(pipeline, onDone) {
  const dialog = openDialog(`
    <div class="import">
      <h2>Importar leads (CSV)</h2>
      <p class="muted">Arquivo .csv com cabeçalho na primeira linha, separado por ponto e vírgula ou vírgula (o padrão do Excel funciona). Até ${MAX_ROWS.toLocaleString("pt-BR")} linhas por vez.</p>
      <p class="hint">Registre a origem dos dados: o nome do arquivo fica gravado em cada empresa como fonte (LGPD).</p>
      <label class="file-drop">
        <i data-lucide="file-up"></i>
        <span>Escolher arquivo CSV</span>
        <input type="file" accept=".csv,text/csv" id="csv-file" hidden />
      </label>
      <div id="import-step"></div>
      <div class="dialog-actions"><button type="button" class="btn btn-secondary" data-close>Fechar</button></div>
    </div>`);
  dialog.classList.add("dialog-wide");

  const step = dialog.querySelector("#import-step");

  dialog.querySelector("#csv-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    let parsed;
    try {
      parsed = await readCsvFile(file);
    } catch {
      step.innerHTML = `<p class="form-error">Não foi possível ler o arquivo.</p>`;
      return;
    }
    if (!parsed.header.length || !parsed.rows.length) {
      step.innerHTML = `<p class="form-error">O arquivo está vazio ou sem linhas de dados.</p>`;
      return;
    }
    if (parsed.rows.length > MAX_ROWS) {
      step.innerHTML = `<p class="form-error">O arquivo tem ${parsed.rows.length} linhas. Divida em arquivos de até ${MAX_ROWS}.</p>`;
      return;
    }
    renderMapping(file.name, parsed);
  });

  function renderMapping(fileName, parsed) {
    const mapping = guessMapping(parsed.header);
    const colOpts = (key) =>
      options(parsed.header.map((h, i) => ({ value: String(i), label: escapeHtml(h || `Coluna ${i + 1}`) })), mapping[key] !== undefined ? String(mapping[key]) : "", { empty: "— não importar —" });

    step.innerHTML = `
      <p><strong>${escapeHtml(fileName)}</strong> — ${parsed.rows.length} linha(s). Confira de qual coluna vem cada campo:</p>
      <div class="mapping-grid">
        ${FIELDS.map((f) => `<label>${f.label}<select data-field="${f.key}">${colOpts(f.key)}</select></label>`).join("")}
      </div>
      <label class="inline-label">Etapa de entrada no funil
        <select id="import-stage">${options(pipeline.stages.map((s) => ({ value: s.id, label: escapeHtml(s.name) })), pipeline.stages[0].id)}</select>
      </label>
      <div id="preview"></div>
      <p class="form-error" hidden></p>
      <button class="btn btn-primary" id="do-import"><i data-lucide="upload"></i>Importar ${parsed.rows.length} linha(s)</button>`;

    const readMapping = () => {
      const m = {};
      step.querySelectorAll("[data-field]").forEach((s) => {
        if (s.value !== "") m[s.dataset.field] = Number(s.value);
      });
      return m;
    };

    const renderPreview = () => {
      const m = readMapping();
      const sample = buildRows(parsed.rows.slice(0, 3), m);
      step.querySelector("#preview").innerHTML = `
        <h3 class="form-section">Prévia</h3>
        <div class="panel-flush preview-table"><table class="table">
          <thead><tr><th>Empresa</th><th>CNPJ</th><th>Cidade/UF</th><th>Contato</th><th>E-mail</th></tr></thead>
          <tbody>${sample
            .map(
              (r) => `<tr><td>${escapeHtml(r.company.name || "—")}</td><td>${escapeHtml(r.company.cnpj || "")}</td>
              <td>${escapeHtml([r.company.city, r.company.uf].filter(Boolean).join("/"))}</td>
              <td>${escapeHtml(r.contact.name || "")}</td><td>${escapeHtml(r.contact.email || "")}</td></tr>`
            )
            .join("")}</tbody></table></div>`;
    };
    step.querySelectorAll("[data-field]").forEach((s) => s.addEventListener("change", renderPreview));
    renderPreview();
    window.lucide?.createIcons();

    step.querySelector("#do-import").addEventListener("click", async (e) => {
      const m = readMapping();
      const errorBox = step.querySelector(".form-error");
      if (m["company.name"] === undefined) {
        errorBox.textContent = "Selecione a coluna da Empresa.";
        errorBox.hidden = false;
        return;
      }
      e.target.disabled = true;
      e.target.textContent = "Importando...";
      const { ok, data } = await api("POST", "/import/deals", {
        pipelineId: pipeline.id,
        stageId: step.querySelector("#import-stage").value,
        fileName,
        rows: buildRows(parsed.rows, m),
      });
      if (!ok) {
        e.target.disabled = false;
        e.target.textContent = "Importar";
        errorBox.textContent = errorMessage(data);
        errorBox.hidden = false;
        return;
      }
      renderResult(data);
      onDone?.();
    });
  }

  function renderResult(r) {
    const label = { missing_company_name: "sem nome de empresa", invalid_cnpj: "CNPJ inválido", invalid_email: "e-mail inválido", invalid_value: "valor inválido" };
    dialog.querySelector(".file-drop").hidden = true;
    step.innerHTML = `
      <div class="import-result">
        <div class="kpi"><div class="kpi-value">${r.created}</div><div class="kpi-label">cards criados</div></div>
        <div class="kpi"><div class="kpi-value">${r.alreadyInPipeline}</div><div class="kpi-label">já estavam no funil</div></div>
        <div class="kpi"><div class="kpi-value">${r.errors.length}</div><div class="kpi-label">linhas com erro</div></div>
      </div>
      <p class="muted">${r.companiesCreated} empresa(s) e ${r.contactsCreated} contato(s) novos na base.</p>
      ${
        r.errors.length
          ? `<details><summary>Ver linhas com erro</summary><ul class="error-list">${r.errors
              .slice(0, 200)
              .map((e) => `<li>Linha ${e.line + 1}: ${escapeHtml(label[e.error] || e.error)}</li>`)
              .join("")}</ul></details>`
          : ""
      }`;
    toast(`Importação concluída: ${r.created} card(s) criados.`, "success");
  }
}
