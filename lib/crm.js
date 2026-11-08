// Regras compartilhadas de empresas/contatos/negócios (usadas pelo cadastro manual e pela importação).
const { optText, reqText, optEmail, optCnpj, optUf } = require("./validate");

function cleanCompany(input) {
  return {
    name: reqText(input.name, "company_name", 200),
    cnpj: optCnpj(input.cnpj),
    website: optText(input.website, "website", 300),
    segment: optText(input.segment, "segment", 120),
    sector: optText(input.sector, "sector", 120),
    city: optText(input.city, "city", 120),
    uf: optUf(input.uf),
    phone: optText(input.phone, "phone", 40),
    linkedin_url: optText(input.linkedinUrl, "linkedin_url", 300),
    notes: optText(input.notes, "notes", 5000),
  };
}

// Contato é opcional: só existe se tiver nome ou e-mail.
function cleanContact(input) {
  if (!input) return null;
  const email = optEmail(input.email);
  const name = optText(input.name, "contact_name", 200);
  if (!name && !email) return null;
  return {
    name: name || email,
    email,
    phone: optText(input.phone, "contact_phone", 40),
    job_title: optText(input.jobTitle, "job_title", 120),
    linkedin_url: optText(input.linkedinUrl, "contact_linkedin_url", 300),
  };
}

// Reaproveita empresa existente por CNPJ ou, sem CNPJ, por nome exato (sem diferenciar maiúsculas).
async function findOrCreateCompany(db, orgId, userId, company, source, sourceDetail) {
  const existing = company.cnpj
    ? await db.query(`SELECT id FROM companies WHERE organization_id = $1 AND cnpj = $2`, [orgId, company.cnpj])
    : await db.query(
        `SELECT id FROM companies WHERE organization_id = $1 AND lower(name) = lower($2) AND cnpj IS NULL LIMIT 1`,
        [orgId, company.name]
      );
  if (existing.rows.length) return { id: existing.rows[0].id, created: false };

  const { rows } = await db.query(
    `INSERT INTO companies (organization_id, name, cnpj, website, segment, city, uf, phone, linkedin_url, notes, source, source_detail, created_by, sector)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
    [orgId, company.name, company.cnpj, company.website, company.segment, company.city, company.uf, company.phone,
      company.linkedin_url, company.notes, source, sourceDetail, userId, company.sector || null]
  );
  return { id: rows[0].id, created: true };
}

// Contato por e-mail (único na organização); sem e-mail, por nome dentro da empresa.
async function findOrCreateContact(db, orgId, companyId, contact, source, sourceDetail) {
  if (!contact) return null;
  const existing = contact.email
    ? await db.query(`SELECT id FROM contacts WHERE organization_id = $1 AND lower(email) = $2`, [orgId, contact.email])
    : await db.query(
        `SELECT id FROM contacts WHERE company_id = $1 AND lower(name) = lower($2) LIMIT 1`,
        [companyId, contact.name]
      );
  if (existing.rows.length) return { id: existing.rows[0].id, created: false };

  const { rows } = await db.query(
    `INSERT INTO contacts (organization_id, company_id, name, email, phone, job_title, linkedin_url, source, source_detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [orgId, companyId, contact.name, contact.email, contact.phone, contact.job_title, contact.linkedin_url, source, sourceDetail]
  );
  return { id: rows[0].id, created: true };
}

// Posição no fim da etapa (cards novos entram embaixo).
async function nextPosition(db, stageId) {
  const { rows } = await db.query(`SELECT coalesce(max(position), 0) + 1024 AS p FROM deals WHERE stage_id = $1`, [stageId]);
  return rows[0].p;
}

async function logActivity(db, { orgId, dealId = null, companyId = null, userId = null, type, body = null, meta = {} }) {
  await db.query(
    `INSERT INTO activities (organization_id, deal_id, company_id, user_id, type, body, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [orgId, dealId, companyId, userId, type, body, meta]
  );
}

module.exports = { cleanCompany, cleanContact, findOrCreateCompany, findOrCreateContact, nextPosition, logActivity };
