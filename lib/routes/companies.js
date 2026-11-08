// Base de empresas e contatos (leads), independente do funil.
const { query } = require("../db");
const { HttpError } = require("../http");
const { audit } = require("../audit");
const { optText } = require("../validate");
const { cleanCompany, cleanContact, findOrCreateContact } = require("../crm");

function contactDto(c) {
  return {
    id: c.id,
    name: c.name,
    email: c.email,
    phone: c.phone,
    jobTitle: c.job_title,
    linkedinUrl: c.linkedin_url,
    optOut: c.opt_out,
    kind: c.kind,
    sourceUrl: c.source_url,
    source: c.source,
    sourceDetail: c.source_detail,
    createdAt: c.created_at,
  };
}

async function findCompany(user, id) {
  const { rows } = await query(`SELECT * FROM companies WHERE id = $1 AND organization_id = $2`, [id, user.organizationId]);
  if (!rows.length) throw new HttpError(404, "not_found");
  return rows[0];
}

async function list({ user, query: qs }) {
  const params = [user.organizationId];
  let where = `c.organization_id = $1`;
  const q = optText(qs.get("q"), "q", 100);
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    where += ` AND (lower(c.name) LIKE $2 OR coalesce(c.cnpj, '') LIKE $2 OR lower(coalesce(c.city, '')) LIKE $2
               OR lower(coalesce(c.segment, '')) LIKE $2)`;
  }
  const { rows } = await query(
    `SELECT c.id, c.name, c.cnpj, c.segment, c.city, c.uf, c.source, c.source_detail, c.created_at, c.enriched_at, c.registration_status,
            (SELECT count(*)::int FROM contacts ct WHERE ct.company_id = c.id) AS contacts,
            (SELECT count(*)::int FROM deals d WHERE d.company_id = c.id) AS deals
     FROM companies c WHERE ${where} ORDER BY c.created_at DESC LIMIT 1000`,
    params
  );
  return {
    ok: true,
    companies: rows.map((r) => ({
      id: r.id, name: r.name, cnpj: r.cnpj, segment: r.segment, city: r.city, uf: r.uf,
      source: r.source, sourceDetail: r.source_detail, createdAt: r.created_at, contacts: r.contacts, deals: r.deals,
      enrichedAt: r.enriched_at, registrationStatus: r.registration_status,
    })),
  };
}

async function get({ user, params }) {
  const c = await findCompany(user, params.id);
  const [{ rows: contacts }, { rows: deals }] = await Promise.all([
    query(`SELECT * FROM contacts WHERE company_id = $1 ORDER BY (email IS NOT NULL) DESC, (kind = 'person') DESC, name`, [c.id]),
    query(
      `SELECT d.id, d.title, p.name AS pipeline_name, s.name AS stage_name, s.color AS stage_color
       FROM deals d JOIN pipelines p ON p.id = d.pipeline_id JOIN stages s ON s.id = d.stage_id
       WHERE d.company_id = $1 ORDER BY d.created_at DESC`,
      [c.id]
    ),
  ]);
  return {
    ok: true,
    company: {
      id: c.id, name: c.name, cnpj: c.cnpj, website: c.website, segment: c.segment, sector: c.sector, city: c.city, uf: c.uf,
      phone: c.phone, linkedinUrl: c.linkedin_url, notes: c.notes, source: c.source, sourceDetail: c.source_detail,
      createdAt: c.created_at, legalName: c.legal_name, cnaeCode: c.cnae_code, size: c.size,
      registrationStatus: c.registration_status, openedAt: c.opened_at, enrichment: c.enrichment, enrichedAt: c.enriched_at,
      externalIds: c.external_ids, employees: c.employees, priority: c.priority === null ? null : Number(c.priority), lists: c.lists,
      instagramUrl: c.instagram_url, discovery: c.discovery, discoveredAt: c.discovered_at,
    },
    contacts: contacts.map(contactDto),
    deals: deals.map((d) => ({ id: d.id, title: d.title, pipelineName: d.pipeline_name, stageName: d.stage_name, stageColor: d.stage_color })),
  };
}

async function update({ user, params, body, ip }) {
  await findCompany(user, params.id);
  const c = cleanCompany(body);
  if (c.cnpj) {
    const dup = await query(
      `SELECT 1 FROM companies WHERE organization_id = $1 AND cnpj = $2 AND id <> $3`,
      [user.organizationId, c.cnpj, params.id]
    );
    if (dup.rowCount) throw new HttpError(409, "cnpj_in_use");
  }
  await query(
    `UPDATE companies SET name = $2, cnpj = $3, website = $4, segment = $5, city = $6, uf = $7, phone = $8,
            linkedin_url = $9, notes = $10, sector = $11, updated_at = now() WHERE id = $1`,
    [params.id, c.name, c.cnpj, c.website, c.segment, c.city, c.uf, c.phone, c.linkedin_url, c.notes, c.sector]
  );
  await audit({ organizationId: user.organizationId, userId: user.id, action: "company_updated", entity: "company", entityId: params.id, ip });
  return get({ user, params });
}

async function addContact({ user, params, body, ip }) {
  await findCompany(user, params.id);
  const contact = cleanContact(body);
  if (!contact) throw new HttpError(400, "missing_contact_name");
  if (contact.email) {
    const dup = await query(`SELECT 1 FROM contacts WHERE organization_id = $1 AND lower(email) = $2`, [user.organizationId, contact.email]);
    if (dup.rowCount) throw new HttpError(409, "email_in_use");
  }
  const ct = await findOrCreateContact({ query }, user.organizationId, params.id, contact, "manual", null);
  await audit({ organizationId: user.organizationId, userId: user.id, action: "contact_created", entity: "contact", entityId: ct.id, ip });
  return { status: 201, body: { ok: true, id: ct.id } };
}

async function updateContact({ user, params, body, ip }) {
  const { rows } = await query(`SELECT id FROM contacts WHERE id = $1 AND organization_id = $2`, [params.id, user.organizationId]);
  if (!rows.length) throw new HttpError(404, "not_found");
  const contact = cleanContact(body);
  if (!contact) throw new HttpError(400, "missing_contact_name");
  if (contact.email) {
    const dup = await query(
      `SELECT 1 FROM contacts WHERE organization_id = $1 AND lower(email) = $2 AND id <> $3`,
      [user.organizationId, contact.email, params.id]
    );
    if (dup.rowCount) throw new HttpError(409, "email_in_use");
  }
  const optOut = body.optOut === undefined ? null : Boolean(body.optOut);
  await query(
    `UPDATE contacts SET name = $2, email = $3, phone = $4, job_title = $5, linkedin_url = $6,
            opt_out = coalesce($7, opt_out), updated_at = now() WHERE id = $1`,
    [params.id, contact.name, contact.email, contact.phone, contact.job_title, contact.linkedin_url, optOut]
  );
  await audit({
    organizationId: user.organizationId, userId: user.id, action: "contact_updated", entity: "contact", entityId: params.id,
    details: optOut === null ? {} : { optOut }, ip,
  });
  return { ok: true };
}

module.exports = [
  { method: "GET", path: "/companies", handler: list },
  { method: "GET", path: "/companies/:id", handler: get },
  { method: "PATCH", path: "/companies/:id", handler: update },
  { method: "POST", path: "/companies/:id/contacts", handler: addContact },
  { method: "PATCH", path: "/contacts/:id", handler: updateContact },
];
